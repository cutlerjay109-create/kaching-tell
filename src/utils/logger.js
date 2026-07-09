const log = (level, module, msg, data) => {
  const ts = new Date().toISOString();
  const base = '[' + ts + '] [' + level + '] [' + module + '] ' + msg;
  if (data) console.log(base, JSON.stringify(data));
  else console.log(base);
};

module.exports = {
  info:  (mod, msg, data) => log('INFO ', mod, msg, data),
  warn:  (mod, msg, data) => log('WARN ', mod, msg, data),
  error: (mod, msg, data) => log('ERROR', mod, msg, data),
  debug: (mod, msg, data) => log('DEBUG', mod, msg, data),
};
