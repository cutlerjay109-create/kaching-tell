const express = require('express');
const path = require('path');
const { PORT } = require('../config/constants');
const { registerRoutes } = require('./routes');
const logger = require('../utils/logger');

function startDashboard(store) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  registerRoutes(app, store);
  app.listen(PORT, () => logger.info('dashboard', 'Running on port ' + PORT));
  return app;
}

module.exports = { startDashboard };
