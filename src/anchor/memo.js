function buildMemo(detection, hash) {
  return JSON.stringify({
    app: 'kaching-tell',
    v: '1.0',
    fid: detection.fixtureId,
    clock: detection.matchClock,
    ts: detection.wallTs,
    spike: detection.spikeMagnitude,
    conf: detection.confidence,
    hash: hash.substring(0, 16)
  });
}

module.exports = { buildMemo };
