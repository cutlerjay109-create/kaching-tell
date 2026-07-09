function registerRoutes(app, store) {
  const fs = require('fs');
  const path = require('path');
  const LEDGER_FILE = './data/ledger.json';

  app.get('/api/ledger', (req, res) => {
    try {
      if (fs.existsSync(LEDGER_FILE)) {
        const data = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
        res.json(data);
      } else {
        res.json({ stats: store.getStats(), detections: store.getAll().slice(-100).reverse() });
      }
    } catch(e) {
      res.json({ stats: store.getStats(), detections: store.getAll().slice(-100).reverse() });
    }
  });

  app.get('/api/matches', (req, res) => {
    res.json(store.getMatches());
  });

  app.get('/api/live', (req, res) => {
    res.json({ stats: store.getStats(), recent: store.getAll().slice(-5).reverse(), matches: store.getMatches() });
  });
}

module.exports = { registerRoutes };
