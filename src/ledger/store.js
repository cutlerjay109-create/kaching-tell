const { EventEmitter } = require('events');

class Store extends EventEmitter {
  constructor() {
    super();
    this.detections = [];
    this.matches = new Map();
  }

  addDetection(detection) {
    this.detections.push(detection);
    this.emit('update', detection);
  }

  updateDetection(wallTs, fixtureId, updates) {
    const record = this.detections.find(d => d.wallTs === wallTs && d.fixtureId === fixtureId);
    if (record) {
      // Never overwrite an existing value with undefined — callers pass optional fields.
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) record[k] = v;
      }
      this.emit('update', record);
    }
  }

  setMatchInfo(fixtureId, info) {
    this.matches.set(fixtureId, info);
  }

  getAll() { return this.detections; }
  getMatches() { return Array.from(this.matches.values()); }

  getStats() {
    const total = this.detections.length;
    const verified = this.detections.filter(d => d.status === 'verified').length;
    const fp = this.detections.filter(d => d.status === 'false_positive').length;
    const pending = this.detections.filter(d => d.status === 'pending').length;
    const leads = this.detections.filter(d => d.leadTimeMs != null).map(d => d.leadTimeMs);
    const avgLead = leads.length ? Math.round(leads.reduce((a,b) => a+b,0) / leads.length / 1000) : 0;
    const accuracy = (total - pending) > 0 ? ((verified / (total - pending)) * 100).toFixed(1) : 'N/A';
    return { total, verified, fp, pending, avgLead, accuracy };
  }
}

module.exports = { Store };
