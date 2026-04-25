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

    // Build name-based maps from roster (most reliable cross-reference)
    const shootsByName = {};
    const posByName = {};

    (rosterData.forwards || []).forEach(p => {
      const name = getName(p);
      shootsByName[name] = p.shootsCatches || 'L';
      posByName[name] = p.positionCode; // C, L, R
    });
    (rosterData.defensemen || []).forEach(p => {
      const name = getName(p);
      shootsByName[name] = p.shootsCatches || 'L';
      posByName[name] = 'D';
    });
    (rosterData.goalies || []).forEach(p => {
      const name = getName(p);
      posByName[name] = 'G';
    });

    // Also build ID-based maps
    const shootsById = {};
    const posById = {};
    (rosterData.forwards || []).forEach(p => {
      shootsById[p.id] = p.shootsCatches || 'L';
      posById[p.id] = p.positionCode;
    });
    (rosterData.defensemen || []).forEach(p => {
      shootsById[p.id] = p.shootsCatches || 'L';
      posById[p.id] = 'D';
    });

    // Get first skater to inspect field structure
    const sample = (statsData.skaters || [])[0] || {};

    // Find TOI field — look for anything with a colon (MM:SS format)
    let toiField = 'avgToi';
    for (const [key, val] of Object.entries(sample)) {
      if (typeof val === 'string' && val.includes(':') && val.length < 10) {
        toiField = key;
        break;
      }
    }

    const toiToSeconds = (val) => {
      if (!val) return 0;
      const s = String(val);
      if (s.includes(':')) {
        const [m, sec] = s.split(':').map(Number);
        return (m || 0) * 60 + (sec || 0);
      }
      return parseFloat(s) || 0;
    };

    // Process ALL skaters from stats endpoint
    const allSkaters = (statsData.skaters || []).map(p => {
      const name = getName(p);
      const id = p.playerId || p.id;

      // Get position: name lookup first, then ID, then API field
      let pos = posByName[name] || posById[id] || p.positionCode || '';
      // Normalize
      if (pos === 'LW') pos = 'L';
      if (pos === 'RW') pos = 'R';

      // Get shoots: name lookup first, then ID
      const shoots = shootsByName[name] || shootsById[id] || 'L';

      const toi = p[toiField] || 0;

      return {
        name,
        id,
        pos,
        shoots,
        toiSeconds: toiToSeconds(toi),
        points: (p.goals || 0) + (p.assists || 0),
        gamesPlayed: p.gamesPlayed || 0
      };
    });

    // Separate by position — use pos from roster, not stats
    // No filters — include everyone, sort by production then TOI
    const forwards = allSkaters.filter(p => ['C','L','R'].includes(p.pos));
    const dmen = allSkaters.filter(p => p.pos === 'D');

    // If a player isn't in posMap (traded in mid-season), check stats positionCode
    // and add them based on what the stats endpoint says
    const unmapped = allSkaters.filter(p => !p.pos);
    
    const sortByProd = (arr) => arr.sort((a,b) =>
      b.points !== a.points ? b.points - a.points : b.toiSeconds - a.toiSeconds
    );
    const sortByToi = (arr) => arr.sort((a,b) => b.toiSeconds - a.toiSeconds);

    const sorted = sortByProd(forwards);
    const centres = [], lw = [], rw = [], overflow = [];

    for (const p of sorted) {
      if      (p.pos === 'C' && centres.length < 4) centres.push(p.name);
      else if (p.pos === 'L' && lw.length < 4)      lw.push(p.name);
      else if (p.pos === 'R' && rw.length < 4)      rw.push(p.name);
      else overflow.push(p);
    }
    for (const p of overflow) {
      if      (lw.length < 4)      lw.push(p.name);
      else if (rw.length < 4)      rw.push(p.name);
      else if (centres.length < 4) centres.push(p.name);
    }

    const sortedD = sortByToi(dmen);
    const leftDef  = sortedD.filter(p => p.shoots === 'L').slice(0,3).map(p => p.name);
    const rightDef = sortedD.filter(p => p.shoots === 'R').slice(0,3).map(p => p.name);

    // Fill gaps from overflow D
    const usedD = new Set([...leftDef, ...rightDef]);
    const dOver = sortedD.filter(p => !usedD.has(p.name));
    while (leftDef.length < 3 && dOver.length)  leftDef.push(dOver.shift().name);
    while (rightDef.length < 3 && dOver.length) rightDef.push(dOver.shift().name);

    const goalies = (statsData.goalies || [])
      .sort((a,b) => (b.gamesStarted||0) - (a.gamesStarted||0))
      .slice(0,2).map(getName);

    return res.status(200).json({
      C: centres, LW: lw, RW: rw,
      LD: leftDef, RD: rightDef, G: goalies,
      _meta: {
        team, toiField,
        rosterF: (rosterData.forwards||[]).length,
        rosterD: (rosterData.defensemen||[]).length,
        statsSkaters: (statsData.skaters||[]).length,
        totalForwards: forwards.length,
        totalDmen: dmen.length,
        unmapped: unmapped.length,
        sampleFields: Object.keys(sample),
        firstFewSkaters: allSkaters.slice(0,5).map(p => ({name:p.name, pos:p.pos, shoots:p.shoots, toi:p.toiSeconds, pts:p.points}))
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
