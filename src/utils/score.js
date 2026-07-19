// Single source of truth for reading goal counts out of a TxLINE score event.
//
// The authoritative goal count lives in the event's `Score` object:
//   Score.Participant1.Total.Goals  (home, Participant1IsHome === true)
//   Score.Participant2.Total.Goals  (away)
// The flat `Stats` map is keyed by PERIOD+stat-type (e.g. 1001 = first-half slot),
// NOT home/away goals, so the old Stats['1001']/['1002'] mapping always read 0.
// We therefore read the Score object first, then fall back to the flat total-goals
// slots Stats['1'] (home) / Stats['2'] (away), which some events carry instead.
// Both the detector and the verifier use this function so they can never drift.

function parseScore(event) {
  if (!event) return { home: null, away: null, total: null, hasStats: false };

  // PRIMARY: the Score object (present on goal / game_finalised and other key events).
  let home = readGoals(event.Score && event.Score.Participant1);
  let away = readGoals(event.Score && event.Score.Participant2);

  // FALLBACK: flat total-goals slots (present on most in-play events).
  if (event.Stats && typeof event.Stats === 'object') {
    if (home === null) home = firstNumber(event.Stats, ['1', 'home', '101']);
    if (away === null) away = firstNumber(event.Stats, ['2', 'away', '102']);
  }

  if (home === null && away === null) {
    return { home: null, away: null, total: null, hasStats: false };
  }
  const h = home === null ? 0 : home;
  const a = away === null ? 0 : away;
  return { home: h, away: a, total: h + a, hasStats: true };
}

// Read a team's confirmed goal total from its Score sub-object.
// Returns 0 when the team is present but has no goals, null when unknown.
function readGoals(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.Total && typeof part.Total === 'object') {
    const g = part.Total.Goals;
    return g === undefined || g === null ? 0 : (Number(g) || 0);
  }
  // No Total block: sum whatever period blocks carry Goals (H1/H2/ET1/ET2...),
  // skipping cumulative duplicates so we don't double-count.
  const skip = { Total: 1, ETTotal: 1, HT: 1, FT: 1 };
  let sum = null;
  for (const k of Object.keys(part)) {
    if (skip[k]) continue;
    const blk = part[k];
    if (blk && typeof blk === 'object' && blk.Goals !== undefined && blk.Goals !== null) {
      sum = (sum || 0) + (Number(blk.Goals) || 0);
    }
  }
  return sum;
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
