const { BASELINE_WINDOW } = require('../config/constants');

class BaselineCalculator {
  constructor() {
    this.recentOdds = [];
    this.baseline = 0;
  }

  update(oddsEvent) {
    this.recentOdds.push(oddsEvent);
    if (this.recentOdds.length > BASELINE_WINDOW * 3) {
      this.recentOdds = this.recentOdds.slice(-BASELINE_WINDOW * 3);
    }
    if (this.recentOdds.length >= BASELINE_WINDOW) {
      this.baseline = this._computeVelocity(this.recentOdds.slice(-BASELINE_WINDOW));
    }
  }

  _computeVelocity(odds) {
    let totalDelta = 0;
    let totalTime = 0;
    for (let i = 1; i < odds.length; i++) {
      const delta = Math.abs(odds[i].Prices[0] - odds[i-1].Prices[0]);
      const dt = (odds[i].Ts - odds[i-1].Ts) / 1000;
      if (dt > 0) { totalDelta += delta; totalTime += dt; }
    }
    return totalTime > 0 ? totalDelta / totalTime : 0;
  }

  getBaseline() { return this.baseline; }
}

module.exports = { BaselineCalculator };
