export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'Team abbreviation required' });

  const SEASON = '20252026';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nhl.com/'
  };

  try {
    // Use two endpoints in parallel:
    // 1. Roster — for position, handedness, and roster order
    // 2. Stats — for goals+assists to sort within position groups
    const [rosterRes, statsRes] = await Promise.all([
      fetch(`https://api-web.nhle.com/v1/roster/${team}/${SEASON}`, { headers }),
      fetch(`https://api-web.nhle.com/v1/club-stats/${team}/${SEASON}/2`, { headers })
    ]);

    if (!rosterRes.ok) return res.status(rosterRes.status).json({ error: `Roster API ${rosterRes.status}` });
    if (!statsRes.ok) return res.status(statsRes.status).json({ error: `Stats API ${statsRes.status}` });

    const [rosterData, statsData] = await Promise.all([
      rosterRes.json(),
      statsRes.json()
    ]);

    const getName = (p) => {
      const first = p.firstName?.default || p.firstName || '';
      const last = p.lastName?.default || p.lastName || '';
      return `${first} ${last}`.trim();
    };

    // Build points lookup from stats endpoint by player ID
    const pointsById = {};
    const gpById = {};
    const goalsById = {};
    (statsData.skaters || []).forEach(p => {
      const id = p.playerId || p.id;
      pointsById[id] = (p.goals || 0) + (p.assists || 0);
      goalsById[id] = p.goals || 0;
      gpById[id] = p.gamesPlayed || 0;
    });

    // Also build by name as fallback
    const pointsByName = {};
    const gpByName = {};
    (statsData.skaters || []).forEach(p => {
      const name = getName(p);
      pointsByName[name] = (p.goals || 0) + (p.assists || 0);
      gpByName[name] = p.gamesPlayed || 0;
    });

    // Process roster — use ROSTER as source of truth for position/hand
    // Sort each group by points (from stats), falling back to roster order
    const processGroup = (players, posCode) => {
      return players.map(p => {
        const name = getName(p);
        const id = p.id;
        const pts = pointsById[id] ?? pointsByName[name] ?? 0;
        const gp = gpById[id] ?? gpByName[name] ?? 0;
        return {
          name,
          id,
          pos: posCode || p.positionCode,
          shoots: p.shootsCatches || 'L',
          pts,
          gp,
          rosterIdx: players.indexOf(p) // preserve roster order as tiebreaker
        };
      }).sort((a, b) =>
        // Sort by pts desc, then gp desc, then roster order
        b.pts !== a.pts ? b.pts - a.pts :
        b.gp !== a.gp ? b.gp - a.gp :
        a.rosterIdx - b.rosterIdx
      );
    };

    const forwards  = processGroup(rosterData.forwards || [], null);
    const defencemen = processGroup(rosterData.defensemen || [], 'D');
    const goalieList = (rosterData.goalies || [])
      .map(p => {
        const name = getName(p);
        const id = p.id;
        // Sort goalies by games started from stats
        const gs = (statsData.goalies || []).find(g => (g.playerId || g.id) === id || getName(g) === name);
        return { name, gamesStarted: gs?.gamesStarted || 0 };
      })
      .sort((a, b) => b.gamesStarted - a.gamesStarted)
      .slice(0, 2)
      .map(p => p.name);

    // Fill forward lines by position — C, LW (L), RW (R)
    const centres   = [];
    const lw        = [];
    const rw        = [];
    const overflow  = [];

    for (const p of forwards) {
      const pos = p.pos;
      if      (pos === 'C' && centres.length < 4) centres.push(p.name);
      else if (pos === 'L' && lw.length < 4)      lw.push(p.name);
      else if (pos === 'R' && rw.length < 4)      rw.push(p.name);
      else overflow.push(p);
    }
    // Fill open spots with overflow (sorted by pts)
    for (const p of overflow) {
      if      (lw.length < 4)      lw.push(p.name);
      else if (rw.length < 4)      rw.push(p.name);
      else if (centres.length < 4) centres.push(p.name);
    }

    // Defence — split by shoot hand, sorted by pts/gp
    const leftDef  = defencemen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef = defencemen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    // Fill gaps
    const usedD = new Set([...leftDef, ...rightDef]);
    const dOver = defencemen.filter(p => !usedD.has(p.name));
    while (leftDef.length < 3 && dOver.length)  leftDef.push(dOver.shift().name);
    while (rightDef.length < 3 && dOver.length) rightDef.push(dOver.shift().name);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json({
      C: centres, LW: lw, RW: rw,
      LD: leftDef, RD: rightDef, G: goalieList,
      _meta: {
        team, season: SEASON,
        rosterForwards: (rosterData.forwards||[]).length,
        rosterDmen: (rosterData.defensemen||[]).length,
        statsSkaters: (statsData.skaters||[]).length,
        topForwards: forwards.slice(0,5).map(p=>({name:p.name,pos:p.pos,pts:p.pts,gp:p.gp})),
        topDmen: defencemen.slice(0,6).map(p=>({name:p.name,shoots:p.shoots,pts:p.pts,gp:p.gp}))
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
