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

    // Roster uses 'id', stats uses 'playerId' - confirmed from meta
    // Build maps keyed on roster 'id'
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

    // Also build name-based fallback map
    const handByName = {};
    const posByName = {};
    (rosterData.forwards || []).forEach(p => {
      const name = `${p.firstName.default} ${p.lastName.default}`;
      handByName[name] = p.shootsCatches;
      posByName[name] = p.positionCode;
    });
    (rosterData.defensemen || []).forEach(p => {
      const name = `${p.firstName.default} ${p.lastName.default}`;
      handByName[name] = p.shootsCatches;
      posByName[name] = 'D';
    });

    const getName = (p) => {
      const first = p.firstName?.default || p.firstName || '';
      const last = p.lastName?.default || p.lastName || '';
      return `${first} ${last}`.trim();
    };

    // Inspect first skater to find TOI field name
    const firstSkater = (statsData.skaters || [])[0] || {};
    const toiFields = Object.keys(firstSkater).filter(k => 
      k.toLowerCase().includes('toi') || k.toLowerCase().includes('time')
    );

    // Find the right TOI field
    const toiField = toiFields.find(f => firstSkater[f] && String(firstSkater[f]).includes(':')) 
      || toiFields[0] 
      || 'avgToi';

    const toiToSeconds = (toi) => {
      if (!toi) return 0;
      const str = String(toi);
      if (str.includes(':')) {
        const [m, s] = str.split(':').map(Number);
        return (m || 0) * 60 + (s || 0);
      }
      return parseFloat(str) || 0;
    };

    // Process all skaters — no TOI filter, just get everyone
    const skaters = (statsData.skaters || []).map(p => {
      const name = getName(p);
      const id = p.playerId; // stats uses playerId
      
      // Look up by ID first, name as fallback
      const posCode = posMap[id] || posByName[name] || p.positionCode || 'C';
      const shoots = handMap[id] || handByName[name] || 'L';
      const toi = p[toiField] || p.avgToi || p.timeOnIcePerGame || p.avgTimeOnIce || 0;

      return {
        name,
        id,
        toiSeconds: toiToSeconds(toi),
        rawToi: toi,
        posCode: posCode === 'LW' ? 'L' : posCode === 'RW' ? 'R' : posCode,
        shoots,
        points: (p.goals || 0) + (p.assists || 0),
        gamesPlayed: p.gamesPlayed || 0
      };
    }).filter(p => ['C','L','R','D'].includes(p.posCode));

    // Sort forwards by points then TOI
    const sortF = (arr) => arr.sort((a,b) => 
      b.points !== a.points ? b.points - a.points : b.toiSeconds - a.toiSeconds
    );
    const sortD = (arr) => arr.sort((a,b) => b.toiSeconds - a.toiSeconds);

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
      .sort((a,b) => (b.gamesStarted||0) - (a.gamesStarted||0))
      .slice(0, 2)
      .map(getName);

    const roster = {
      C: centres, LW: leftWings, RW: rightWings,
      LD: leftDef, RD: rightDef, G: goalieList,
      _meta: {
        team, season: SEASON,
        toiFieldUsed: toiField,
        allToiFields: toiFields,
        firstSkaterKeys: Object.keys(firstSkater),
        firstSkaterToi: firstSkater[toiField],
        totalSkaters: (statsData.skaters||[]).length,
        filteredSkaters: skaters.length,
        sampleSkater: skaters[0] || null,
        centres: centres.length, leftWings: leftWings.length,
        rightWings: rightWings.length, leftDef: leftDef.length, rightDef: rightDef.length
      }
    };

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(roster);

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
