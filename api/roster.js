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

    // Debug: capture first player from each endpoint to see field names
    const firstRosterF = (rosterData.forwards || [])[0] || {};
    const firstStatsS = (statsData.skaters || [])[0] || {};

    // Build lookup using ALL possible ID field names from roster endpoint
    const handMap = {};
    const posMap = {};

    const addToMaps = (players, pos) => {
      players.forEach(p => {
        // Try all possible ID fields
        const ids = [p.id, p.playerId, p.player_id, p.personId].filter(Boolean);
        ids.forEach(id => {
          handMap[id] = p.shootsCatches;
          posMap[id] = pos;
        });
        // Also index by name as fallback
        const name = `${p.firstName?.default || p.firstName} ${p.lastName?.default || p.lastName}`;
        handMap[`name_${name}`] = p.shootsCatches;
        posMap[`name_${name}`] = pos;
      });
    };

    addToMaps(rosterData.forwards || [], null); // pos set per player below
    (rosterData.forwards || []).forEach(p => {
      const ids = [p.id, p.playerId, p.player_id, p.personId].filter(Boolean);
      ids.forEach(id => { posMap[id] = p.positionCode; }); // C, L, R
      const name = `${p.firstName?.default || p.firstName} ${p.lastName?.default || p.lastName}`;
      posMap[`name_${name}`] = p.positionCode;
    });
    (rosterData.defensemen || []).forEach(p => {
      const ids = [p.id, p.playerId, p.player_id, p.personId].filter(Boolean);
      ids.forEach(id => { handMap[id] = p.shootsCatches; posMap[id] = 'D'; });
      const name = `${p.firstName?.default || p.firstName} ${p.lastName?.default || p.lastName}`;
      handMap[`name_${name}`] = p.shootsCatches;
      posMap[`name_${name}`] = 'D';
    });
    (rosterData.goalies || []).forEach(p => {
      const ids = [p.id, p.playerId, p.player_id, p.personId].filter(Boolean);
      ids.forEach(id => { posMap[id] = 'G'; });
    });

    const toiToSeconds = (toi) => {
      if (!toi) return 0;
      const parts = String(toi).split(':');
      return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    };

    const getName = (p) => {
      const first = p.firstName?.default || p.firstName || '';
      const last = p.lastName?.default || p.lastName || '';
      return `${first} ${last}`.trim();
    };

    // Process skaters — try multiple ID fields + name fallback
    const skaters = (statsData.skaters || [])
      .map(p => {
        const name = getName(p);
        const nameKey = `name_${name}`;
        // Try all ID fields
        const id = p.playerId || p.id || p.player_id || p.personId;
        
        // Get position and handedness — try ID first, name as fallback
        let posCode = posMap[id] || posMap[nameKey] || p.positionCode;
        let shoots = handMap[id] || handMap[nameKey] || 'L';
        
        // Normalize position codes (some APIs use 'L'/'R' others 'LW'/'RW')
        if (posCode === 'LW') posCode = 'L';
        if (posCode === 'RW') posCode = 'R';

        return {
          ...p,
          name,
          toiSeconds: toiToSeconds(p.avgToi),
          posCode,
          shoots,
          points: (p.goals || 0) + (p.assists || 0)
        };
      })
      .filter(p => p.toiSeconds >= 60); // at least 1 min avg TOI

    // Sort forwards by points, then TOI
    const sortF = (arr) => arr.sort((a, b) =>
      b.points !== a.points ? b.points - a.points : b.toiSeconds - a.toiSeconds
    );

    // Sort D by TOI
    const sortD = (arr) => arr.sort((a, b) => b.toiSeconds - a.toiSeconds);

    const allForwards = sortF(skaters.filter(p => ['C','L','R'].includes(p.posCode)));
    const centres = [], leftWings = [], rightWings = [], overflow = [];

    for (const p of allForwards) {
      if      (p.posCode === 'C' && centres.length < 4)    centres.push(p.name);
      else if (p.posCode === 'L' && leftWings.length < 4)  leftWings.push(p.name);
      else if (p.posCode === 'R' && rightWings.length < 4) rightWings.push(p.name);
      else overflow.push(p);
    }
    for (const p of overflow) {
      if      (leftWings.length < 4)  leftWings.push(p.name);
      else if (rightWings.length < 4) rightWings.push(p.name);
      else if (centres.length < 4)    centres.push(p.name);
    }

    const dmen = sortD(skaters.filter(p => p.posCode === 'D'));
    const leftDef  = dmen.filter(p => p.shoots === 'L').slice(0, 3).map(p => p.name);
    const rightDef = dmen.filter(p => p.shoots === 'R').slice(0, 3).map(p => p.name);

    const usedD = new Set([...leftDef, ...rightDef]);
    const dOverflow = dmen.filter(p => !usedD.has(p.name)).map(p => p.name);
    while (leftDef.length < 3 && dOverflow.length)  leftDef.push(dOverflow.shift());
    while (rightDef.length < 3 && dOverflow.length) rightDef.push(dOverflow.shift());

    const goalieList = (statsData.goalies || [])
      .sort((a, b) => b.gamesStarted - a.gamesStarted)
      .slice(0, 2)
      .map(getName);

    const roster = {
      C: centres, LW: leftWings, RW: rightWings,
      LD: leftDef, RD: rightDef, G: goalieList,
      _meta: {
        team, season: SEASON,
        rosterForwardCount: (rosterData.forwards||[]).length,
        statsSkaterCount: (statsData.skaters||[]).length,
        filteredSkaters: skaters.length,
        rosterFirstPlayerIdFields: Object.keys(firstRosterF).filter(k => k.toLowerCase().includes('id')),
        statsFirstPlayerIdFields: Object.keys(firstStatsS).filter(k => k.toLowerCase().includes('id')),
        centres: centres.length, leftWings: leftWings.length,
        rightWings: rightWings.length, leftDef: leftDef.length, rightDef: rightDef.length
      }
    };

    res.setHeader('Cache-Control', 'no-store'); // no cache while debugging
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
