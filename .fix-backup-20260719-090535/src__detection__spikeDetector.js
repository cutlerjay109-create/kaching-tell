const { SPIKE_THRESHOLD, MIN_SPIKE_DELTA } = require('../config/constants');

class SpikeDetector {
  constructor(baselineCalculator) {
    this.baseline = baselineCalculator;
    this.recentWindow = [];
    this.WINDOW_SIZE = 5;
  }

  update(oddsEvent) {
    this.recentWindow.push(oddsEvent);
    if (this.recentWindow.length > this.WINDOW_SIZE) {
      this.recentWindow = this.recentWindow.slice(-this.WINDOW_SIZE);
    }
    return this.check();
  }

  check() {
    if (this.recentWindow.length < 2) return null;
    const baseline = this.baseline.getBaseline();
    if (baseline === 0) return null;

    let totalDelta = 0;
    let totalTime = 0;
    for (let i = 1; i < this.recentWindow.length; i++) {
      const delta = Math.abs(this.recentWindow[i].Prices[0] - this.recentWindow[i-1].Prices[0]);
      const dt = (this.recentWindow[i].Ts - this.recentWindow[i-1].Ts) / 1000;
      if (dt > 0) { totalDelta += delta; totalTime += dt; }
    }

    const currentVelocity = totalTime > 0 ? totalDelta / totalTime : 0;
    const ratio = currentVelocity / baseline;
    const maxDelta = Math.max(...this.recentWindow.slice(1).map((o, i) =>
      Math.abs(o.Prices[0] - this.recentWindow[i].Prices[0])
    ));

    if (ratio >= SPIKE_THRESHOLD && maxDelta >= MIN_SPIKE_DELTA) {
      return {
        detected: true,
        velocity: currentVelocity,
        baseline,
        ratio: ratio.toFixed(2),
        magnitude: maxDelta,
        ts: this.recentWindow[this.recentWindow.length - 1].Ts
      };
    }
    return null;
  }
}

module.exports = { SpikeDetector };
