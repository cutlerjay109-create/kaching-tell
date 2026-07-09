const crypto = require('crypto');

function hashDetection(detection) {
  const payload = JSON.stringify({
    fixtureId: detection.fixtureId,
    matchClock: detection.matchClock,
    wallTs: detection.wallTs,
    spikeMagnitude: detection.spikeMagnitude,
    confidence: detection.confidence
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { hashDetection };
