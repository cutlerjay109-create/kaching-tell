// Single source of truth for reading goal counts out of a TxLINE score event.
// TxLINE's normalised schema uses Stats['1001'] (home) and Stats['1002'] (away),
// but we defend against key variations and missing data so the detector and the
// verifier can NEVER drift apart in how they read the score.

function parseScore(event) {
  if (!event || !event.Stats || typeof event.Stats !== 'object') {
    return { home: null, away: null, total: null, hasStats: false };
  }

  const stats = event.Stats;
  if (Object.keys(stats).length === 0) {
    return { home: null, away: null, total: null, hasStats: false };
  }

  // Primary keys, with defensive fallbacks for alternative encodings.
  const home = firstNumber(stats, ['1001', 'home', '101']);
  const away = firstNumber(stats, ['1002', 'away', '102']);

  if (home === null && away === null) {
    return { home: null, away: null, total: null, hasStats: false };
  }

  const h = home === null ? 0 : home;
  const a = away === null ? 0 : away;
  return { home: h, away: a, total: h + a, hasStats: true };
}

function firstNumber(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      const n = Number(obj[k]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

module.exports = { parseScore };
