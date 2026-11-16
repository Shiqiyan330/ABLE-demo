const state = { cash: 0, mmf: 0, halted: false, dailyVolume: 0, block: 0, bankBalances: {}, banks: [], selectedBank: 'harbour', requests: [], audit: [], chainEvents: [] };
const fmt = n => `HK$ ${Math.round(n).toLocaleString('en-HK')}`;
const $ = id => document.getElementById(id);
let toastTimer;
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400); }
function render() {
  $('cashValue').textContent = fmt(state.cash); $('mmfValue').textContent = fmt(state.mmf); $('totalValue').textContent = fmt(state.cash + state.mmf);
  const cashPct = state.cash + state.mmf ? Math.round(state.cash / (state.cash + state.mmf) * 100) : 0;
  $('cashPercent').textContent = `${cashPct}%`; $('mmfPercent').textContent = `${100 - cashPct}%`; $('cashTrack').style.width = `${cashPct}%`; $('mmfTrack').style.width = `${100 - cashPct}%`;
  $('cashMetricBar').style.width = `${cashPct}%`; $('mmfMetricBar').style.width = `${100 - cashPct}%`;
  const pending = state.requests.filter(r => ['Review required', 'Pending'].includes(r.status)).length;
  $('pendingValue').textContent = String(pending).padStart(2, '0'); $('reviewCount').textContent = `${state.requests.filter(r => r.status === 'Review required').length} requires review`;
  const approved = state.requests.filter(r => r.result === 'Approved').length;
  const clearance = state.requests.length ? Math.round(approved / state.requests.length * 100) : 0;
  $('complianceValue').textContent = `${clearance}%`; $('complianceBar').style.width = `${clearance}%`; $('complianceFoot').textContent = `${approved} approved / ${state.requests.length} checked`;
  $('pendingBar').style.width = `${Math.min(100, pending * 20)}%`; $('systemStatus').textContent = state.halted ? 'AUTONOMOUS EXECUTION HALTED' : 'SYSTEM OPERATIONAL'; $('systemStatus').style.color = state.halted ? '#b74349' : '';
  $('haltLabel').textContent = state.halted ? 'Resume execution' : 'Emergency halt'; $('haltButton').classList.toggle('is-halted', state.halted);
  $('blockNumber').textContent = state.block.toLocaleString('en-HK');
  const selected = state.banks.find(bank => bank.id === state.selectedBank); if (selected) $('selectedBankName').textContent = selected.name;
  const query = $('searchInput').value.toLowerCase(), filter = $('filterSelect').value;
  const rows = state.requests.filter(r => {
    const matches = `${r.id} ${r.fromBankName} ${r.toBankName} ${r.counterparty} ${r.trigger} ${r.result} ${r.status}`.toLowerCase().includes(query);
    const filtered = filter === 'all' || (filter === 'review' && r.status === 'Review required') || (filter === 'executed' && r.status === 'Executed') || (filter === 'rejected' && r.status === 'Rejected');
    return matches && filtered;
  });
  $('requestRows').innerHTML = rows.map(r => `<tr><td class="request-id">${r.id}</td><td>${r.time}</td><td>${r.fromBankName || '—'} → ${r.toBankName || '—'}</td><td class="amount-cell">${Math.round(r.amount).toLocaleString('en-HK')} HKD</td><td><span class="trigger-tag">${r.trigger}</span></td><td><span class="result-pill ${r.result === 'Approved' ? 'result-approved' : r.result === 'Manual review' ? 'result-review' : 'result-rejected'}">${r.result}</span></td><td><span class="status-pill ${r.status === 'Executed' ? 'status-executed' : r.status === 'Review required' ? 'status-review' : r.status === 'Rejected' ? 'status-rejected' : 'status-pending'}">${r.status}</span></td><td class="request-id" title="${r.txHash || ''}">${(r.txHash || '').slice(0, 10) || '—'}…</td><td>${r.status === 'Review required' ? `<div class="review-actions"><button class="review-pass" data-review="pass" data-id="${r.id}">Pass</button><button class="review-reject" data-review="reject" data-id="${r.id}">Reject</button></div>` : r.reviewDecision ? `${r.reviewDecision} · ${r.reviewedAt ? new Date(r.reviewedAt).toLocaleTimeString() : ''}` : '—'}</td></tr>`).join('');
  $('showingCount').textContent = `Showing ${rows.length} of ${state.requests.length} requests`;
  $('auditList').innerHTML = state.audit.slice(0, 8).map(a => `<div class="audit-item"><span class="audit-time">${a.time}</span><i class="audit-dot ${a.kind === 'warning' ? 'warning' : a.kind === 'danger' ? 'danger' : ''}"></i><span class="audit-message">${a.text}</span><span class="audit-hash">${a.hash}</span></div>`).join('');
}
function renderLedger(ledger) {
  if (!ledger) return;
  $('ledgerConnection').textContent = ledger.connected ? 'Pause ledger link' : 'Reconnect ledger';
  $('ledgerConnection').dataset.action = ledger.connected ? 'disconnect' : 'reconnect';
  $('ledgerStatus').textContent = !ledger.connected ? `LINK PAUSED · ${ledger.pendingReplay} QUEUED` : ledger.pendingReplay ? `${ledger.pendingReplay} POSTINGS WAITING TO REPLAY` : ledger.balanced ? 'POSTINGS BALANCED' : 'LEDGER IMBALANCE';
  $('ledgerStatus').classList.toggle('ledger-error', !ledger.balanced || ledger.pendingReplay > 0 || !ledger.connected);
  $('ledgerList').innerHTML = ledger.events.length ? ledger.events.map(event => `<article class="ledger-event"><div class="ledger-event-heading"><strong>${event.event_type.replaceAll('_', ' ')}</strong><span>${event.request_id || event.event_key}</span><small>${event.created_at} · ${event.transaction_hash ? `${event.transaction_hash.slice(0, 12)}…` : 'non-settlement event'}</small></div>${event.entries.length ? `<div class="ledger-lines">${event.entries.map(line => `<span>${line.account}</span><span>${line.asset}</span><b class="ledger-${line.side.toLowerCase()}">${line.side}</b><span>${(line.amountMinor / 100).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`).join('')}</div>` : '<div class="ledger-no-lines">Audit event only · no additional money movement posted</div>'}</article>`).join('') : '<div class="rtgs-empty">No ledger events recorded.</div>';
}
function renderBenchmark(report) {
  if (!report) return;
  const a = report.assumptions, buffer = report.bufferFeasibility;
  $('benchmarkMeta').textContent = `${a.repetitions} matched runs per cell · ${a.requestCount} ordinary + ${a.exceptionCount} exception requests · ${a.horizonDays} days · minimum feasible cash: ABLE ${buffer.ableMinimumCashPct ?? 'N/A'}% / Legacy ${buffer.legacyMinimumCashPct ?? 'N/A'}%`;
  $('benchmarkRows').innerHTML = report.cells.map(cell => {
    const s = cell.summary, yieldBps = s.yieldImprovementBps.mean;
    const bufferReduction = cell.scenario === 'ordinary' ? s.bufferReductionPct.mean : null;
    const sensitivityBps = s.yieldSensitivityPlus25Bps.mean;
    const yieldLabel = s.yieldImprovementBps.withinTargetRange ? 'within target' : yieldBps >= 10 ? 'above target range' : 'below minimum';
    const yieldResult = yieldBps == null ? 'N/A · service mismatch' : `${yieldBps.toFixed(1)} bps ±${s.yieldImprovementBps.ci95HalfWidth.toFixed(1)} · ${yieldLabel}`;
    const bufferLabel = s.bufferReductionPct.withinTargetRange ? 'within target' : bufferReduction >= 20 ? 'above target range' : 'below minimum';
    return `<tr><td>${cell.cashPercent}%</td><td>${cell.scenario.replaceAll('_', ' ')}</td><td>${(s.settlement.ableOnTimeRate * 100).toFixed(1)}%</td><td>${(s.settlement.legacyOnTimeRate * 100).toFixed(1)}%</td><td>${s.settlement.ableP50Ms?.toFixed(0) ?? '—'} / ${s.settlement.ableP95Ms?.toFixed(0) ?? '—'} ms</td><td>${yieldResult}<small class="benchmark-subvalue">+25 bps cost: ${sensitivityBps == null ? 'not comparable' : `${sensitivityBps.toFixed(1)} bps`}</small></td><td>${bufferReduction == null ? '—' : `${bufferReduction.toFixed(1)}% · ${bufferLabel}`}</td><td>${(s.risk.ableRoutineManualReviewRate * 100).toFixed(1)}% / ${(s.risk.ableExceptionManualReviewRate * 100).toFixed(1)}% / ${s.risk.ableUnauthorizedMovements}</td><td>${(s.risk.ableAuditCoverage * 100).toFixed(0)}% · ${s.monitoring.ableDashboardP95Ms?.toFixed(0) ?? '—'} ms · ${s.monitoring.ableDuplicatePostings} dup · ${s.monitoring.ableReconciliationDifferences} diff · ${s.monitoring.ledgerRecoveryP95Ms?.toFixed(0) ?? '—'} ms replay</td></tr>`;
  }).join('');
}
function nowHkt() { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); }
function audit(kind, text, hash = '') { state.audit.unshift({ time: nowHkt(), kind, text, hash }); render(); }
function simulatePayment() {
  $('requestResult').hidden = true; $('requestResult').innerHTML = '';
  updateQuote();
  $('requestDialog').showModal();
}
$('haltButton').addEventListener('click', () => fetch('/api/halt', { method: 'POST' }).then(r => r.json()).then(syncState).then(() => toast(state.halted ? 'Autonomous execution halted' : 'Autonomous execution resumed')));
$('rtgsToggle').addEventListener('click', async () => { const action = $('rtgsToggle').dataset.action; const data = await fetch(`/api/rtgs/${action}`, { method: 'POST' }).then(r => r.json()); syncState(data); toast(action === 'close' ? 'RTGS window closed; wCBDC rail remains active' : 'RTGS opened; off-hours netting batch generated'); });
$('resetButton').addEventListener('click', async () => {
  if (!window.confirm('Restore initial demo balances, policy settings, request history and local chain state?')) return;
  const button = $('resetButton'); button.disabled = true;
  try { const response = await fetch('/api/reset', { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Reset failed'); syncState({ type: 'reset', data }); $('requestResult').hidden = true; $('requestResult').innerHTML = ''; updateQuote(); toast('Demo restored to its initial state'); }
  catch (error) { toast(`Reset failed: ${error.message}`); }
  finally { button.disabled = false; }
});
$('requestRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-review]'); if (!button) return;
  const { review: decision, id } = button.dataset;
  if (decision === 'reject' && !window.confirm(`Reject request ${id}?`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/review/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Review action failed');
    syncState(data.state); toast(decision === 'pass' ? `${id} passed review and settled` : `${id} rejected; balances unchanged`);
  } catch (error) { toast(error.message); button.disabled = false; }
});
$('viewBank').addEventListener('change', async event => { state.selectedBank = event.target.value; const data = await fetch(`/api/state/bank?id=${encodeURIComponent(state.selectedBank)}`).then(r => r.json()); syncState(data); });
$('closeDialog').addEventListener('click', () => $('requestDialog').close()); $('cancelRequest').addEventListener('click', () => $('requestDialog').close());
function updateQuote() { const payer = state.bankBalances[$('fromBank')?.value] || { cash: state.cash }; const gap = Math.max(0, Number($('paymentAmount').value || 0) - payer.cash); $('quoteOutput').value = gap.toFixed(2); $('minimumOutput').value = gap.toFixed(2); $('mmfInput').value = gap ? (gap / (1 - Number($('haircut').value) / 100)).toFixed(2) : '0.00'; }
$('paymentAmount').addEventListener('input', updateQuote); $('haircut').addEventListener('input', updateQuote); $('fromBank').addEventListener('change', updateQuote);
$('requestForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('submitRequest'); button.disabled = true; button.textContent = 'Checking request…';
  const payload = { amount: Number($('paymentAmount').value), fromBank: $('fromBank').value, toBank: $('toBank').value, counterparty: $('counterpartySelect').value, quoteOutput: Number($('quoteOutput').value), minOutput: Number($('minimumOutput').value), validitySeconds: Number($('quoteExpiry').value) };
  try {
    const preflight = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
    if (preflight.error) throw new Error(preflight.error);
    await playChecks(preflight.checks);
    button.textContent = preflight.result === 'Approved' ? 'Submitting to local chain…' : 'Recording decision…';
    const response = await fetch('/api/payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await response.json(); if (data.state) syncState(data.state); showResult(data.request, data.error);
  }
  catch (error) { toast(`Request failed: ${error.message}`); }
  finally { button.disabled = false; button.textContent = 'Run checks & submit'; }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function playChecks(checks) {
  const box = $('requestResult'); box.hidden = false; box.className = 'request-result checking';
  box.innerHTML = `<div class="result-summary">RegTech pre-execution checks</div><div class="check-progress" role="status">Evaluating request against policy controls…</div><div class="rule-list">${checks.map((check, index) => `<div class="rule-line check-pending" id="check-${index}"><i></i><span>${check.name}</span><small>Waiting</small></div>`).join('')}</div>`;
  for (let i = 0; i < checks.length; i++) {
    const line = $(`check-${i}`); line.className = 'rule-line check-running'; line.querySelector('small').textContent = 'Checking';
    await pause(260);
    line.className = `rule-line ${checks[i].passed ? 'check-passed' : 'check-failed'}`;
    line.querySelector('small').textContent = checks[i].passed ? 'Passed' : checks[i].reason;
    if (!checks[i].passed) line.title = checks[i].reason;
    await pause(130);
  }
  const failed = checks.filter(check => !check.passed).length;
  box.querySelector('.check-progress').textContent = failed ? `${failed} control${failed > 1 ? 's' : ''} require attention · decision ready for review` : 'All pre-execution controls passed · submitting request';
}
function showResult(request, error) {
  const box = $('requestResult'); box.hidden = false; box.className = `request-result ${request?.status === 'Executed' ? 'success' : 'blocked'}`;
  if (!request) { box.innerHTML = `<div class="result-summary">Request failed</div><p>${error || 'Could not submit request'}</p>`; return; }
  const checks = request.checks || [];
  box.innerHTML = `<div class="result-summary">${request.id} · ${request.status} · ${request.reason}</div><div class="rule-list">${checks.map(c => `<div class="rule-line ${c.passed ? 'check-passed' : 'check-failed'}"><i></i><span>${c.name}</span><small>${c.passed ? 'Passed' : c.reason}</small></div>`).join('')}</div>${request.swapTxHash ? `<div class="result-tx">DvP swap tx: ${request.swapTxHash}</div>` : ''}${request.txHash ? `<div class="result-tx">Payment tx: ${request.txHash}</div>` : ''}<div class="result-tx">Request: ${request.id} · from ${request.from || '—'} · to ${request.to || '—'}</div>`;
}
$('haircut').addEventListener('input', e => { $('haircutValue').value = `${Number(e.target.value).toFixed(1)}%`; });
$('savePolicy').addEventListener('click', () => { const policy = { tradeLimit: Number($('tradeLimit').value), dailyLimit: Number($('dailyLimit').value), haircut: Number($('haircut').value) }; if (policy.tradeLimit <= 0 || policy.dailyLimit < policy.tradeLimit) { toast('Check the policy limits before saving'); return; } fetch('/api/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) }).then(r => r.json()).then(data => { syncState(data); toast('Policy settings saved for new requests'); }); });
$('searchInput').addEventListener('input', render); $('filterSelect').addEventListener('change', render);
$('clearAudit').addEventListener('click', () => { state.audit = []; render(); });
$('reconcileLedger').addEventListener('click', async () => { const replay = await fetch('/api/ledger/replay', { method: 'POST' }).then(r => r.json()); const result = await fetch('/api/ledger/reconcile').then(r => r.json()); const badge = $('ledgerStatus'); const ok = result.matched && replay.remaining === 0; badge.textContent = ok ? 'CHAIN BALANCES MATCH' : `${replay.remaining || result.differences.length} ITEMS NEED ATTENTION`; badge.classList.toggle('ledger-error', !ok); toast(ok ? 'Shadow ledger synced and reconciled' : 'Ledger sync or reconciliation needs attention'); });
$('ledgerConnection').addEventListener('click', async () => { const action = $('ledgerConnection').dataset.action; const data = await fetch(`/api/ledger/${action}`, { method: 'POST' }).then(r => r.json()); syncState(data); const ok = action === 'reconnect' && data.replay?.remaining === 0 && data.reconciliation?.matched; toast(action === 'disconnect' ? 'Ledger link paused; confirmed transactions will queue' : ok ? 'Ledger events replayed and reconciled' : 'Ledger replay or reconciliation needs attention'); });
$('runBenchmark').addEventListener('click', async () => { const button = $('runBenchmark'); button.disabled = true; button.textContent = 'Running paired workloads…'; try { const response = await fetch('/api/benchmark/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repetitions: 5, requestCount: 20 }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Benchmark failed'); renderBenchmark(data.benchmark); toast(`Saved raw benchmark results to ${data.resultsFile}`); } catch (error) { toast(`Benchmark failed: ${error.message}`); } finally { button.disabled = false; button.textContent = 'Run compact evaluation · 60 workloads'; } });
$('menuButton').addEventListener('click', () => toast('Treasury operator · local simulation'));
document.querySelectorAll('[data-scroll]').forEach(el => el.addEventListener('click', () => document.getElementById(el.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
const workspaceTargets = {
  dashboard: ['demo-flow', 'metrics-grid'],
  positions: ['.content-grid'],
  limits: ['.content-grid'],
  trading: ['demo-flow', '#activity', '#events'],
  audit: ['#audit', '.advanced-panels']
};
function setWorkspace(name) {
  document.body.dataset.workspace = name;
  const selectedNav = document.querySelector(`.nav-item[data-workspace="${name}"]`);
  if (selectedNav && location.hash !== selectedNav.hash) history.replaceState(null, '', selectedNav.hash);
  const visible = new Set(workspaceTargets[name] || workspaceTargets.dashboard);
  for (const selector of new Set(Object.values(workspaceTargets).flat())) {
    document.querySelectorAll(selector).forEach(element => { element.hidden = !visible.has(selector); });
  }
  $('controls').hidden = name !== 'limits';
  document.querySelector('.allocation-panel').hidden = name === 'limits';
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.workspace === name));
}
document.querySelectorAll('.nav-item[data-workspace]').forEach(el => el.addEventListener('click', event => {
  event.preventDefault();
  setWorkspace(event.currentTarget.dataset.workspace);
}));
const initialWorkspace = [...document.querySelectorAll('.nav-item[data-workspace]')].find(item => item.hash === location.hash)?.dataset.workspace || 'dashboard';
setWorkspace(initialWorkspace);
setInterval(() => { $('clock').textContent = `${nowHkt()} HKT`; }, 1000);
function syncState(data) {
  if (!data) return;
  if (data.data) return syncState(data.data);
  if (data.type === 'snapshot' || data.type === 'reset') return syncState(data.data);
  if (data.type === 'chain-event') { if (!state.chainEvents.some(item => item.key === data.event.key)) state.chainEvents.unshift(data.event); renderChainEvents(); return; }
  if (data.type === 'swap' || data.type === 'payment-settled') { state.bankBalances = data.bankBalances || state.bankBalances; const selected = state.bankBalances[state.selectedBank]; if (selected) { state.cash = selected.cash; state.mmf = selected.mmf; } state.block = data.block; const row = state.requests.find(r => r.id === data.request.id); if (row) Object.assign(row, data.request, { hash: data.request.txHash || row.hash }); render(); return; }
  if (data.type === 'request') { state.requests.unshift({ ...data.request, hash: data.request.txHash || '—' }); state.requests = state.requests.slice(0, 50); render(); return; }
  if (data.type === 'audit') { state.audit.unshift({ time: data.audit.time, kind: data.audit.kind, text: `<strong>${data.audit.text.split(' · ')[0]}</strong> · ${data.audit.text.split(' · ').slice(1).join(' · ')}`, hash: data.audit.hash }); render(); return; }
  if (data.type === 'ledger') { renderLedger(data.ledger); return; }
  if (data.type === 'listener-error') { $('listenerStatus').textContent = 'Event scan retrying'; return; }
  if (data.type === 'ledger-sync-error') { $('ledgerStatus').textContent = `${data.pending} POSTINGS WAITING TO REPLAY`; $('ledgerStatus').classList.add('ledger-error'); toast('Settlement confirmed; shadow ledger sync is pending'); return; }
  const snapshot = data.type === 'state' ? data.data : data;
  if (snapshot.balances) { state.cash = snapshot.balances.cash; state.mmf = snapshot.balances.mmf; }
  if (snapshot.banks) {
    const from = $('fromBank').value, to = $('toBank').value;
    state.banks = snapshot.banks; state.bankBalances = Object.fromEntries(snapshot.banks.map(bank => [bank.id, bank]));
    for (const control of ['viewBank', 'fromBank', 'toBank']) $(control).innerHTML = snapshot.banks.map(bank => `<option value="${bank.id}">${bank.name}</option>`).join('');
    $('viewBank').value = state.selectedBank;
    $('fromBank').value = from || state.selectedBank;
    $('toBank').value = to || snapshot.banks.find(bank => bank.id !== $('fromBank').value)?.id;
    const selected = state.bankBalances[state.selectedBank]; state.cash = selected.cash; state.mmf = selected.mmf;
  }
  if (snapshot.chain) { $('contractAddress').textContent = snapshot.chain.contractAddress; $('chainId').textContent = `CHAIN ${snapshot.chain.chainId}`; }
  if (snapshot.chainEvents) { state.chainEvents = snapshot.chainEvents; renderChainEvents(); }
  if (snapshot.requests) state.requests = snapshot.requests.map(r => ({ ...r, hash: r.txHash || '—' }));
  if (snapshot.audit) state.audit = snapshot.audit.map(a => ({ ...a, text: `<strong>${a.text.split(' · ')[0]}</strong> · ${a.text.split(' · ').slice(1).join(' · ')}` }));
  if (snapshot.block) state.block = snapshot.block;
  if (snapshot.reserveBacking) $('reserveRatio').textContent = `${Number(snapshot.reserveBacking.coverage).toFixed(2)}:1 · ${fmt(snapshot.reserveBacking.locked)} locked`;
  if (snapshot.ledger) renderLedger(snapshot.ledger);
  if (snapshot.benchmark) renderBenchmark(snapshot.benchmark);
  if (snapshot.rtgs) {
    $('rtgsStatus').textContent = snapshot.rtgs.open ? 'OPEN · 09:00–18:00 HKT' : `CLOSED · ${snapshot.rtgs.pendingNetBanks} banks with net positions`;
    $('rtgsToggle').textContent = snapshot.rtgs.open ? 'Close RTGS window' : 'Open RTGS & reconcile';
    $('rtgsToggle').dataset.action = snapshot.rtgs.open ? 'close' : 'open';
    $('rtgsQueueCount').textContent = `${snapshot.rtgs.pendingNetBanks} BANKS AWAIT NETTING`;
    $('rtgsBatchList').innerHTML = snapshot.rtgs.batches.length ? snapshot.rtgs.batches.map(batch => `<article class="rtgs-batch"><div class="rtgs-batch-top"><strong>${batch.batchId}</strong><span>${batch.messageType}</span></div><small>${batch.createdAt} · ${batch.settlementAsset}</small><div class="rtgs-net-lines">${batch.netPositions.map(pos => `<span>${pos.bank}</span><b>${pos.netCredit > 0 ? '+' : ''}${fmt(pos.netCredit)} HKD</b>`).join('')}</div><div class="rtgs-message-count">${batch.messages.length} simulated credit messages</div></article>`).join('') : '<div class="rtgs-empty">No reopening batches generated in this session.</div>';
  }
  if (typeof snapshot.halted === 'boolean') state.halted = snapshot.halted;
  if (snapshot.policy) { $('tradeLimit').value = snapshot.policy.tradeLimit; $('dailyLimit').value = snapshot.policy.dailyLimit; $('haircut').value = snapshot.policy.haircut; $('haircutValue').value = `${Number(snapshot.policy.haircut).toFixed(1)}%`; }
  render();
}
$('clock').textContent = `${nowHkt()} HKT`; render();
fetch('/api/state').then(r => r.json()).then(data => { syncState(data); updateQuote(); }).catch(() => toast('Connect to the local ABLE service to enable live execution'));
const eventSource = new EventSource('/api/events'); eventSource.onmessage = event => syncState(JSON.parse(event.data)); eventSource.onopen = () => { $('listenerStatus').textContent = 'Live stream connected'; render(); }; eventSource.onerror = () => { $('listenerStatus').textContent = 'Reconnecting'; $('systemStatus').textContent = 'RECONNECTING TO SERVICE'; };

function renderChainEvents() {
  if (state.chainEvents.length) $('listenerStatus').textContent = 'Live stream connected';
  $('eventCount').textContent = `${state.chainEvents.length} EVENTS`;
  $('chainEventList').innerHTML = state.chainEvents.slice(0, 8).map(event => `<article class="chain-event"><strong>${event.name}</strong><span>${event.detail}</span><small>Block ${event.block}</small><code title="${event.hash}">${event.hash}</code></article>`).join('') || 'Submit a payment to see confirmed contract events.';
}
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  $('fromBank').value = button.dataset.scenario === 'swap' ? 'meridian' : 'harbour';
  state.selectedBank = $('fromBank').value; $('viewBank').value = state.selectedBank;
  const position = state.bankBalances[state.selectedBank]; if (position) { state.cash = position.cash; state.mmf = position.mmf; render(); }
  $('toBank').value = 'eastbridge';
  $('paymentAmount').value = button.dataset.scenario === 'swap' ? 1600000 : button.dataset.scenario === 'limit' ? 2500000 : 500000;
  $('counterpartySelect').value = button.dataset.scenario === 'review' ? 'Unlisted Counterparty' : 'Harbour Liquidity Pool';
  simulatePayment();
}));
