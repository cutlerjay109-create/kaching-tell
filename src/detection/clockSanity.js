const { CLOCK_SANITY_LIMIT } = require('../config/constants');

function isSane(event, matchStartTime) {
  if (!event.Clock || !event.Clock.Seconds) return true;
  const wallSeconds = (event.Ts - matchStartTime) / 1000;
  const matchSeconds = event.Clock.Seconds;
  const drift = wallSeconds - matchSeconds;
  return drift < CLOCK_SANITY_LIMIT;
}

module.exports = { isSane };
