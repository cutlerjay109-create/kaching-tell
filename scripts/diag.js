// ONE-OFF DIAGNOSTIC — safe, read-only. Dumps the raw shape of score/goal/stat
// events from the TxLINE feed so we can see how goals are actually delivered.
// Does NOT touch detection/verification. Remove from the start script when done.
require('dotenv').config();
const axios = require('axios');

const FIXTURE = Number(process.env.DIAG_FIXTURE || 18257739); // Spain vs Argentina final
const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 15000
});

function log(tag, obj) { console.log('[DIAG] ' + tag + ' ' + JSON.stringify(obj)); }

(async () => {
  console.log('========== KACHING-TELL DIAGNOSTIC START ==========');
  console.log('[DIAG] target fixture:', FIXTURE, '| origin set:', !!process.env.TXLINE_API_ORIGIN);

  // 1) Fixtures snapshot — shows the fixture object shape, incl. StartTime + any score fields
  try {
    const snap = (await client.get('/api/fixtures/snapshot')).data || [];
    console.log('[DIAG] fixtures in snapshot:', snap.length);
    const f = snap.find(x => x.FixtureId === FIXTURE) || snap[0];
    if (f) log('SAMPLE FIXTURE (all keys)', f);
  } catch (e) { console.log('[DIAG] snapshot error:', e.message); }

  // 2) Walk the last ~4h of score-update slots and capture goal / stat-bearing events
  const d = Math.floor(Date.now() / 86400000);
  const now = new Date();
  const h = now.getUTCHours();

  let totalForFixture = 0;
  const actionCounts = {};
  const rawGoalDumps = [];
  const rawStatDumps = [];
  const rawFinalDumps = [];

  for (let hh = h; hh >= h - 4; hh--) {
    for (let ii = 5; ii >= 0; ii--) {
      let events = [];
      try { events = (await client.get('/api/scores/updates/' + d + '/' + hh + '/' + ii)).data || []; }
      catch (e) { continue; }
      for (const x of events) {
        if (x.FixtureId !== FIXTURE) continue;
        totalForFixture++;
        actionCounts[x.Action] = (actionCounts[x.Action] || 0) + 1;
        if (x.Action === 'goal' && rawGoalDumps.length < 4) rawGoalDumps.push(x);
        if (x.Stats && Object.keys(x.Stats).length && rawStatDumps.length < 6) rawStatDumps.push(x);
        if (x.Action === 'game_finalised' && rawFinalDumps.length < 2) rawFinalDumps.push(x);
      }
    }
  }

  console.log('[DIAG] total score events seen for fixture:', totalForFixture);
  log('ACTION COUNTS', actionCounts);

  console.log('[DIAG] ---- RAW goal events (full payload) ----');
  if (!rawGoalDumps.length) console.log('[DIAG] NO goal events found for this fixture in window');
  rawGoalDumps.forEach((x, i) => log('GOAL#' + i, x));

  console.log('[DIAG] ---- RAW events carrying Stats (full payload) ----');
  if (!rawStatDumps.length) console.log('[DIAG] NO events with a populated Stats object were found — this is the key result');
  rawStatDumps.forEach((x, i) => log('STAT#' + i, x));

  console.log('[DIAG] ---- RAW game_finalised events (should carry final score) ----');
  rawFinalDumps.forEach((x, i) => log('FINAL#' + i, x));

  console.log('========== KACHING-TELL DIAGNOSTIC END ==========');
})().catch(e => console.log('[DIAG] fatal:', e.message));
