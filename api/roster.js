export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'Team abbreviation required' });

  const SEASON = '20252026';
  const MIN_GAMES = 3;

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

    // Build lookup: player ID -> shoot hand + registered position
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

    const toiToSeconds = (toi) => {
      if (!toi) return 0;
      const [m, s] = toi.split(':').map(Number);
      return (m || 0) * 60 + (s || 0);
    };

    const getName = (p) => `${p.firstName.default} ${p.lastName.default}`;

    // Merge stats with position/handedness
    const skaters = (statsData.skaters || [])
      .filter(p => p.gamesPlayed >= MIN_GAMES)
      .map(p => ({
        ...p,
        name: getName(p),
        toiSeconds: toiToSeconds(p.avgToi),
        posCode: posMap[p.playerId] || p.positionCode,
        shoots: handMap[p.playerId] || 'L',
        points: (p.goals || 0) + (p.assists || 0)
      }));

    // Sort forwards by points desc, TOI as tiebreaker
    const sortForwards = (arr) => arr.sort((a, b) =>
      b.points !== a.points ? b.points - a.points : b.toiSeconds - a.toiSeconds
    );

    // Sort defence by TOI desc
    const sortDefence = (arr) => arr.sort((a, b) => b.toiSeconds - a.toiSeconds);

    // Get forwards by registered position, sorted by points
    const allForwards = sortForwards([...skaters.filter(p => ['C','L','R'].includes(p.posCode))]);
    
    // Fill lines greedily — place each forward into their registered position first
    // If that slot is full (4 slots per position), place into best available adjacent slot
    const centres    = [];
    const leftWings  = [];
    const rightWings = [];
    const overflow   = []; // players whose primary slot is full

    // First pass — fill registered positions up to 4 each
    for (const p of allForwards) {
      if (p.posCode === 'C' && centres.length < 4)        centres.push(p.name);
      else if (p.posCode === 'L' && leftWings.length < 4)  leftWings.push(p.name);
      else if (p.posCode === 'R' && rightWings.length < 4) rightWings.push(p.name);
      else overflow.push(p);
    }

    // Second pass — fill open wing slots with overflow forwards (by points)
    for (const p of overflow) {
      if (leftWings.length < 4)       leftWings.push(p.name);
      else if (rightWings.length < 4) rightWings.push(p.name);
      else if (centres.length < 4)    centres.push(p.name);
    }

    // Defence split by shoot hand, sorted by TOI
    const dmen      = sortDefence(skaters.filter(p => p.posCode === 'D'));
    const leftDef   = dmen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef  = dmen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    // If one side is short, fill from the other side's overflow
    const dmenOverflow = dmen.filter(p =>
      (p.shoots === 'L' && leftDef.length >= 3) ||
      (p.shoots === 'R' && rightDef.length >= 3)
    ).map(p => p.name);

    while (leftDef.length < 3 && dmenOverflow.length)  leftDef.push(dmenOverflow.shift());
    while (rightDef.length < 3 && dmenOverflow.length) rightDef.push(dmenOverflow.shift());

    // Goalies by games started
    const goalieList = (statsData.goalies || [])
      .filter(p => p.gamesStarted >= 1)
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
        team, season: SEASON, minGames: MIN_GAMES,
        totalSkaters: (statsData.skaters || []).length,
        filtered: skaters.length,
        centres: centres.length,
        leftWings: leftWings.length,
        rightWings: rightWings.length,
        leftDef: leftDef.length,
        rightDef: rightDef.length,
        overflowForwards: overflow.length
      }
    };

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
