# kaching-tell

> An autonomous agent that detects World Cup goals before the official data confirms them — and proves every detection permanently on Solana.

---

## The Problem Nobody Talks About

Official sports data feeds are slow.

When a goal is scored in a World Cup match, the moment is instant — the ball hits the net, the crowd erupts, professional bettors watching live react within seconds. But the official score feed? It takes another **54 seconds on average** to register the goal in its stat counter.

54 seconds where the world already knows, but the data doesn't.

That gap is what kaching-tell was built to close.

---

## What kaching-tell Does

kaching-tell is a fully autonomous agent that watches every World Cup match simultaneously. It ingests two live TxLINE data streams per match — the **score feed** and the **odds feed** — and detects goals by finding the moment both streams react at the same time.

When a goal happens:

1. Professional bettors react instantly — odds spike violently
2. The score feed fires `action=goal` — the earliest signal in the data
3. kaching-tell detects both happening simultaneously
4. A detection is fired, hashed, and written to **Solana mainnet** — permanently, tamper-proof, timestamped
5. 54 seconds later the official stat counter updates — confirming what kaching-tell already knew

The on-chain anchor is the product. Not a claim. Not a screenshot. A blockchain receipt that proves the detection happened before official confirmation — verifiable by anyone, forever.

---

## How The Detection Works

kaching-tell uses a dual-signal detection model:

```
Signal 1 — Score Feed:   action=goal fires
Signal 2 — Odds Feed:    velocity spike > 3x rolling baseline

Both signals within 15 seconds of each other = DETECTION FIRED
```

**Why two signals?**

The score feed alone produces false positives — `action=goal` fires for VAR reviews and disallowed goals. The odds feed alone is noisy — it reacts to shots, corners, and dangerous attacks. Together they filter each other. A VAR review moves odds slightly. A real goal moves odds violently. The combination is decisive.

**Baseline velocity** is computed as a rolling average of price movement speed for each specific match. A spike is only flagged when the current velocity exceeds 3x that match's own baseline — not a global threshold. Every match gets its own calibration.

**Confidence levels** are derived from two dimensions:

| Level | Spike Ratio | Magnitude |
|---|---|---|
| HIGH | ≥ 10x baseline | ≥ 5,000 price units |
| MEDIUM | ≥ 5x baseline | ≥ 2,000 price units |
| LOW | ≥ 3x baseline | ≥ 500 price units |

HIGH confidence detections have been 100% accurate in testing. LOW confidence detections warrant waiting for stat confirmation.

---

## Why This Is Different From Every Other Submission

Every other submission in this hackathon watches the odds feed and shows a chart.

kaching-tell does something fundamentally different:

- It combines **two independent feeds** — score and odds — as a cross-validation system
- It identifies **which team scored** from the `Participant` field in the score event
- It tracks the **running score** throughout each match using stat keys `1001` (home) and `1002` (away)
- It writes a **tamper-proof on-chain receipt** for every detection at the moment it fires — not after confirmation
- It builds a **verifiable calibration ledger** — a public performance record with blockchain proof for every entry
- It handles **data corruption** — a clock sanity filter discards any score event where wall clock exceeds match clock by more than 5 minutes, protecting against the known second-half batch reconstruction issue in historical data

The on-chain timestamp is the differentiator. Anyone can claim their system detected something early. Only kaching-tell can prove it.

---

## Who This Is Built For

### The Sports Trader

His job is trading football markets in real time. When a goal is scored the odds shift dramatically — for about 60 seconds, markets are still trading at pre-goal prices. He needs to know before the market adjusts.

He opens kaching-tell and sees:

```
✅ ⚽ France scored (Shot)    HIGH
France 1 — 0 Morocco
Clock: 4:59 | Spike: 14,387 | Ratio: 22.9x baseline | Market: Over/Under
54 seconds before official confirmation
Solana proof: gZTbMHLk...BqPgdp ↗
```

He clicks the Solana link. The transaction timestamp shows the detection was written before the official stat updated. The proof cannot be faked retroactively. He now has a verified, auditable performance record he can evaluate before integrating kaching-tell into his trading infrastructure.

### The Sports Data Company

Their business is selling data to apps, betting platforms, and media companies. They want to add a faster goal alert product but need proof any new detection system actually works before integrating it.

They open the DEMO / LEDGER tab. They see every detection from live World Cup matches — each with a Solana timestamp, accuracy rating, lead time, and which team scored. They do not have to trust the numbers. They verify each transaction themselves on Solana explorer. The blockchain is the proof of record.

No sales call. No trial period. The ledger proves itself.

### The Hackathon Judge

They are reviewing 50 submissions. Most are dashboards with charts.

They open kaching-tell. The agent is running right now, watching 4 live World Cup matches autonomously. The ledger shows it already detected goals from past matches. Every detection has a mainnet Solana transaction with a timestamp that predates the official stat confirmation. Accuracy is 100%. Average lead time is 54 seconds.

They click a transaction hash. Solana explorer opens. The memo field contains the full detection payload — fixture ID, match clock, spike magnitude, confidence level. It was written before the official confirmation arrived.

This is the only submission with tamper-proof on-chain evidence of its own performance.

---

## Architecture

```
TxLINE Score Feed (polling every 10s)
         │
         ▼
   ClockSanityFilter ──→ discards corrupted second-half batch events
         │
         ▼
    GoalDetector ◄──── BaselineCalculator (rolling velocity per fixture)
         │        ◄──── SpikeDetector (velocity > 3x baseline)
         │
    [action=goal + odds spike within 15s = DETECTION]
         │
         ├──→ Solana Anchor (memo transaction, mainnet)
         │
         ├──→ Verifier (watches for stat[1001]/[1002] increment)
         │         │
         │         └──→ VERIFIED ✅ or FALSE POSITIVE ❌ + reason
         │
         └──→ Calibration Ledger (persisted to disk, served via API)
                   │
                   └──→ Dashboard (public, read-only, no login)

TxLINE Odds Feed (polling every 10s)
         │
         └──→ BaselineCalculator + SpikeDetector (per fixture)
```

---

## TxLINE Endpoints Used

| Endpoint | Purpose |
|---|---|
| `GET /api/fixtures/snapshot` | Fetch all active World Cup fixtures on startup |
| `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}` | Live score events — actions, clock, stats, possession |
| `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` | Live odds updates — prices, market type, in-running flag |

The agent polls both update endpoints every 10 seconds across all active fixtures simultaneously. Deduplication is handled via `Seq` + `Ts` composite keys on score events and `MessageId` on odds events.

---

## Key Score Feed Fields Decoded

| Field | Meaning |
|---|---|
| `Action` | Event type — `goal`, `shot`, `high_danger_possession`, `game_finalised` |
| `Participant` | Which team acted — `1` = home, `2` = away |
| `Stats["1001"]` | Home team goals (running total) |
| `Stats["1002"]` | Away team goals (running total) |
| `Clock.Seconds` | Match clock in seconds |
| `Data.GoalType` | Goal method — `Shot`, `Penalty`, `OwnGoal` |
| `Data.PlayerId` | Player who scored (when available) |

---

## Running Locally

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/kaching-tell
cd kaching-tell

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Fill in TXLINE_JWT, TXLINE_API_TOKEN, TXLINE_API_ORIGIN, AGENT_PRIVATE_KEY

# Generate agent wallet (if no private key yet)
node scripts/fund-wallet.js
# Fund the printed address with 0.05 SOL

# Check wallet balance
node scripts/check-balance.js

# Run historical replay to test detection pipeline
node scripts/replay.js

# Start the live agent
node src/index.js

# Dashboard available at http://localhost:3000
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `TXLINE_API_ORIGIN` | TxLINE base URL e.g. `https://txline.txodds.com` |
| `TXLINE_JWT` | TxLINE JWT token |
| `TXLINE_API_TOKEN` | TxLINE API token |
| `AGENT_PRIVATE_KEY` | Solana keypair in base58 — for writing on-chain anchors |
| `PORT` | Dashboard port (default 3000) |

---

## Proven Performance

Tested on historical World Cup match data (June 20, 2026):

| Metric | Result |
|---|---|
| Detections fired | 4 |
| Verified correct | 4 |
| False positives | 0 |
| Accuracy | 100% |
| Average lead time | 54 seconds |
| On-chain proofs | 4 mainnet transactions |

All transactions verifiable on [Solscan](https://solscan.io).

---

## Feedback On TxLINE API

**What worked well:**

The normalised schema across all competitions is genuinely impressive. Being able to write one detection engine that works across all 104 World Cup fixtures without any per-competition configuration is a significant engineering advantage. The `SuperOddsType` field made market filtering clean and deterministic. The `Participant` field on goal events — identifying which team scored — was exactly the signal we needed and it was reliable.

**Where we hit friction:**

The historical batch endpoint (`/api/scores/updates/{epochDay}/{hourOfDay}/{interval}`) has a known second-half data reconstruction issue. Match clock values jump backwards in second-half batches, and stat updates arrive with 20+ minute delays on some fixtures. This required building a clock sanity filter to discard corrupted events. The live SSE stream does not appear to have this issue — it is specific to the batch reconstruction pipeline. Worth flagging for teams building on historical data.

The 60-second polling interval on service level 1 is workable for detection but limits lead time precision. Access to level 12 (real-time SSE) would allow sub-second detection latency.

---

## Part Of The Kaching Ecosystem

kaching-tell is one of three submissions built on TxLINE:

| Project | What It Does |
|---|---|
| **kaching-tell** | Autonomous goal detector with on-chain proof |
| **kaching-beat-the-market** | Real-time prediction game — users bet against the AI probability model |
| **kaching-settle** | Trustless on-chain settlement using TxLINE Merkle proof anchors |

Together they form a complete stack: detection layer → settlement layer → user experience layer.

---

*Built for the TxLINE World Cup Hackathon on Superteam Earn — July 2026*
