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

    // Build lookup: player ID -> shoot hand + registered position from roster endpoint
    const handMap = {};
    const posMap = {};

    (rosterData.forwards || []).forEach(p => {
      handMap[p.id] = p.shootsCatches;
      posMap[p.id] = p.positionCode; // C, L, R
    });
    (rosterData.defensemen || []).forEach(p => {
      handMap[p.id] = p.shootsCatches;
      posMap[p.id] = 'D';
    });
    (rosterData.goalies || []).forEach(p => {
      posMap[p.id] = 'G';
    });

    // Convert MM:SS avgToi to seconds
    const toiToSeconds = (toi) => {
      if (!toi) return 0;
      const [m, s] = toi.split(':').map(Number);
      return (m || 0) * 60 + (s || 0);
    };

    const getName = (p) => `${p.firstName.default} ${p.lastName.default}`;

    // NO minimum games filter — use TOI as the truth
    // High TOI = real roster player, low TOI = callup/depth
    // Minimum TOI threshold: 2 minutes average (filters out emergency callups only)
    const MIN_TOI_SECONDS = 120; // 2 minutes average TOI

    const skaters = (statsData.skaters || [])
      .map(p => ({
        ...p,
        name: getName(p),
        toiSeconds: toiToSeconds(p.avgToi),
        posCode: posMap[p.playerId] || p.positionCode,
        shoots: handMap[p.playerId] || 'L',
        points: (p.goals || 0) + (p.assists || 0)
      }))
      .filter(p => p.toiSeconds >= MIN_TOI_SECONDS); // only filter obvious non-contributors

    // Sort forwards by points desc, TOI as tiebreaker
    const sortForwards = (arr) => arr.sort((a, b) =>
      b.points !== a.points ? b.points - a.points : b.toiSeconds - a.toiSeconds
    );

    // Sort defence purely by TOI desc — most reliable metric
    const sortDefence = (arr) => arr.sort((a, b) => b.toiSeconds - a.toiSeconds);

    // Fill forward lines — primary position first, overflow fills open spots
    const allForwards = sortForwards([...skaters.filter(p => ['C','L','R'].includes(p.posCode))]);

    const centres    = [];
    const leftWings  = [];
    const rightWings = [];
    const overflow   = [];

    for (const p of allForwards) {
      if      (p.posCode === 'C' && centres.length < 4)    centres.push(p.name);
      else if (p.posCode === 'L' && leftWings.length < 4)  leftWings.push(p.name);
      else if (p.posCode === 'R' && rightWings.length < 4) rightWings.push(p.name);
      else overflow.push(p);
    }

    // Fill empty slots with overflow (by points)
    for (const p of overflow) {
      if      (leftWings.length < 4)  leftWings.push(p.name);
      else if (rightWings.length < 4) rightWings.push(p.name);
      else if (centres.length < 4)    centres.push(p.name);
    }

    // Defence — split by shoot hand, sort by TOI
    const dmen = sortDefence(skaters.filter(p => p.posCode === 'D'));
    const leftDef  = dmen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef = dmen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    // If one side short, pull from overall TOI sorted dmen overflow
    const usedNames = new Set([...leftDef, ...rightDef]);
    const dOverflow = dmen.filter(p => !usedNames.has(p.name)).map(p => p.name);
    while (leftDef.length < 3 && dOverflow.length)  leftDef.push(dOverflow.shift());
    while (rightDef.length < 3 && dOverflow.length) rightDef.push(dOverflow.shift());

    // Goalies by games started — no minimum
    const goalieList = (statsData.goalies || [])
      .sort((a, b) => b.gamesStarted - a.gamesStarted)
      .slice(0, 2)
      .map(getName);

    const roster = {
      C:  centres,
      LW: leftWings,
      RW: rightWings,
      LD: leftDef,
      RD: rightDef,
      G:  goalieList,
      _meta: {
        team,
        season: SEASON,
        minToi: MIN_TOI_SECONDS,
        totalSkaters: (statsData.skaters || []).length,
        filtered: skaters.length,
        centres: centres.length,
        leftWings: leftWings.length,
        rightWings: rightWings.length,
        leftDef: leftDef.length,
        rightDef: rightDef.length,
        overflow: overflow.length
      }
    };

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
