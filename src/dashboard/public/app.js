function showTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  btn.classList.add('active');
  if (name === 'demo') loadLedger();
}

function solanaLink(sig) {
  if (!sig) return '<span style="color:#444">anchoring...</span>';
  const short = sig.substring(0, 8) + '...' + sig.slice(-4);
  return '<a class="tx-link" href="https://solscan.io/tx/' + sig + '" target="_blank">' + short + ' ↗</a>';
}

function marketLabel(type) {
  if (!type) return '';
  if (type.includes('1X2')) return '1X2';
  if (type.includes('OVERUNDER')) return 'Over/Under';
  if (type.includes('ASIAN')) return 'Asian Handicap';
  return type;
}

function renderDetection(d) {
  const status = d.status || 'pending';
  const icon = status === 'verified' ? '✅' : status === 'false_positive' ? '❌' : '⏳';
  const conf = d.confidence || 'LOW';
  const lead = d.leadTimeMs ? Math.round(d.leadTimeMs / 1000) + 's before official confirmation' : '';
  const scorer = d.scoringTeam ? '⚽ ' + d.scoringTeam + ' scored' : '⚽ Goal detected';
  const score = d.scoreAtDetection ? d.participant1 + ' ' + d.scoreAtDetection + ' ' + d.participant2 : d.matchName;
  const clock = d.matchClockFormatted || (d.matchClock ? Math.floor(d.matchClock/60) + ':' + String(d.matchClock%60).padStart(2,'0') : '?');
  const goalType = d.goalType && d.goalType !== 'Unknown' ? ' (' + d.goalType + ')' : '';
  const market = d.marketType ? ' | Market: ' + marketLabel(d.marketType) : '';
  const fpNote = d.fpReason ? '<br><span style="color:#ff4444;font-size:10px">⚠ ' + d.fpReason + '</span>' : '';

  return '<div class="detection ' + status + '">' +
    '<div class="det-title ' + status + '">' + icon + ' ' + scorer + goalType +
    '<span class="badge ' + conf + '">' + conf + '</span></div>' +
    '<div class="det-score">' + score + '</div>' +
    '<div class="det-meta">' +
    'Clock: ' + clock +
    ' | Spike: ' + (d.spikeMagnitude || 0) +
    ' | Ratio: ' + (d.spikeRatio || 0) + 'x' +
    market +
    (lead ? '<br>' + lead : '') +
    '<br>' + solanaLink(d.txSig) +
    fpNote +
    '</div></div>';
}

async function loadLive() {
  try {
    const res = await fetch('/api/live');
    const data = await res.json();
    const s = data.stats;
    document.getElementById('s-total').textContent = s.total;
    document.getElementById('s-accuracy').textContent = s.accuracy + '%';
    document.getElementById('s-lead').textContent = s.avgLead + 's';
    document.getElementById('s-verified').textContent = s.verified;

    const matchesEl = document.getElementById('matches');
    matchesEl.innerHTML = data.matches.length
      ? data.matches.map(m =>
          '<div class="match-card"><div class="match-name">' + m.Participant1 + ' vs ' + m.Participant2 + '</div>' +
          '<div class="match-status">monitoring live</div></div>'
        ).join('')
      : '<div class="match-card"><div class="match-status" style="color:#444">No active matches. Switch to DEMO tab to view past detections.</div></div>';

    document.getElementById('feed').innerHTML = data.recent.length
      ? data.recent.map(renderDetection).join('')
      : '<div class="empty">Waiting for goal detections...</div>';
  } catch(e) {}
}

async function loadLedger() {
  try {
    const res = await fetch('/api/ledger');
    const data = await res.json();
    document.getElementById('ledger').innerHTML = data.detections.length
      ? data.detections.map(renderDetection).join('')
      : '<div class="empty">No detections recorded yet. Run the agent during a live match.</div>';
  } catch(e) {}
}

loadLive();
setInterval(loadLive, 5000);
