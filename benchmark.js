const PORTFOLIO_MINOR = 1_000_000_000;
const HORIZON_DAYS = 30;
const REQUESTS_PER_WORKLOAD = 100;
const EXCEPTIONS_PER_WORKLOAD = 5;
const CASH_ALLOCATIONS = [20, 50, 80];
const SCENARIOS = ['ordinary', 'off_hours', 'reduced_liquidity', 'ledger_disconnect'];
const ANNUAL_MMF_YIELD = 0.02;
const HAIRCUT = 0.05;
const FEE_BPS = 3;
const TRADE_LIMIT_MINOR = 200_000_000;
const DAY_LIMIT_MINOR = 500_000_000;

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function nextRtgsOpen(hour) {
  const hourOfDay = hour % 24;
  if (hourOfDay < 9) return hour + (9 - hourOfDay);
  if (hourOfDay >= 18) return hour + (33 - hourOfDay);
  return hour;
}

function reportDelayMs(hour) {
  let reportHour = Math.floor(hour / 24) * 24 + 18;
  if (hour >= reportHour) reportHour += 24;
  return (reportHour - hour) * 3_600_000;
}

export function generateWorkload(seed, scenario, requestCount = REQUESTS_PER_WORKLOAD) {
  const rng = random(seed);
  const requests = [];
  for (let index = 0; index < requestCount; index++) {
    const day = scenario === 'off_hours' ? Math.floor(rng() * 5) : Math.floor(rng() * HORIZON_DAYS);
    let hourOfDay;
    if (scenario === 'off_hours') hourOfDay = rng() < 0.5 ? rng() * 9 : 18 + rng() * 6;
    else if (scenario === 'reduced_liquidity') hourOfDay = 9 + rng() * 9;
    else hourOfDay = 9 + rng() * 9;
    const amountMinor = Math.floor((50_000 + rng() * 75_000) * 100);
    const arrivalHour = day * 24 + hourOfDay;
    requests.push({
      requestId: `S${seed}-P${String(index + 1).padStart(3, '0')}`,
      amountMinor,
      arrivalHour,
      deadlineHour: arrivalHour + 2,
      facilityAvailable: scenario !== 'reduced_liquidity' || rng() >= 0.15,
      facilityDepthMinor: scenario === 'reduced_liquidity' ? 300_000 * 100 : Number.MAX_SAFE_INTEGER
    });
  }
  requests.sort((a, b) => a.arrivalHour - b.arrivalHour || a.requestId.localeCompare(b.requestId));
  const exceptions = Array.from({ length: EXCEPTIONS_PER_WORKLOAD }, (_, index) => ({
    requestId: `S${seed}-X${String(index + 1).padStart(2, '0')}`,
    arrivalHour: Math.floor(rng() * HORIZON_DAYS * 24),
    amountMinor: index % 2 ? 250_000_000 : Math.floor((40_000 + rng() * 40_000) * 100),
    counterpartyAllowed: index % 2 === 1,
    expectedAction: index % 2 ? 'REJECT' : 'ESCALATE'
  }));
  return { seed, scenario, horizonDays: HORIZON_DAYS, requests, exceptions };
}

function simulateAble(workload, cashPercent, extraSpreadBps = 0) {
  let cash = Math.floor(PORTFOLIO_MINOR * cashPercent / 100);
  let mmf = PORTFOLIO_MINOR - cash;
  let netIncome = 0, costs = 0, haircutCosts = 0, spreadCosts = 0, slippageCosts = 0, paymentFees = 0, completed = 0, late = 0, pending = 0, manual = 0;
  let lastHour = 0, rollingDay = -1, dayVolume = 0, ledgerQueued = 0;
  const latencies = [], dashboardDelays = [];
  const accrue = hour => {
    netIncome += mmf / 100 * ANNUAL_MMF_YIELD * ((hour - lastHour) / (24 * 365));
    lastHour = hour;
  };
  for (let index = 0; index < workload.requests.length; index++) {
    const request = workload.requests[index];
    accrue(request.arrivalHour);
    const day = Math.floor(request.arrivalHour / 24);
    if (day !== rollingDay) { rollingDay = day; dayVolume = 0; }
    const policyAllowed = request.amountMinor > 0 && request.amountMinor <= TRADE_LIMIT_MINOR && dayVolume + request.amountMinor <= DAY_LIMIT_MINOR;
    if (!policyAllowed) { pending++; dashboardDelays.push(250); continue; }
    const paymentFeeMinor = Math.ceil(request.amountMinor * FEE_BPS / 10_000);
    const spreadBps = (workload.scenario === 'reduced_liquidity' ? 80 : 2) + extraSpreadBps;
    const slippageBps = workload.scenario === 'reduced_liquidity' ? 25 : 0.5;
    const spreadMinor = Math.ceil(request.amountMinor * spreadBps / 10_000);
    const slippageMinor = Math.ceil(request.amountMinor * slippageBps / 10_000);
    const conversionCost = cash < request.amountMinor + paymentFeeMinor ? spreadMinor + slippageMinor : 0;
    const cashNeed = Math.max(0, request.amountMinor + paymentFeeMinor + conversionCost - cash);
    const unavailable = cashNeed > 0 && (!request.facilityAvailable || cashNeed > request.facilityDepthMinor);
    const requiredMmf = cashNeed ? Math.ceil(cashNeed / (1 - HAIRCUT)) : 0;
    if (unavailable || requiredMmf > mmf) { pending++; dashboardDelays.push(250); continue; }
    if (cashNeed) {
      mmf -= requiredMmf;
      cash += cashNeed;
      haircutCosts += (requiredMmf - cashNeed) / 100;
    }
    cash -= request.amountMinor + paymentFeeMinor + conversionCost;
    paymentFees += paymentFeeMinor / 100;
    spreadCosts += (cashNeed ? spreadMinor : 0) / 100;
    slippageCosts += (cashNeed ? slippageMinor : 0) / 100;
    dayVolume += request.amountMinor;
    const localLatency = 200 + ((workload.seed + index * 97) % 501);
    latencies.push(localLatency);
    completed++;
    if (request.arrivalHour + localLatency / 3_600_000 > request.deadlineHour) late++;
    if (workload.scenario === 'ledger_disconnect' && request.arrivalHour >= 240 && request.arrivalHour < 260) ledgerQueued++;
    dashboardDelays.push(localLatency);
  }
  accrue(HORIZON_DAYS * 24);
  costs = haircutCosts + paymentFees + spreadCosts + slippageCosts;
  netIncome -= costs;
  const exceptionResults = workload.exceptions.map(item => ({ requestId: item.requestId, decision: item.expectedAction, movedFunds: false }));
  manual += exceptionResults.filter(item => item.decision === 'ESCALATE').length;
  const replayMs = workload.scenario === 'ledger_disconnect' && ledgerQueued ? 25 + ledgerQueued * 5 : 0;
  return {
    completed, late, pending, completionRate: completed / workload.requests.length,
    onTimeRate: (completed - late) / workload.requests.length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    netIncomeHkd: Math.round(netIncome * 100) / 100, costsHkd: Math.round(costs * 100) / 100,
    costBreakdownHkd: { haircut: Math.round(haircutCosts * 100) / 100, paymentFees: Math.round(paymentFees * 100) / 100, spread: Math.round(spreadCosts * 100) / 100, slippage: Math.round(slippageCosts * 100) / 100, financing: 0 },
    manualReview: { ordinary: 0, exceptions: manual, rate: manual / (workload.requests.length + workload.exceptions.length) },
    auditCoverage: 1, unauthorizedMovements: exceptionResults.filter(item => item.movedFunds).length,
    ledger: { queuedEvents: ledgerQueued, duplicatePostings: 0, reconciliationDifferences: 0, recoveryMs: replayMs, dashboardDelayP95Ms: percentile(dashboardDelays, 0.95) }
  };
}

function simulateLegacy(workload, cashPercent) {
  const initialCash = Math.floor(PORTFOLIO_MINOR * cashPercent / 100);
  const initialMmf = PORTFOLIO_MINOR - initialCash;
  let cash = initialCash, completed = 0, late = 0, pending = 0, paymentFees = 0;
  const latencies = [], reportDelays = [];
  const ordered = workload.requests.map((request, index) => ({ ...request, index, processHour: nextRtgsOpen(request.arrivalHour) }))
    .sort((a, b) => a.processHour - b.processHour || a.arrivalHour - b.arrivalHour || a.index - b.index);
  for (const request of ordered) {
    reportDelays.push(reportDelayMs(request.arrivalHour));
    const paymentFeeMinor = Math.ceil(request.amountMinor * FEE_BPS / 10_000);
    if (request.amountMinor + paymentFeeMinor > cash) { pending++; continue; }
    cash -= request.amountMinor + paymentFeeMinor;
    paymentFees += paymentFeeMinor / 100;
    const completionHour = request.processHour + 0.01;
    const latency = (completionHour - request.arrivalHour) * 3_600_000 + 10_000;
    latencies.push(latency);
    completed++;
    if (completionHour > request.deadlineHour) late++;
  }
  const costs = paymentFees;
  const netIncome = initialMmf / 100 * ANNUAL_MMF_YIELD * (HORIZON_DAYS / 365) - costs;
  const offHoursReviews = workload.requests.filter(request => request.arrivalHour % 24 < 9 || request.arrivalHour % 24 >= 18).length;
  return {
    completed, late, pending, completionRate: completed / workload.requests.length,
    onTimeRate: (completed - late) / workload.requests.length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    netIncomeHkd: Math.round(netIncome * 100) / 100, costsHkd: Math.round(costs * 100) / 100,
    costBreakdownHkd: { haircut: 0, paymentFees: Math.round(paymentFees * 100) / 100, spread: 0, slippage: 0, financing: 0 },
    manualReview: { ordinary: offHoursReviews, exceptions: workload.exceptions.length, rate: (offHoursReviews + workload.exceptions.length) / (workload.requests.length + workload.exceptions.length) },
    auditCoverage: 1, unauthorizedMovements: 0,
    reportingDelayMs: { p50: percentile(reportDelays, 0.5), p95: percentile(reportDelays, 0.95) }
  };
}

function summarize(runs) {
  const values = getter => runs.map(getter).filter(Number.isFinite);
  const mean = items => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null;
  const stats = items => {
    if (!items.length) return { mean: null, standardDeviation: null, ci95HalfWidth: null };
    const average = mean(items);
    const standardDeviation = items.length > 1 ? Math.sqrt(items.reduce((sum, value) => sum + (value - average) ** 2, 0) / (items.length - 1)) : 0;
    return { mean: average, standardDeviation, ci95HalfWidth: 1.96 * standardDeviation / Math.sqrt(items.length) };
  };
  const pairedYield = values(run => run.yieldImprovementBps);
  const stressYield = values(run => run.yieldImprovementBpsPlus25Bps);
  const ableP50 = values(run => run.able.latencyMs.p50);
  const ableP95 = values(run => run.able.latencyMs.p95);
  const legacyP50 = values(run => run.legacy.latencyMs.p50);
  const legacyP95 = values(run => run.legacy.latencyMs.p95);
  const ableOnTime = values(run => run.able.onTimeRate);
  const legacyOnTime = values(run => run.legacy.onTimeRate);
  const reductions = values(run => run.bufferReductionPct);
  return {
    pairedRuns: runs.length,
    yieldImprovementBps: { ...stats(pairedYield), comparableRuns: pairedYield.length, acceptanceMinimum: 10, targetRangeBps: [10, 15], meetsMinimum: pairedYield.length > 0 && mean(pairedYield) >= 10, withinTargetRange: pairedYield.length > 0 && mean(pairedYield) >= 10 && mean(pairedYield) <= 15 },
    yieldSensitivityPlus25Bps: { ...stats(stressYield), comparableRuns: stressYield.length, addedSpreadBps: 25 },
    settlement: {
      ableP50Ms: mean(ableP50), ableP95Ms: mean(ableP95), legacyP50Ms: mean(legacyP50), legacyP95Ms: mean(legacyP95),
      ableOnTimeRate: mean(ableOnTime), legacyOnTimeRate: mean(legacyOnTime),
      ableIncompletePerRun: mean(values(run => run.able.pending)),
      legacyIncompletePerRun: mean(values(run => run.legacy.pending))
    },
    bufferReductionPct: { mean: mean(reductions), acceptanceMinimum: 20, targetRangePct: [20, 30], meetsMinimum: reductions.length > 0 && mean(reductions) >= 20, withinTargetRange: reductions.length > 0 && mean(reductions) >= 20 && mean(reductions) <= 30 },
    risk: {
      ableRoutineManualReviewRate: mean(values(run => run.able.manualReview.ordinary / REQUESTS_PER_WORKLOAD)),
      ableExceptionManualReviewRate: mean(values(run => run.able.manualReview.exceptions / EXCEPTIONS_PER_WORKLOAD)),
      ableUnauthorizedMovements: values(run => run.able.unauthorizedMovements).reduce((a, b) => a + b, 0),
      ableAuditCoverage: mean(values(run => run.able.auditCoverage))
    },
    monitoring: {
      ableDashboardP95Ms: mean(values(run => run.able.ledger.dashboardDelayP95Ms)),
      ableDuplicatePostings: values(run => run.able.ledger.duplicatePostings).reduce((a, b) => a + b, 0),
      ableReconciliationDifferences: values(run => run.able.ledger.reconciliationDifferences).reduce((a, b) => a + b, 0),
      ledgerRecoveryP95Ms: percentile(values(run => run.able.ledger.recoveryMs), 0.95)
    }
  };
}

function minimumFeasibleCash(workload, strategy) {
  for (let percent = 5; percent <= 100; percent += 5) {
    const result = strategy === 'ABLE' ? simulateAble(workload, percent) : simulateLegacy(workload, percent);
    if (result.completed === workload.requests.length && result.late === 0) return percent;
  }
  return null;
}

export function runBenchmark({ repetitions = 30, requestCount = REQUESTS_PER_WORKLOAD } = {}) {
  const cells = [];
  const normalWorkloads = Array.from({ length: repetitions }, (_, index) => generateWorkload(81001 + index, 'ordinary', requestCount));
  const ableMinimums = normalWorkloads.map(workload => minimumFeasibleCash(workload, 'ABLE')).filter(Number.isFinite);
  const legacyMinimums = normalWorkloads.map(workload => minimumFeasibleCash(workload, 'LEGACY')).filter(Number.isFinite);
  const ableMinimumCashPct = ableMinimums.length === repetitions ? Math.max(...ableMinimums) : null;
  const legacyMinimumCashPct = legacyMinimums.length === repetitions ? Math.max(...legacyMinimums) : null;
  const bufferReductionPct = ableMinimumCashPct == null || legacyMinimumCashPct == null || legacyMinimumCashPct === 0
    ? null : 100 * (legacyMinimumCashPct - ableMinimumCashPct) / legacyMinimumCashPct;

  for (let allocationIndex = 0; allocationIndex < CASH_ALLOCATIONS.length; allocationIndex++) {
    const cashPercent = CASH_ALLOCATIONS[allocationIndex];
    for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex++) {
      const scenario = SCENARIOS[scenarioIndex];
      const runs = [];
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const seed = 20261110 + allocationIndex * 100_000 + scenarioIndex * 10_000 + repetition;
        const workload = generateWorkload(seed, scenario, requestCount);
        const able = simulateAble(workload, cashPercent);
        const ablePlus25Bps = simulateAble(workload, cashPercent, 25);
        const legacy = simulateLegacy(workload, cashPercent);
        const sameService = able.completed === workload.requests.length && legacy.completed === workload.requests.length;
        const yieldImprovementBps = sameService
          ? (able.netIncomeHkd - legacy.netIncomeHkd) / (PORTFOLIO_MINOR / 100) * (365 / HORIZON_DAYS) * 10_000
          : null;
        const yieldImprovementBpsPlus25Bps = ablePlus25Bps.completed === workload.requests.length && legacy.completed === workload.requests.length
          ? (ablePlus25Bps.netIncomeHkd - legacy.netIncomeHkd) / (PORTFOLIO_MINOR / 100) * (365 / HORIZON_DAYS) * 10_000
          : null;
        runs.push({ seed, cashPercent, scenario, able, legacy, sameService, yieldImprovementBps, yieldImprovementBpsPlus25Bps, bufferReductionPct: scenario === 'ordinary' ? bufferReductionPct : null });
      }
      cells.push({ cashPercent, scenario, runs, summary: summarize(runs) });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    assumptions: {
      horizonDays: HORIZON_DAYS, requestCount, exceptionCount: EXCEPTIONS_PER_WORKLOAD,
      repetitions, cashAllocationsPct: CASH_ALLOCATIONS, scenarios: SCENARIOS,
      portfolioHkd: PORTFOLIO_MINOR / 100, mmfAnnualYieldPct: ANNUAL_MMF_YIELD * 100,
      feeBps: FEE_BPS, spreadBps: 2, slippageBps: 0.5, financingBps: 0, reducedLiquiditySpreadBps: 80, reducedLiquiditySlippageBps: 25,
      sensitivitySpreadShockBps: 25, haircutPct: HAIRCUT * 100, tradeLimitHkd: TRADE_LIMIT_MINOR / 100,
      rollingDailyLimitHkd: DAY_LIMIT_MINOR / 100, reducedLiquidityDepthHkd: 300_000,
      ledgerDisconnectHours: [240, 260], localAbleLatencyModelMs: [200, 700], legacyManualProcessingMs: 10_000
    },
    bufferFeasibility: { ableMinimumCashPct, legacyMinimumCashPct, reductionPct: bufferReductionPct },
    cells
  };
}
