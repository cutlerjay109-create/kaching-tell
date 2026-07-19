// Offline pipeline proof — no TxLINE creds, no network.
// Simulates the France vs England pattern: goal actions fire with EMPTY stats,
// and the confirming stat increment arrives ~54s later as a SEPARATE event.
// Proves: score tracks correctly, scorer attributed from the stat that increments,
// detections verify, and lead time is computed.

const { GoalDetector } = require('../src/detection/goalDetector');
const { Verifier } = require('../src/detection/verifier');
const { Store } = require('../src/ledger/store');

const fixture = {
  FixtureId: 999001,
  Participant1: 'France',   // home -> Stats['1001']
  Participant2: 'England',  // away -> Stats['1002']
  StartTime: 0
};

// Final score France 4 - 6 England. Sequence of goals (minute, side).
const goals = [
  { min: 12, side: 'away' }, { min: 23, side: 'home' },
  { min: 34, side: 'away' }, { min: 41, side: 'home' },
  { min: 48, side: 'away' }, { min: 55, side: 'away' },
  { min: 63, side: 'home' }, { min: 71, side: 'away' },
  { min: 79, side: 'home' }, { min: 88, side: 'away' }
];

const store = new Store();
const verifier = new Verifier();
const detector = new GoalDetector(fixture);
detector.homeGoals = 0; detector.awayGoals = 0;
verifier.seedBaseline(fixture.FixtureId, 0, 0, 0);

const anchored = [];
detector.on('detection', (d) => {
  store.addDetection(d);
  verifier.watch(d);
  anchored.push(d);
});
verifier.on('result', (r) => {
  store.updateDetection(r.wallTs, r.fixtureId, {
    status: r.status, leadTimeMs: r.leadTimeMs,
    confirmedScoringTeam: r.confirmedScoringTeam,
    scoreAtDetection: r.confirmedScore || undefined,
    scoringTeam: r.confirmedScoringTeam || undefined
  });
});

// Build the event timeline. Ts in ms.
let home = 0, away = 0;
const events = [];
for (const g of goals) {
  const goalTs = g.min * 60 * 1000;
  const clock = { Seconds: g.min * 60 };
  // 1) goal action — EMPTY stats (the early signal)
  events.push({
    _type: 'score', FixtureId: fixture.FixtureId, Action: 'goal',
    Participant: g.side === 'home' ? 1 : 2, Ts: goalTs, Seq: goalTs,
    Clock: clock, Stats: {}, Data: { GoalType: 'Shot' }
  });
  // odds spike right around the goal so confidence isn't score-only
  events.push({
    _type: 'odds', FixtureId: fixture.FixtureId, Ts: goalTs + 1000,
    MessageId: 'm' + goalTs, InRunning: true, SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
    Prices: [22000]
  });
  // settle back so the next goal produces a fresh delta
  events.push({
    _type: 'odds', FixtureId: fixture.FixtureId, Ts: goalTs + 8000,
    MessageId: 'm' + goalTs + 's', InRunning: true, SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
    Prices: [10000]
  });
  // 2) stat increment — arrives 54s later as a SEPARATE event (ground truth)
  if (g.side === 'home') home++; else away++;
  events.push({
    _type: 'score', FixtureId: fixture.FixtureId, Action: 'score_update',
    Ts: goalTs + 54000, Seq: goalTs + 54000, Clock: { Seconds: g.min * 60 + 54 },
    Stats: { '1001': home, '1002': away }
  });
}

// Seed a calm odds baseline before kickoff so spikes register.
for (let i = 0; i < 40; i++) {
  detector.onOddsEvent({
    FixtureId: fixture.FixtureId, Ts: i * 1000, MessageId: 'base' + i,
    InRunning: true, SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
    Prices: [10000 + (i % 2)]  // tiny movement = low baseline velocity
  });
}

events.sort((a, b) => a.Ts - b.Ts);

// Inject a VAR/disallowed goal at 60:00 — a goal action that NEVER gets a stat
// increment. It must be flagged as a false positive, not verified.
const varTs = 60 * 60 * 1000;
events.push({
  _type: 'score', FixtureId: fixture.FixtureId, Action: 'goal',
  Participant: 1, Ts: varTs, Seq: varTs, Clock: { Seconds: 60 * 60 },
  Stats: {}, Data: { GoalType: 'Shot' }
});
events.push({
  _type: 'odds', FixtureId: fixture.FixtureId, Ts: varTs + 1000,
  MessageId: 'var', InRunning: true, SuperOddsType: '1X2_PARTICIPANT_RESULT',
  Prices: [12000]
});
events.push({
  _type: 'odds', FixtureId: fixture.FixtureId, Ts: varTs + 8000,
  MessageId: 'vars', InRunning: true, SuperOddsType: '1X2_PARTICIPANT_RESULT',
  Prices: [10000]
});
events.sort((a, b) => a.Ts - b.Ts);

// Single interleaved pass — feed score events to BOTH detector and verifier (like live/replay)
for (const e of events) {
  if (e._type === 'score') {
    detector.onScoreEvent(e);
    verifier.onScoreEvent(e);
  } else {
    detector.onOddsEvent(e);
  }
}
detector.flush();
verifier.finalize();

setTimeout(() => {
  const s = store.getStats();
  console.log('\n================ SIMULATION RESULT ================');
  console.log('Expected final score: France 4 - 6 England');
  console.log('Detector tracked:     France ' + detector.homeGoals + ' - ' + detector.awayGoals + ' England');
  console.log('--------------------------------------------------');
  console.log('Detections fired:     ' + s.total + ' (goals in match: ' + goals.length + ')');
  console.log('Verified:             ' + s.verified);
  console.log('False positives:      ' + s.fp);
  console.log('Pending:              ' + s.pending);
  console.log('Accuracy:             ' + s.accuracy + '%');
  console.log('Avg lead time:        ' + s.avgLead + 's before official confirmation');
  console.log('--------------------------------------------------');
  console.log('Per-detection scorer attribution:');
  for (const d of store.getAll()) {
    console.log('  ' + d.matchClockFormatted.padStart(6) +
      '  ' + (d.confirmedScoringTeam || d.scoringTeam).padEnd(8) +
      '  score ' + d.scoreAtDetection +
      '  [' + d.status + ']');
  }
  console.log('==================================================\n');
}, 9000);
