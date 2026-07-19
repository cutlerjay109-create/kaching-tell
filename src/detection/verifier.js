const { EventEmitter } = require('events');
const { VERIFICATION_TIMEOUT, VERIFICATION_MAX_LAG } = require('../config/constants');
const { parseScore } = require('../utils/score');
const logger = require('../utils/logger');

// Upper bound on how long after a goal action an official stat increment may
// still confirm it. Live SSE confirms in ~54s, but the historical BATCH feed can
// lag 20+ minutes, so this must be generous or replay/demo marks every real goal
// a false positive.
const MAX_LAG_MS = VERIFICATION_MAX_LAG || 1800000; // 30 min ceiling
const MIN_WINDOW_MS = 120000;      // never tighten below 2 min
const WINDOW_MULT = 3;             // effective window = 3x median observed lag
const REORDER_TOL_MS = 30000;      // tolerate an increment arriving slightly early
const MAX_ORPHAN_INCREMENTS = 40;
const MAX_LAG_SAMPLES = 20;

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Verifies detections against the official stat feed.
//
// Ground-truth model:
//  - Confirmations arrive in the SAME ORDER as goals (FIFO): the Nth stat
//    increment confirms the Nth still-pending goal action. Matching is therefore
//    oldest-pending-first BY TIME, never by the goal action's Participant field
//    (which is not reliable).
//  - The scoring SIDE is taken from WHICH stat key increments (Stats['1001']=home,
//    Stats['1002']=away). This is what guarantees the dashboard shows the team
//    that actually scored (fixes "Canada scored" when Spain scored).
//  - The confirmed score is the running official total AFTER the increment, so a
//    4-6 match shows exactly 0-1, 1-1, ... 4-6 across the detections.
//  - The eligibility window ADAPTS to the observed confirmation lag: it starts
//    generous (tolerating 20-min batch delays) and tightens toward ~3x the live
//    lag once a couple of goals are seen, so a VAR/disallowed goal that never gets
//    an increment ages out instead of stealing a later goal's confirmation.
class Verifier extends EventEmitter {
  constructor() {
    super();
    this.pendingByFixture = new Map();  // fixtureId -> [entry] (sorted by goalEventTs asc)
    this.confirmed = new Map();         // fixtureId -> { home, away } running official total
    this.orphanIncrements = new Map();  // fixtureId -> [{ side, incTs, runHome, runAway }]
    this.lagSamples = new Map();        // fixtureId -> [lagMs]
  }

  seedBaseline(fixtureId, totalGoals, homeGoals, awayGoals) {
    this.confirmed.set(fixtureId, { home: homeGoals || 0, away: awayGoals || 0 });
    logger.info('verifier', 'Baseline seeded', { fixtureId, homeGoals, awayGoals });
  }

  _window(fid) {
    const lags = this.lagSamples.get(fid) || [];
    if (lags.length < 2) return MAX_LAG_MS;
    const w = Math.round(WINDOW_MULT * median(lags));
    return Math.min(MAX_LAG_MS, Math.max(MIN_WINDOW_MS, w));
  }

  _recordLag(fid, lag) {
    if (!(lag > 0) || lag > MAX_LAG_MS) return;
    if (!this.lagSamples.has(fid)) this.lagSamples.set(fid, []);
    const s = this.lagSamples.get(fid);
    s.push(lag);
    if (s.length > MAX_LAG_SAMPLES) s.shift();
  }

  watch(detection) {
    const fid = detection.fixtureId;
    if (!this.pendingByFixture.has(fid)) this.pendingByFixture.set(fid, []);
    const arr = this.pendingByFixture.get(fid);

    const entry = { detection, goalEventTs: detection.eventTs, startedAt: Date.now() };

    // If an increment already streamed past for this goal (reorder), pair now.
    if (this._tryMatchOrphan(fid, entry)) return;

    entry.timer = setTimeout(() => {
      const cur = this.pendingByFixture.get(fid) || [];
      const idx = cur.indexOf(entry);
      if (idx !== -1) {
        cur.splice(idx, 1);
        logger.warn('verifier', 'Timeout - false positive', { fixtureId: fid });
        this.emit('result', {
          ...detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: 'No official stat increment within verification window - likely VAR/disallowed goal'
        });
      }
    }, Math.max(VERIFICATION_TIMEOUT || 0, MAX_LAG_MS + 60000));
    if (entry.timer.unref) entry.timer.unref();

    arr.push(entry);
    arr.sort((a, b) => a.goalEventTs - b.goalEventTs); // FIFO by goal time
    logger.info('verifier', 'Watching', { fixtureId: fid, pending: arr.length });
  }

  onScoreEvent(event) {
    if (!event || !event.FixtureId) return;
    const parsed = parseScore(event);
    if (!parsed.hasStats) return;

    const fid = event.FixtureId;
    const prev = this.confirmed.get(fid) || { home: 0, away: 0 };

    // Official total never goes backwards (guards corrupted batch events).
    const newHome = Math.max(parsed.home, prev.home);
    const newAway = Math.max(parsed.away, prev.away);
    const dHome = newHome - prev.home;
    const dAway = newAway - prev.away;
    if (dHome === 0 && dAway === 0) return;

    this.confirmed.set(fid, { home: newHome, away: newAway });
    logger.info('verifier', 'Stat increment', { fixtureId: fid, home: newHome, away: newAway });

    const incTs = event.Ts || Date.now();

    // Expand into individual per-goal increments (home first, then away).
    const increments = [];
    for (let i = 0; i < dHome; i++) increments.push('home');
    for (let i = 0; i < dAway; i++) increments.push('away');

    let runHome = prev.home;
    let runAway = prev.away;
    for (const side of increments) {
      if (side === 'home') runHome++; else runAway++;
      this._confirmOne(fid, side, incTs, runHome, runAway);
    }
  }

  // Confirm the single (oldest, in-window) pending detection this increment belongs to.
  _confirmOne(fid, side, incTs, runHome, runAway) {
    const arr = this.pendingByFixture.get(fid) || [];
    const win = this._window(fid);
    const eligible = (e) => {
      const lag = incTs - e.goalEventTs;
      return lag >= -REORDER_TOL_MS && lag <= win;
    };
    // arr is sorted ascending by goalEventTs -> first eligible IS the oldest (FIFO).
    const pick = arr.find(eligible);

    if (!pick) {
      // Increment arrived before its detection was watched -> buffer as orphan.
      this._pushOrphan(fid, { side, incTs, runHome, runAway });
      return;
    }

    const idx = arr.indexOf(pick);
    if (idx !== -1) arr.splice(idx, 1);
    if (pick.timer) clearTimeout(pick.timer);
    this._recordLag(fid, incTs - pick.goalEventTs);
    this._emitVerified(pick, side, incTs, runHome, runAway);
  }

  _emitVerified(entry, side, incTs, runHome, runAway) {
    let leadTimeMs = entry.goalEventTs ? (incTs - entry.goalEventTs) : (Date.now() - entry.startedAt);
    if (!(leadTimeMs > 0)) leadTimeMs = Math.max(0, Date.now() - entry.startedAt);

    // Scorer is ground truth from the incrementing stat key, not the goal action tag.
    const confirmedScoringTeam = side === 'home'
      ? entry.detection.participant1
      : entry.detection.participant2;
    const confirmedScore = runHome + ' - ' + runAway;

    logger.info('verifier', 'VERIFIED', {
      fixtureId: entry.detection.fixtureId, confirmedScoringTeam, confirmedScore, leadMs: leadTimeMs
    });
    this.emit('result', {
      ...entry.detection,
      status: 'verified',
      leadTimeMs,
      isHomeGoal: side === 'home',
      confirmedScoringTeam,
      scoringTeam: confirmedScoringTeam,
      confirmedScore,
      scoreAtDetection: confirmedScore,
      homeGoals: runHome,
      awayGoals: runAway
    });
  }

  _pushOrphan(fid, orphan) {
    if (!this.orphanIncrements.has(fid)) this.orphanIncrements.set(fid, []);
    const list = this.orphanIncrements.get(fid);
    list.push(orphan);
    if (list.length > MAX_ORPHAN_INCREMENTS) list.splice(0, list.length - MAX_ORPHAN_INCREMENTS);
  }

  // Pair a freshly watched detection with an increment that already streamed past.
  _tryMatchOrphan(fid, entry) {
    const list = this.orphanIncrements.get(fid);
    if (!list || !list.length) return false;
    const win = this._window(fid);
    const eligible = (o) => {
      const lag = o.incTs - entry.goalEventTs;
      return lag >= -REORDER_TOL_MS && lag <= win;
    };
    // Oldest eligible orphan (FIFO by increment time).
    let idx = -1, oldest = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (eligible(list[i]) && list[i].incTs < oldest) { oldest = list[i].incTs; idx = i; }
    }
    if (idx === -1) return false;
    const o = list.splice(idx, 1)[0];
    this._recordLag(fid, o.incTs - entry.goalEventTs);
    this._emitVerified(entry, o.side, o.incTs, o.runHome, o.runAway);
    return true;
  }

  // Mark any detection that never matched an increment as a false positive.
  finalize() {
    for (const [fid, arr] of this.pendingByFixture) {
      for (const entry of arr) {
        if (entry.timer) clearTimeout(entry.timer);
        logger.warn('verifier', 'Unmatched at finalize - false positive', { fixtureId: fid });
        this.emit('result', {
          ...entry.detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: entry.detection.fpReason || 'No official stat increment matched - likely VAR/disallowed goal'
        });
      }
      arr.length = 0;
    }
  }
}

module.exports = { Verifier };
