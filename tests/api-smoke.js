import assert from 'node:assert/strict';
const base = process.env.ABLE_URL || 'http://127.0.0.1:4173';
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
}
const cash = { fromBank: 'harbour', toBank: 'eastbridge', amount: 500000, counterparty: 'Harbour Liquidity Pool', quoteOutput: 0, minOutput: 0, validitySeconds: 60 };
await api('/api/reset', {});
try {
  const start = await api('/api/state');
  assert.deepEqual(start.banks.map(bank => bank.governmentBonds), [1500000, 1000000, 500000]);
  assert.deepEqual(start.banks.map(bank => bank.corporateBonds), [800000, 600000, 300000]);
  assert.equal(start.balances.governmentBonds, 1500000);
  for (const fundingAsset of ['tGOVBOND', 'tCORPBOND']) {
    const before = await api('/api/state');
    const bondPayment = await api('/api/payment', { ...cash, fromBank: 'meridian', amount: 1100000, fundingAsset, quoteOutput: 100000, minOutput: 90000 });
    assert.equal(bondPayment.request.status, 'Executed'); assert.equal(bondPayment.request.fundingAsset, fundingAsset);
    assert.ok(bondPayment.request.swapTxHash); assert.equal((await api('/api/ledger/reconcile')).matched, true);
    const after = await api('/api/state');
    const balanceKey = fundingAsset === 'tGOVBOND' ? 'governmentBonds' : 'corporateBonds';
    assert.ok(after.banks.find(bank => bank.id === 'meridian')[balanceKey] < before.banks.find(bank => bank.id === 'meridian')[balanceKey]);
    await api('/api/reset', {});
  }
  for (const [change, expected] of [
    [{ amount: 2500000 }, 'Rejected'], [{ counterparty: 'Unlisted Counterparty' }, 'Manual review'],
    [{ toBank: 'harbour' }, 'Rejected'], [{ amount: -1 }, 'Rejected'],
    [{ validitySeconds: 1 }, 'Rejected'], [{ minOutput: 100 }, 'Rejected'],
    [{ fromBank: 'unknown' }, 'Rejected'],
  ]) {
    const response = await api('/api/payment', { ...cash, ...change });
    assert.equal(response.request.result, expected); assert.equal(response.request.txHash, '');
  }
  const unchanged = await api('/api/state'); assert.deepEqual(unchanged.banks, start.banks);
  const reviewReject = await api('/api/payment', { ...cash, counterparty: 'Unlisted Counterparty' });
  const rejectBefore = await api('/api/state');
  const rejected = await api(`/api/review/${reviewReject.request.id}`, { decision: 'reject' });
  assert.equal(rejected.request.status, 'Rejected'); assert.equal(rejected.request.reason, 'Rejected during manual review');
  assert.deepEqual(rejected.state.banks, rejectBefore.banks);
  const reviewPass = await api('/api/payment', { ...cash, counterparty: 'Unlisted Counterparty' });
  const passed = await api(`/api/review/${reviewPass.request.id}`, { decision: 'pass' });
  assert.equal(passed.request.status, 'Executed'); assert.equal(passed.request.reviewDecision, 'Pass'); assert.ok(passed.request.txHash);
  const blockedReview = await api('/api/payment', { ...cash, counterparty: 'Unlisted Counterparty' });
  await api('/api/policy', { tradeLimit: 400000, dailyLimit: 2000000, haircut: 5 });
  const blocked = await api(`/api/review/${blockedReview.request.id}`, { decision: 'pass' });
  assert.equal(blocked.request.status, 'Rejected'); assert.equal(blocked.request.reason, 'Per-trade limit exceeded');
  await api('/api/policy', { tradeLimit: 2000000, dailyLimit: 5000000, haircut: 5 });
  const swapped = await api('/api/payment', { ...cash, fromBank: 'meridian', amount: 1600000, quoteOutput: 600000, minOutput: 600000 });
  assert.equal(swapped.request.status, 'Executed'); assert.ok(swapped.request.swapTxHash); assert.ok(swapped.request.txHash);
  assert.equal(swapped.state.banks.find(bank => bank.id === 'meridian').cash, 0);
  assert.equal(swapped.state.banks.find(bank => bank.id === 'eastbridge').cash, 2900000);
  assert.equal(swapped.state.banks.find(bank => bank.id === 'meridian').mmf, 2368421.05);
  let swapEvents;
  for (let i=0; i<20; i++) { swapEvents = (await api('/api/state')).chainEvents; if (swapEvents.some(event => event.hash === swapped.request.swapTxHash) && swapEvents.some(event => event.hash === swapped.request.txHash)) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(swapEvents.some(event => event.name === 'SwapExecuted' && event.hash === swapped.request.swapTxHash));
  assert.ok(swapEvents.some(event => event.name === 'Transfer' && event.hash === swapped.request.txHash));
  await api('/api/policy', { tradeLimit: 2000000, dailyLimit: 2000000, haircut: 5 });
  assert.equal((await api('/api/payment', cash)).request.reason, 'Rolling 24h limit exceeded');
  assert.equal((await api('/api/ledger/reconcile')).matched, true);
  await api('/api/halt', {}); assert.equal((await api('/api/payment', cash)).request.reason, 'Emergency halt active');
  await api('/api/reset', {});
  const resetState = await api('/api/state');
  assert.deepEqual(resetState.banks.map(bank => bank.governmentBonds), [1500000, 1000000, 500000]);
  assert.deepEqual(resetState.banks.map(bank => bank.corporateBonds), [800000, 600000, 300000]);
  const direct = await api('/api/payment', cash); assert.equal(direct.request.status, 'Executed'); assert.equal(direct.request.swapTxHash, '');
  let observed;
  for (let i=0; i<20; i++) { observed = await api('/api/state'); if (observed.chainEvents.some(event => event.hash === direct.request.txHash)) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(observed.chainEvents.some(event => event.hash === direct.request.txHash), 'Transfer listener must recover after reset');
  console.log('PASS: policy rejection/review, no balance movement, DvP balances, rolling cap, halt, reconciliation, reset and live event delivery.');
} finally { await api('/api/reset', {}); }
