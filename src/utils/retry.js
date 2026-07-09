const logger = require('./logger');

async function withRetry(fn, label, maxAttempts = 5) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      logger.warn('retry', label + ' attempt ' + attempt + ' failed, retrying in ' + delay + 'ms', { err: err.message });
      if (attempt >= maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = { withRetry };
