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

    // Build name-based position and handedness maps from roster
    const shootsByName = {};
    const posByName = {};

    (rosterData.forwards || []).forEach(p => {
      const name = getName(p);
      shootsByName[name] = p.shootsCatches || 'L';
      posByName[name] = p.positionCode; // C, L, or R
    });
    (rosterData.defensemen || []).forEach(p => {
      const name = getName(p);
      shootsByName[name] = p.shootsCatches || 'L';
      posByName[name] = 'D';
    });
    (rosterData.goalies || []).forEach(p => {
      posByName[getName(p)] = 'G';
    });

    // Process all skaters — sort by points + games played (no TOI, it returns 0)
    const allSkaters = (statsData.skaters || []).map(p => {
      const name = getName(p);
      let pos = posByName[name] || p.positionCode || '';
      if (pos === 'LW') pos = 'L';
      if (pos === 'RW') pos = 'R';

      return {
        name,
        pos,
        shoots: shootsByName[name] || 'L',
        points: (p.goals || 0) + (p.assists || 0),
        goals: p.goals || 0,
        gamesPlayed: p.gamesPlayed || 0
      };
    });

    // Sort by points desc, then goals, then games played
    const sortByProduction = (arr) => arr.sort((a, b) =>
      b.points !== a.points ? b.points - a.points :
      b.goals !== a.goals ? b.goals - a.goals :
      b.gamesPlayed - a.gamesPlayed
    );

    // Sort defence by games played (most games = most important player)
    const sortDefence = (arr) => arr.sort((a, b) =>
      b.gamesPlayed !== a.gamesPlayed ? b.gamesPlayed - a.gamesPlayed :
      b.points - a.points
    );

    // Fill forward lines
    const forwards = sortByProduction(allSkaters.filter(p => ['C','L','R'].includes(p.pos)));
    const centres = [], lw = [], rw = [], overflow = [];

    for (const p of forwards) {
      if      (p.pos === 'C' && centres.length < 4) centres.push(p.name);
      else if (p.pos === 'L' && lw.length < 4)      lw.push(p.name);
      else if (p.pos === 'R' && rw.length < 4)      rw.push(p.name);
      else overflow.push(p);
    }
    // Fill open slots with overflow
    for (const p of overflow) {
      if      (lw.length < 4)      lw.push(p.name);
      else if (rw.length < 4)      rw.push(p.name);
      else if (centres.length < 4) centres.push(p.name);
    }

    // Fill defence — sort by games played
    const dmen = sortDefence(allSkaters.filter(p => p.pos === 'D'));
    const leftDef  = dmen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef = dmen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    // Fill gaps from overflow D
    const usedD = new Set([...leftDef, ...rightDef]);
    const dOver = dmen.filter(p => !usedD.has(p.name));
    while (leftDef.length < 3 && dOver.length)  leftDef.push(dOver.shift().name);
    while (rightDef.length < 3 && dOver.length) rightDef.push(dOver.shift().name);

    const goalies = (statsData.goalies || [])
      .sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))
      .slice(0, 2).map(getName);

    // Re-enable caching now that it's working
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json({
      C: centres, LW: lw, RW: rw,
      LD: leftDef, RD: rightDef, G: goalies,
      _meta: {
        team, season: SEASON,
        totalForwards: forwards.length,
        totalDmen: dmen.length,
        topForwards: allSkaters
          .filter(p => ['C','L','R'].includes(p.pos))
          .sort((a,b) => b.points - a.points)
          .slice(0, 5)
          .map(p => ({ name: p.name, pos: p.pos, pts: p.points, gp: p.gamesPlayed })),
        topDmen: dmen.slice(0, 6).map(p => ({ name: p.name, shoots: p.shoots, gp: p.gamesPlayed, pts: p.points }))
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
