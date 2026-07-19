const { CLOCK_SANITY_LIMIT } = require('../config/constants');

// Normalise any timestamp representation to epoch milliseconds.
// Accepts: epoch ms (number), epoch seconds (number), ISO-8601 string, Date.
// Returns NaN when it genuinely cannot be understood.
function toMs(value) {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!isFinite(value)) return NaN;
    // Distinguish real epoch representations without corrupting small test values:
    //   >= 1e11  -> already epoch MILLISECONDS (real ms are ~1.7e12)
    //   >= 1e9   -> epoch SECONDS (real seconds are ~1.7e9) -> convert to ms
    //   otherwise-> small/synthetic value, treat as-is (already ms-scale)
    if (value >= 1e11) return value;
    if (value >= 1e9) return value * 1000;
    return value;
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (!Number.isNaN(asNum) && value.trim() !== '') return toMs(asNum);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

// The clock-sanity filter exists to reject corrupted historical batch events
// (second-half reconstruction where wall clock runs far ahead of match clock).
// It must NEVER cause a real event to be silently dropped just because the
// fixture start time is missing or in an unexpected format. Therefore it FAILS
// OPEN: if we cannot compute a meaningful drift, the event is treated as sane.
function isSane(event, matchStartTime) {
  if (!event || !event.Clock || typeof event.Clock.Seconds !== 'number') return true;

  const startMs = toMs(matchStartTime);
  const eventMs = toMs(event.Ts);

  // Can't compute drift reliably -> fail OPEN (never drop a real event).
  if (Number.isNaN(startMs) || Number.isNaN(eventMs)) return true;

  const wallSeconds = (eventMs - startMs) / 1000;
  const matchSeconds = event.Clock.Seconds;
  const drift = wallSeconds - matchSeconds;

  // Only reject when wall clock runs implausibly FAR ahead of the match clock
  // (the corrupted-batch signature). Negative drift (match clock ahead of wall,
  // e.g. agent started mid-match) is always allowed.
  if (!isFinite(drift)) return true;
  return drift < CLOCK_SANITY_LIMIT;
}

module.exports = { isSane, toMs };
