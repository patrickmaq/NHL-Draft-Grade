export default async function handler(req, res) {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'Team abbreviation required' });

  const SEASON = '20252026';
  const GAME_TYPE = '2'; // regular season
  const MIN_GAMES = 15; // filter out AHL callups

  try {
    // Fetch club stats — includes TOI, games played, position for every player
    const statsUrl = `https://api-web.nhle.com/v1/club-stats/${team}/${SEASON}/${GAME_TYPE}`;
    const statsRes = await fetch(statsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nhl.com/'
      }
    });

    if (!statsRes.ok) {
      return res.status(statsRes.status).json({ 
        error: `NHL API returned ${statsRes.status}`,
        url: statsUrl 
      });
    }

    const statsData = await statsRes.json();

    // Parse skaters
    const skaters = (statsData.skaters || []);
    const goalies = (statsData.goalies || []);

    // Filter by minimum games played and build name
    const getName = (p) => `${p.firstName.default} ${p.lastName.default}`;
    const getToiSeconds = (toiStr) => {
      if (!toiStr) return 0;
      const parts = toiStr.split(':');
      return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
    };

    // Separate by position
    const centres = skaters
      .filter(p => p.positionCode === 'C' && p.gamesPlayed >= MIN_GAMES)
      .sort((a, b) => getToiSeconds(b.avgToi) - getToiSeconds(a.avgToi))
      .slice(0, 4)
      .map(getName);

    const leftWings = skaters
      .filter(p => p.positionCode === 'L' && p.gamesPlayed >= MIN_GAMES)
      .sort((a, b) => getToiSeconds(b.avgToi) - getToiSeconds(a.avgToi))
      .slice(0, 4)
      .map(getName);

    const rightWings = skaters
      .filter(p => p.positionCode === 'R' && p.gamesPlayed >= MIN_GAMES)
      .sort((a, b) => getToiSeconds(b.avgToi) - getToiSeconds(a.avgToi))
      .slice(0, 4)
      .map(getName);

    // Defensemen — split by shoots (L = LD, R = RD)
    const defencemen = skaters
      .filter(p => p.positionCode === 'D' && p.gamesPlayed >= MIN_GAMES)
      .sort((a, b) => getToiSeconds(b.avgToi) - getToiSeconds(a.avgToi));

    const leftDef = defencemen
      .filter(p => p.shootsCatches === 'L')
      .slice(0, 3)
      .map(getName);

    const rightDef = defencemen
      .filter(p => p.shootsCatches === 'R')
      .slice(0, 3)
      .map(getName);

    // Goalies — sort by games started
    const goalieList = goalies
      .filter(p => p.gamesStarted >= 5)
      .sort((a, b) => b.gamesStarted - a.gamesStarted)
      .slice(0, 2)
      .map(getName);

    // Build response in format the frontend expects
    const roster = {
      C: centres,
      LW: leftWings,
      RW: rightWings,
      LD: leftDef,
      RD: rightDef,
      G: goalieList,
      // Also pass raw for debugging
      _meta: {
        team,
        season: SEASON,
        minGames: MIN_GAMES,
        totalSkaters: skaters.length,
        filteredSkaters: skaters.filter(p => p.gamesPlayed >= MIN_GAMES).length
      }
    };

    // Cache for 6 hours — roster doesn't change that often
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ 
      error: e.message,
      stack: e.stack 
    });
  }
}
