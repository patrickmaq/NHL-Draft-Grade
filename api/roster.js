export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'Team abbreviation required' });

  const SEASON = '20252026';
  const MIN_GAMES = 15;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nhl.com/'
  };

  try {
    // Fetch both endpoints in parallel
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

    // Build lookup from player ID to shoot hand and position from roster endpoint
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

    // Convert MM:SS avgToi string to seconds for sorting
    const toiToSeconds = (toi) => {
      if (!toi) return 0;
      const [m, s] = toi.split(':').map(Number);
      return (m || 0) * 60 + (s || 0);
    };

    const getName = (p) => `${p.firstName.default} ${p.lastName.default}`;

    // Merge stats with handedness/position from roster
    const skaters = (statsData.skaters || [])
      .filter(p => p.gamesPlayed >= MIN_GAMES)
      .map(p => ({
        ...p,
        name: getName(p),
        toiSeconds: toiToSeconds(p.avgToi),
        posCode: posMap[p.playerId] || p.positionCode,
        shoots: handMap[p.playerId] || 'L'
      }));

    // Sort each position group by TOI descending
    const byPos = (pos) => skaters
      .filter(p => p.posCode === pos)
      .sort((a, b) => b.toiSeconds - a.toiSeconds);

    const centres    = byPos('C').slice(0, 4).map(p => p.name);
    const leftWings  = byPos('L').slice(0, 4).map(p => p.name);
    const rightWings = byPos('R').slice(0, 4).map(p => p.name);

    // Defence split by shoot hand
    const dmen = skaters
      .filter(p => p.posCode === 'D')
      .sort((a, b) => b.toiSeconds - a.toiSeconds);

    const leftDef  = dmen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef = dmen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    // Goalies sorted by games started
    const goalieList = (statsData.goalies || [])
      .filter(p => p.gamesStarted >= 5)
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
        minGames: MIN_GAMES,
        totalSkaters: (statsData.skaters || []).length,
        filtered: skaters.length,
        dmenTotal: dmen.length,
        leftDef: leftDef.length,
        rightDef: rightDef.length
      }
    };

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
