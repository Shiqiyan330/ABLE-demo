import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { enqueueLedgerEvent, initializeLedger, ledgerSnapshot, markLedgerEventProjected, pendingLedgerCount, pendingLedgerEvents, recordLedgerEvent, reconcileLedger } from './shadow-ledger.js';
import { runBenchmark } from './benchmark.js';
import ganache from 'ganache';
import solc from 'solc';
import { ContractFactory, NonceManager, Wallet, id, parseUnits, formatUnits, isAddress } from 'ethers';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const runtimeDir = process.env.ABLE_DATA_DIR || path.join(root, 'runtime'); mkdirSync(runtimeDir, { recursive: true });
const benchmarkPath = path.join(runtimeDir, 'benchmark-results.json');
const ledgerDb = new DatabaseSync(path.join(runtimeDir, 'able-shadow-ledger.sqlite'));
ledgerDb.exec('PRAGMA journal_mode = WAL');
initializeLedger(ledgerDb);
let benchmarkReport = null;
try { benchmarkReport = JSON.parse(await readFile(benchmarkPath, 'utf8')); } catch {}
const banks = [
  { id: 'harbour', name: 'Harbour Bank', short: 'HBR', index: 0, signer: null, address: '', initialCash: 2_400_000, initialMmf: 7_600_000, initialGovBonds: 1_500_000, initialCorpBonds: 800_000, initialStablecoin: 500_000 },
  { id: 'meridian', name: 'Meridian Bank', short: 'MRD', index: 2, signer: null, address: '', initialCash: 1_000_000, initialMmf: 3_000_000, initialGovBonds: 1_000_000, initialCorpBonds: 600_000, initialStablecoin: 250_000 },
  { id: 'eastbridge', name: 'Eastbridge Bank', short: 'EBR', index: 3, signer: null, address: '', initialCash: 800_000, initialMmf: 2_000_000, initialGovBonds: 500_000, initialCorpBonds: 300_000, initialStablecoin: 150_000 }
];
const usdHkdRate = 7.8;
const counterparties = ['Harbour Liquidity Pool', 'Meridian Liquidity Pool', 'Eastbridge Liquidity Pool'];
let volumeHistory = [];
let chainEvents = [];
function rollingVolume() { volumeHistory = volumeHistory.filter(item => item.time > Date.now() - 86400000); state.dailyVolume = volumeHistory.reduce((sum, item) => sum + item.amount, 0); return state.dailyVolume; }
function recordChainEvent(name, log, detail) {
  const key = `${log.transactionHash}:${log.index}`;
  if (chainEvents.some(event => event.key === key)) return;
  const event = { key, name, detail, hash: log.transactionHash, block: log.blockNumber, time: new Date().toISOString() };
  chainEvents.unshift(event); chainEvents = chainEvents.slice(0, 20);
  emit({ type: 'chain-event', event });
}
const state = { runId: randomUUID(), requests: [], audit: [], pendingLedgerEvents: [], ledgerConnected: true, halted: false, rtgsOpen: true, offHoursNet: {}, rtgsBatches: [], dailyVolume: 0, dailyLimit: 5_000_000, tradeLimit: 2_000_000, haircut: 0.05, cash: 2_400_000, mmf: 7_600_000, bankBalances: {}, reserveLocked: 0, wCBDCSupply: 0, block: 0, serial: 1008, listeners: new Set(), contractAddress: '', chainId: 0 };
let provider, treasury, counterparty, centralBank, treasuryAddress, counterpartyAddress, centralBankAddress, mmf, governmentBonds, corporateBonds, stablecoin, reserveAsset, deposits, swap;
let initialChainSnapshot;
let eventCursor = 0, scanningEvents = false;

function benchmarkSnapshot() {
  if (!benchmarkReport) return null;
  return {
    generatedAt: benchmarkReport.generatedAt,
    assumptions: benchmarkReport.assumptions,
    bufferFeasibility: benchmarkReport.bufferFeasibility,
    cells: benchmarkReport.cells.map(cell => ({ cashPercent: cell.cashPercent, scenario: cell.scenario, summary: cell.summary }))
  };
}

function compile(file, contractName) {
  const source = requireSource(file);
  const input = { language: 'Solidity', sources: { [file]: { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return output.contracts[file][contractName];
}
function requireSource(file) { return sourceCache[file]; }
import { readFileSync } from 'node:fs';
const sourceCache = Object.fromEntries(['AtomicDvPSwap.sol', 'MockToken.sol', 'ReserveBackedToken.sol'].map(file => [file, readFileSync(path.join(root, 'contracts', file), 'utf8')]));
async function deploy(artifact, args, signer) { return new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy(...args); }

async function startChain() {
  const eip1193 = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5 }, chain: { chainId: 31337 } });
  const accounts = eip1193.getInitialAccounts();
  const keys = Object.values(accounts).map(account => account.secretKey);
  const { BrowserProvider } = await import('ethers');
  provider = new BrowserProvider(eip1193);
  provider.pollingInterval = 500;
  treasury = new NonceManager(new Wallet(keys[0], provider)); counterparty = new NonceManager(new Wallet(keys[1], provider));
  centralBank = new NonceManager(new Wallet(keys[4], provider)); centralBankAddress = await centralBank.getAddress();
  for (const bank of banks) { bank.signer = bank.index === 0 ? treasury : new NonceManager(new Wallet(keys[bank.index], provider)); bank.address = await bank.signer.getAddress(); }
  treasuryAddress = banks[0].address; counterpartyAddress = await counterparty.getAddress();
  const mmfArtifact = compile('MockToken.sol', 'MockToken'), depositArtifact = mmfArtifact;
  const mmfTotal = banks.reduce((sum, bank) => sum + bank.initialMmf, 0);
  const governmentBondTotal = banks.reduce((sum, bank) => sum + bank.initialGovBonds, 0);
  const corporateBondTotal = banks.reduce((sum, bank) => sum + bank.initialCorpBonds, 0);
  const stablecoinTotal = banks.reduce((sum, bank) => sum + bank.initialStablecoin, 0);
  const settlementTotal = banks.reduce((sum, bank) => sum + bank.initialCash, 0) + 10_000_000;
  mmf = await deploy(mmfArtifact, ['Tokenised MMF', 'tMMF', treasuryAddress, parseUnits(String(mmfTotal), 2)], treasury);
  governmentBonds = await deploy(mmfArtifact, ['Tokenised Government Bond', 'tGOVBOND', treasuryAddress, parseUnits(String(governmentBondTotal), 2)], treasury);
  corporateBonds = await deploy(mmfArtifact, ['Tokenised Corporate Bond', 'tCORPBOND', treasuryAddress, parseUnits(String(corporateBondTotal), 2)], treasury);
  stablecoin = await deploy(mmfArtifact, ['USD Stablecoin', 'USDC', treasuryAddress, parseUnits(String(stablecoinTotal), 2)], treasury);
  reserveAsset = await deploy(depositArtifact, ['Central Bank Reserves', 'CBR', centralBankAddress, parseUnits(String(settlementTotal), 2)], centralBank);
  await mmf.waitForDeployment(); await governmentBonds.waitForDeployment(); await corporateBonds.waitForDeployment(); await stablecoin.waitForDeployment(); await reserveAsset.waitForDeployment();
  const reserveBackedArtifact = compile('ReserveBackedToken.sol', 'ReserveBackedToken');
  deposits = await deploy(reserveBackedArtifact, [centralBankAddress, await reserveAsset.getAddress()], centralBank);
  await deposits.waitForDeployment();
  await (await reserveAsset.approve(await deposits.getAddress(), parseUnits(String(settlementTotal), 2))).wait();
  for (const bank of banks) {
    if (bank.index !== 0) await (await mmf.transfer(bank.address, parseUnits(String(bank.initialMmf), 2))).wait();
    if (bank.index !== 0) await (await governmentBonds.transfer(bank.address, parseUnits(String(bank.initialGovBonds), 2))).wait();
    if (bank.index !== 0) await (await corporateBonds.transfer(bank.address, parseUnits(String(bank.initialCorpBonds), 2))).wait();
    if (bank.index !== 0) await (await stablecoin.transfer(bank.address, parseUnits(String(bank.initialStablecoin), 2))).wait();
    await (await deposits.issueAgainstReserves(bank.address, parseUnits(String(bank.initialCash), 2))).wait();
  }
  await (await deposits.issueAgainstReserves(counterpartyAddress, parseUnits('10000000', 2))).wait();
  state.reserveLocked = Number(formatUnits(await deposits.totalReserves(), 2));
  state.wCBDCSupply = Number(formatUnits(await deposits.totalSupply(), 2));
  if (state.reserveLocked !== state.wCBDCSupply) throw new Error('Initial wCBDC reserve coverage is not 1:1');
  const swapArtifact = compile('AtomicDvPSwap.sol', 'AtomicDvPSwap');
  swap = await deploy(swapArtifact, [treasuryAddress, await mmf.getAddress(), await governmentBonds.getAddress(), await corporateBonds.getAddress(), await stablecoin.getAddress(), await deposits.getAddress()], treasury);
  await swap.waitForDeployment();
  for (const bank of banks) {
    if (bank.index !== 0) await (await swap.setExecutor(bank.address, true)).wait();
    await (await mmf.connect(bank.signer).approve(await swap.getAddress(), parseUnits(String(mmfTotal), 2))).wait();
    await (await governmentBonds.connect(bank.signer).approve(await swap.getAddress(), parseUnits(String(governmentBondTotal), 2))).wait();
    await (await corporateBonds.connect(bank.signer).approve(await swap.getAddress(), parseUnits(String(corporateBondTotal), 2))).wait();
    await (await stablecoin.connect(bank.signer).approve(await swap.getAddress(), parseUnits(String(stablecoinTotal), 2))).wait();
  }
  await (await deposits.connect(counterparty).approve(await swap.getAddress(), parseUnits('10000000', 2))).wait();
  state.contractAddress = await swap.getAddress(); state.chainId = Number((await provider.getNetwork()).chainId); state.block = Number(await provider.getBlockNumber());
  await refreshBankBalances();
  seedLedgerOpeningBalances();
  initialChainSnapshot = await provider.send('evm_snapshot', []);
  eventCursor = Number(await provider.send('eth_blockNumber', []));
  setInterval(() => scanContractEvents().catch(error => emit({ type: 'listener-error', message: error.message })), 500).unref();
  replayPendingLedgerEvents();
}
async function scanContractEvents() {
  if (scanningEvents) return;
  scanningEvents = true;
  const runId = state.runId;
  try {
    const latest = Number(await provider.send('eth_blockNumber', []));
    if (latest <= eventCursor) return;
    const logs = await provider.send('eth_getLogs', [{ fromBlock: `0x${(eventCursor + 1).toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: [await swap.getAddress(), await deposits.getAddress()] }]);
    if (runId !== state.runId) return;
    for (const raw of logs) {
      const log = { transactionHash: raw.transactionHash, index: Number(raw.logIndex), blockNumber: Number(raw.blockNumber) };
      if (raw.address.toLowerCase() === state.contractAddress.toLowerCase()) {
        const parsed = swap.interface.parseLog(raw);
      if (parsed?.name === 'SwapExecuted') recordChainEvent('SwapExecuted', log, `${formatUnits(parsed.args.mmfIn, 2)} tMMF → ${formatUnits(parsed.args.depositsOut, 2)} wCBDC`);
      if (parsed?.name === 'AssetSwapExecuted') {
        const tokenAddress = parsed.args.assetToken.toLowerCase();
        const asset = tokenAddress === (await governmentBonds.getAddress()).toLowerCase() ? 'tGOVBOND' : tokenAddress === (await corporateBonds.getAddress()).toLowerCase() ? 'tCORPBOND' : 'USDC';
        recordChainEvent('AssetSwapExecuted', log, `${formatUnits(parsed.args.assetIn, 2)} ${asset} → ${formatUnits(parsed.args.depositsOut, 2)} wCBDC`);
      }
      } else {
        const parsed = deposits.interface.parseLog(raw);
        if (parsed?.name !== 'Transfer') continue;
        const payer = banks.find(bank => bank.address.toLowerCase() === parsed.args[0].toLowerCase());
        const receiver = banks.find(bank => bank.address.toLowerCase() === parsed.args[1].toLowerCase());
        if (payer && receiver) recordChainEvent('Transfer', log, `${payer.name} → ${receiver.name} · ${formatUnits(parsed.args[2], 2)} wCBDC`);
      }
    }
    eventCursor = latest;
  } finally { scanningEvents = false; }
}
const fmt = n => Math.round(n).toLocaleString('en-HK');
const minor = value => Number(parseUnits(Number(value).toFixed(2), 2));
function seedLedgerOpeningBalances() {
  const entries = [];
  for (const bank of banks) {
    entries.push({ account: bank.id, asset: 'wCBDC', side: 'DEBIT', amountMinor: minor(bank.initialCash) });
    entries.push({ account: bank.id, asset: 'tMMF', side: 'DEBIT', amountMinor: minor(bank.initialMmf) });
    entries.push({ account: bank.id, asset: 'tGOVBOND', side: 'DEBIT', amountMinor: minor(bank.initialGovBonds) });
    entries.push({ account: bank.id, asset: 'tCORPBOND', side: 'DEBIT', amountMinor: minor(bank.initialCorpBonds) });
    entries.push({ account: bank.id, asset: 'USDC', side: 'DEBIT', amountMinor: minor(bank.initialStablecoin) });
  }
  entries.push({ account: 'liquidity-facility', asset: 'wCBDC', side: 'DEBIT', amountMinor: minor(10_000_000) });
  const opening = new Map();
  for (const entry of entries) opening.set(entry.asset, (opening.get(entry.asset) || 0) + entry.amountMinor);
  for (const [asset, amountMinor] of opening) entries.push({ account: 'opening-equity', asset, side: 'CREDIT', amountMinor });
  recordLedgerEvent(ledgerDb, { key: `${state.runId}:opening`, type: 'OPENING_BALANCE', details: { chainId: state.chainId }, entries });
}
function postLedgerEvent(event) {
  try { enqueueLedgerEvent(ledgerDb, state.runId, event); }
  catch (error) {
    if (!state.pendingLedgerEvents.some(item => item.key === event.key)) state.pendingLedgerEvents.push(event);
    emit({ type: 'ledger-sync-error', message: error.message, pending: state.pendingLedgerEvents.length + pendingLedgerCount(ledgerDb, state.runId) });
    return false;
  }
  if (!state.ledgerConnected) {
    emit({ type: 'ledger-sync-error', message: 'Ledger link is paused', pending: pendingLedgerCount(ledgerDb, state.runId) });
    return false;
  }
  try {
    recordLedgerEvent(ledgerDb, event);
    markLedgerEventProjected(ledgerDb, event.key);
    emit({ type: 'ledger', ledger: ledgerSnapshot(ledgerDb, 20, state.runId) });
    return true;
  } catch (error) {
    if (!state.pendingLedgerEvents.some(item => item.key === event.key)) state.pendingLedgerEvents.push(event);
    emit({ type: 'ledger-sync-error', message: error.message, pending: state.pendingLedgerEvents.length });
    return false;
  }
}
function replayPendingLedgerEvents() {
  const remaining = () => pendingLedgerCount(ledgerDb) + state.pendingLedgerEvents.length;
  if (!state.ledgerConnected) return { replayed: false, remaining: remaining(), error: 'Ledger link is paused' };
  for (const event of state.pendingLedgerEvents) {
    try { enqueueLedgerEvent(ledgerDb, state.runId, event); }
    catch (error) { return { replayed: 0, remaining: remaining(), error: error.message }; }
  }
  state.pendingLedgerEvents = [];
  let replayed = 0;
  for (const event of pendingLedgerEvents(ledgerDb)) {
    try { recordLedgerEvent(ledgerDb, event); markLedgerEventProjected(ledgerDb, event.key); replayed++; }
    catch (error) { return { replayed, remaining: remaining(), error: error.message }; }
  }
  emit({ type: 'ledger', ledger: ledgerSnapshot(ledgerDb, 20, state.runId) });
  return { replayed, remaining: remaining() };
}
function pendingRunLedgerCount() { return pendingLedgerCount(ledgerDb, state.runId) + state.pendingLedgerEvents.length; }
async function chainAccountBalances() {
  const accounts = [];
  for (const bank of banks) {
    accounts.push({ account: bank.id, asset: 'wCBDC', amountMinor: Number(await deposits.balanceOf(bank.address)) });
    accounts.push({ account: bank.id, asset: 'tMMF', amountMinor: Number(await mmf.balanceOf(bank.address)) });
    accounts.push({ account: bank.id, asset: 'tGOVBOND', amountMinor: Number(await governmentBonds.balanceOf(bank.address)) });
    accounts.push({ account: bank.id, asset: 'tCORPBOND', amountMinor: Number(await corporateBonds.balanceOf(bank.address)) });
    accounts.push({ account: bank.id, asset: 'USDC', amountMinor: Number(await stablecoin.balanceOf(bank.address)) });
  }
  accounts.push({ account: 'liquidity-facility', asset: 'wCBDC', amountMinor: Number(await deposits.balanceOf(counterpartyAddress)) });
  accounts.push({ account: 'liquidity-facility', asset: 'tMMF', amountMinor: Number(await mmf.balanceOf(counterpartyAddress)) });
  accounts.push({ account: 'liquidity-facility', asset: 'tGOVBOND', amountMinor: Number(await governmentBonds.balanceOf(counterpartyAddress)) });
  accounts.push({ account: 'liquidity-facility', asset: 'tCORPBOND', amountMinor: Number(await corporateBonds.balanceOf(counterpartyAddress)) });
  accounts.push({ account: 'liquidity-facility', asset: 'USDC', amountMinor: Number(await stablecoin.balanceOf(counterpartyAddress)) });
  return accounts;
}
async function refreshBankBalances() {
  for (const bank of banks) state.bankBalances[bank.id] = { cash: Number(formatUnits(await deposits.balanceOf(bank.address), 2)), mmf: Number(formatUnits(await mmf.balanceOf(bank.address), 2)), governmentBonds: Number(formatUnits(await governmentBonds.balanceOf(bank.address), 2)), corporateBonds: Number(formatUnits(await corporateBonds.balanceOf(bank.address), 2)), stablecoin: Number(formatUnits(await stablecoin.balanceOf(bank.address), 2)), address: bank.address };
  for (const bank of banks) { const position = state.bankBalances[bank.id]; position.total = position.cash + position.mmf + position.governmentBonds + position.corporateBonds + position.stablecoin * usdHkdRate; }
}
function balances(bank = banks[0]) { const position = state.bankBalances[bank.id] || { cash: bank.initialCash, mmf: bank.initialMmf, governmentBonds: bank.initialGovBonds, corporateBonds: bank.initialCorpBonds, stablecoin: bank.initialStablecoin }; return { cash: position.cash, mmf: position.mmf, governmentBonds: position.governmentBonds, corporateBonds: position.corporateBonds, stablecoin: position.stablecoin, total: position.cash + position.mmf + position.governmentBonds + position.corporateBonds + position.stablecoin * usdHkdRate }; }
function addAudit(kind, text, hash = '') { const row = { time: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Hong_Kong', hour12: false }), kind, text, hash }; state.audit.unshift(row); state.audit = state.audit.slice(0, 30); emit({ type: 'audit', audit: row }); }
function emit(data) { const payload = `data: ${JSON.stringify(data)}\n\n`; for (const response of state.listeners) response.write(payload); }
function snapshot(selectedBank = banks[0]) { rollingVolume(); return { chainEvents, balances: balances(selectedBank), selectedBank: selectedBank.id, banks: banks.map(bank => ({ id: bank.id, name: bank.name, short: bank.short, address: bank.address, ...(state.bankBalances[bank.id] || {}) })), reserveBacking: { locked: state.reserveLocked, wCBDCSupply: state.wCBDCSupply, coverage: state.wCBDCSupply ? state.reserveLocked / state.wCBDCSupply : 0 }, rtgs: { open: state.rtgsOpen, businessHours: '09:00–18:00 HKT', pendingNetBanks: Object.keys(state.offHoursNet).length, batches: state.rtgsBatches }, ledger: { ...ledgerSnapshot(ledgerDb, 20, state.runId), pendingReplay: pendingRunLedgerCount(), connected: state.ledgerConnected }, benchmark: benchmarkSnapshot(), runId: state.runId, halted: state.halted, requests: state.requests, audit: state.audit, block: state.block, policy: { tradeLimit: state.tradeLimit, dailyLimit: state.dailyLimit, haircut: state.haircut * 100 }, market: { usdHkdRate, quoteType: 'SIMULATED' }, chain: { chainId: state.chainId, contractAddress: state.contractAddress, settlementAsset: 'wCBDC' }, accounts: { treasury: treasuryAddress, liquidityProvider: counterpartyAddress, centralBank: centralBankAddress }, dailyVolume: state.dailyVolume }; }
function evaluatePayment(input) {
  rollingVolume();
  const amount = Number(input.amount), cpName = String(input.counterparty || '');
  const fromBank = banks.find(bank => bank.id === input.fromBank) || banks[0];
  const toBank = banks.find(bank => bank.id === input.toBank);
  const payerBalances = balances(fromBank), recipient = toBank?.address || '';
  const fundingAsset = ['tMMF', 'tGOVBOND', 'tCORPBOND', 'USDC'].includes(input.fundingAsset) ? input.fundingAsset : 'tMMF';
  const assetBalance = ({ tMMF: payerBalances.mmf, tGOVBOND: payerBalances.governmentBonds, tCORPBOND: payerBalances.corporateBonds, USDC: payerBalances.stablecoin })[fundingAsset];
  const fundingRate = fundingAsset === 'USDC' ? usdHkdRate : 1;
  const quoteOutput = Number(input.quoteOutput || Math.max(0, amount - payerBalances.cash));
  const minOutput = Number(input.minOutput ?? quoteOutput), validitySeconds = Number(input.validitySeconds || 60);
  const cashNeeded = Math.max(0, amount - payerBalances.cash);
  const assetInput = cashNeeded ? Math.ceil(quoteOutput / (fundingRate * (1 - state.haircut)) * 100 - 1e-8) / 100 : 0;
  const checks = [
    { name: 'Emergency halt is off', passed: !state.halted, reason: 'Emergency halt active' },
    { name: 'Positive payment amount', passed: Number.isFinite(amount) && amount > 0, reason: 'Amount must be greater than zero' },
    { name: 'Per-trade limit', passed: amount <= state.tradeLimit, reason: `Maximum is HKD ${fmt(state.tradeLimit)}` },
    { name: 'Rolling 24-hour limit', passed: state.dailyVolume + amount <= state.dailyLimit, reason: `Remaining capacity is HKD ${fmt(Math.max(0, state.dailyLimit - state.dailyVolume))}` },
    { name: 'Counterparty allowlist', passed: counterparties.includes(cpName) || input.manualApproval === true, reason: input.manualApproval ? 'Approved by manual reviewer' : 'Counterparty is not allowlisted' },
    { name: 'Interbank route', passed: Boolean(banks.some(bank => bank.id === input.fromBank) && toBank && toBank.id !== fromBank.id), reason: 'Select two different participating banks' },
    { name: 'Quote output covers cash gap', passed: Number.isFinite(quoteOutput) && quoteOutput >= cashNeeded, reason: `Required output is at least HKD ${fmt(cashNeeded)}` },
    { name: 'Minimum output within quote', passed: Number.isFinite(minOutput) && minOutput >= 0 && minOutput <= quoteOutput, reason: 'Minimum output must not exceed quoted output' },
    { name: 'Quote expiry window', passed: Number.isInteger(validitySeconds) && validitySeconds >= 5 && validitySeconds <= 3600, reason: 'Validity must be 5 to 3,600 seconds' },
    { name: 'Haircut-adjusted liquidity', passed: amount <= payerBalances.cash + assetBalance * fundingRate * (1 - state.haircut) && (!cashNeeded || quoteOutput <= assetBalance * fundingRate * (1 - state.haircut)), reason: `Insufficient ${fundingAsset} liquidity after FX and haircut` }
  ];
  let result = 'Approved', reason = 'All policy checks passed';
  if (state.halted) [result, reason] = ['Rejected', 'Emergency halt active'];
  else if (!Number.isFinite(amount) || amount <= 0) [result, reason] = ['Rejected', 'Invalid payment amount'];
  else if (amount > state.tradeLimit) [result, reason] = ['Rejected', 'Per-trade limit exceeded'];
  else if (state.dailyVolume + amount > state.dailyLimit) [result, reason] = ['Rejected', 'Rolling 24h limit exceeded'];
  else if (!counterparties.includes(cpName) && input.manualApproval !== true) [result, reason] = ['Manual review', 'Counterparty is not allowlisted'];
  else if (cpName === 'Eastbridge Clearing') [result, reason] = ['Manual review', 'Counterparty requires secondary approval'];
  else if (!toBank || toBank.id === fromBank.id) [result, reason] = ['Rejected', 'Choose different sending and receiving banks'];
  else if (quoteOutput < cashNeeded || minOutput > quoteOutput || minOutput < 0) [result, reason] = ['Rejected', 'Quote output or minimum output is invalid'];
  else if (validitySeconds < 5 || validitySeconds > 3600) [result, reason] = ['Rejected', 'Quote validity must be 5 to 3,600 seconds'];
  else if (amount > payerBalances.cash + assetBalance * fundingRate * (1 - state.haircut)) [result, reason] = ['Rejected', `Insufficient ${fundingAsset} liquidity after FX and haircut`];
  else if (checks.some(check => !check.passed)) [result, reason] = ['Rejected', 'One or more policy checks failed'];
  return { amount, cpName, recipient, fromBank, toBank, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds, cashNeeded, checks, result, reason };
}
async function executeLiquiditySwap({ bank, requestId, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds }) {
  const inputAmount = parseUnits(assetInput.toFixed(2), 2), output = parseUnits(quoteOutput.toFixed(2), 2), minimum = parseUnits(minOutput.toFixed(2), 2);
  const deadline = Math.floor(Date.now() / 1000) + validitySeconds;
  const token = fundingAsset === 'tGOVBOND' ? governmentBonds : fundingAsset === 'tCORPBOND' ? corporateBonds : stablecoin;
  const tx = fundingAsset === 'tMMF'
    ? await swap.connect(bank.signer).swap(requestId, counterpartyAddress, inputAmount, output, minimum, deadline)
    : await swap.connect(bank.signer).swapAsset(requestId, await token.getAddress(), counterpartyAddress, inputAmount, output, minimum, deadline);
  return { receipt: await tx.wait(), inputAmount };
}
function swapLedgerEntries(bankId, fundingAsset, inputAmount, output) {
  return [
    { account: bankId, asset: fundingAsset, side: 'CREDIT', amountMinor: Number(inputAmount) },
    { account: 'liquidity-facility', asset: fundingAsset, side: 'DEBIT', amountMinor: Number(inputAmount) },
    { account: bankId, asset: 'wCBDC', side: 'DEBIT', amountMinor: Number(output) },
    { account: 'liquidity-facility', asset: 'wCBDC', side: 'CREDIT', amountMinor: Number(output) }
  ];
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); state.listeners.add(res); res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot() })}\n\n`); req.on('close', () => state.listeners.delete(res)); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/state') { res.end(JSON.stringify(snapshot())); return; }
    if (req.method === 'GET' && url.pathname === '/api/ledger') { res.end(JSON.stringify({ ...ledgerSnapshot(ledgerDb, 50, state.runId), pendingReplay: pendingRunLedgerCount(), connected: state.ledgerConnected })); return; }
    if (req.method === 'POST' && url.pathname === '/api/ledger/replay') { const result = replayPendingLedgerEvents(); res.end(JSON.stringify(result)); return; }
    if (req.method === 'GET' && url.pathname === '/api/ledger/reconcile') { res.end(JSON.stringify(reconcileLedger(ledgerDb, await chainAccountBalances(), state.runId))); return; }
    if (req.method === 'GET' && url.pathname === '/api/benchmark') { res.end(JSON.stringify(benchmarkSnapshot())); return; }
    if (req.method === 'POST' && url.pathname === '/api/benchmark/run') {
      let body = ''; for await (const chunk of req) body += chunk;
      let options = {}; try { if (body) options = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid benchmark options' })); return; }
      const repetitions = Math.max(1, Math.min(30, Math.floor(Number(options.repetitions) || 5)));
      const requestCount = Math.max(10, Math.min(100, Math.floor(Number(options.requestCount) || 20)));
      benchmarkReport = runBenchmark({ repetitions, requestCount });
      await writeFile(benchmarkPath, JSON.stringify(benchmarkReport, null, 2), 'utf8');
      addAudit('good', `Paired benchmark completed · ${benchmarkReport.cells.length} allocation/scenario cells · ${repetitions} matched runs each`);
      const data = snapshot(); emit({ type: 'state', data });
      res.end(JSON.stringify({ benchmark: benchmarkSnapshot(), resultsFile: 'runtime/benchmark-results.json' })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ledger/disconnect') { state.ledgerConnected = false; emit({ type: 'state', data: snapshot() }); res.end(JSON.stringify(snapshot())); return; }
    if (req.method === 'POST' && url.pathname === '/api/ledger/reconnect') { state.ledgerConnected = true; const replay = replayPendingLedgerEvents(); const reconciliation = await reconcileLedger(ledgerDb, await chainAccountBalances(), state.runId); const data = snapshot(); emit({ type: 'state', data }); res.end(JSON.stringify({ ...data, replay, reconciliation })); return; }
    if (req.method === 'GET' && url.pathname === '/api/state/bank') { const bank = banks.find(item => item.id === url.searchParams.get('id')) || banks[0]; res.end(JSON.stringify(snapshot(bank))); return; }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const reverted = await provider.send('evm_revert', [initialChainSnapshot]);
      if (!reverted) throw new Error('Could not restore the initial local-chain snapshot');
      initialChainSnapshot = await provider.send('evm_snapshot', []);
      treasury.reset(); counterparty.reset(); for (const bank of banks) bank.signer.reset();
      state.requests = []; state.audit = []; state.pendingLedgerEvents = []; state.ledgerConnected = true; state.halted = false; state.dailyVolume = 0; volumeHistory = []; chainEvents = [];
      state.rtgsOpen = true; state.offHoursNet = {}; state.rtgsBatches = [];
      state.dailyLimit = 5_000_000; state.tradeLimit = 2_000_000; state.haircut = 0.05; state.serial = 1008;
      ledgerDb.exec('DELETE FROM ledger_entries; DELETE FROM ledger_events; DELETE FROM ledger_inbox'); state.runId = randomUUID();
      await refreshBankBalances(); const initialBalances = balances(banks[0]); state.cash = initialBalances.cash; state.mmf = initialBalances.mmf;
      state.block = Number(await provider.send('eth_blockNumber', [])); eventCursor = state.block;
      seedLedgerOpeningBalances();
      const data = snapshot(); emit({ type: 'reset', data }); res.end(JSON.stringify(data)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/evaluate') {
      let body = ''; for await (const chunk of req) body += chunk;
      let input; try { input = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      const evaluation = evaluatePayment(input);
      res.end(JSON.stringify({ result: evaluation.result, reason: evaluation.reason, checks: evaluation.checks })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/payment') {
      let body = ''; for await (const chunk of req) body += chunk;
      let input; try { input = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      const evaluation = evaluatePayment(input);
      const { amount, cpName, recipient, fromBank, toBank, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds, cashNeeded, checks } = evaluation;
      state.serial++;
      const idText = `ABL-${String(state.serial).padStart(5, '0')}`, chainRequestId = id(idText);
      const { result, reason } = evaluation;
      const request = { id: idText, chainRequestId, time: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Hong_Kong', hour12: false }), from: fromBank.address, to: recipient, fromBank: fromBank.id, fromBankName: fromBank.name, toBank: toBank?.id, toBankName: toBank?.name, counterparty: cpName, amount, cashGap: cashNeeded, fundingAsset, assetInput, quoteOutput, minOutput, trigger: 'Interbank payment', result, checks, status: result === 'Approved' ? 'Pending' : result === 'Manual review' ? 'Review required' : 'Rejected', swapTxHash: '', txHash: '', reason };
      request.fundingRate = fundingAsset === 'USDC' ? usdHkdRate : 1; request.haircutPct = state.haircut * 100;
      state.requests.unshift(request); state.requests = state.requests.slice(0, 50); emit({ type: 'request', request });
      if (result === 'Approved') {
        try {
          const cashNeeded = Math.max(0, amount - balances(fromBank).cash);
          if (cashNeeded > 0) {
            const { receipt, inputAmount } = await executeLiquiditySwap({ bank: fromBank, requestId: chainRequestId, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds });
            request.swapTxHash = receipt.hash; state.block = receipt.blockNumber;
            request.ledgerSwapStatus = postLedgerEvent({ key: `${state.runId}:${idText}:swap`, type: 'DVP_SWAP', requestId: idText, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, details: { payer: fromBank.id, facility: 'liquidity-facility', fundingAsset }, entries: swapLedgerEntries(fromBank.id, fundingAsset, inputAmount, parseUnits(quoteOutput.toFixed(2), 2)) });
            await refreshBankBalances(); const payerPosition = balances(fromBank); state.cash = payerPosition.cash; state.mmf = payerPosition.mmf;
            addAudit('good', `Atomic DvP confirmed · ${idText} · ${fmt(cashNeeded)} HKD liquidity raised`, receipt.hash);
          }
          const payment = await deposits.connect(fromBank.signer).transfer(recipient, parseUnits(amount.toFixed(2), 2));
          const paymentReceipt = await payment.wait(); state.block = paymentReceipt.blockNumber; request.status = 'Executed'; request.txHash = paymentReceipt.hash;
          volumeHistory.push({ time: Date.now(), amount }); rollingVolume();
          request.ledgerPaymentStatus = postLedgerEvent({ key: `${state.runId}:${idText}:payment`, type: 'INTERBANK_PAYMENT', requestId: idText, transactionHash: paymentReceipt.hash, blockNumber: paymentReceipt.blockNumber, details: { payer: fromBank.id, beneficiary: toBank.id }, entries: [
            { account: fromBank.id, asset: 'wCBDC', side: 'CREDIT', amountMinor: minor(amount) },
            { account: toBank.id, asset: 'wCBDC', side: 'DEBIT', amountMinor: minor(amount) }
          ] });
          await refreshBankBalances(); const payerPosition = balances(fromBank); state.cash = payerPosition.cash; state.mmf = payerPosition.mmf;
          if (!state.rtgsOpen) {
            state.offHoursNet[fromBank.id] = (state.offHoursNet[fromBank.id] || 0) - amount;
            state.offHoursNet[toBank.id] = (state.offHoursNet[toBank.id] || 0) + amount;
            request.settlementWindow = 'OFF-HOURS · wCBDC';
          } else request.settlementWindow = 'RTGS OPEN · wCBDC';
          emit({ type: 'payment-settled', request, balances: payerPosition, bankBalances: state.bankBalances, block: state.block });
          addAudit('good', `Payment settled · ${idText} · ${fmt(amount)} HKD`, paymentReceipt.hash);
        } catch (error) { request.status = 'Rejected'; request.result = 'Execution failed'; request.reason = error.shortMessage || error.message; res.writeHead(500); res.end(JSON.stringify({ request, error: request.reason })); return; }
      } else addAudit(result === 'Manual review' ? 'warning' : 'danger', `${result === 'Manual review' ? 'Escalated to treasury' : 'Request rejected'} · ${idText} · ${reason}`);
      res.end(JSON.stringify({ request, state: snapshot(fromBank) })); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/review/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const { decision } = JSON.parse(body);
      const request = state.requests.find(item => item.id === decodeURIComponent(url.pathname.split('/').pop()));
      if (!request || request.status !== 'Review required') { res.writeHead(404); res.end(JSON.stringify({ error: 'Review request is no longer pending' })); return; }
      if (decision === 'reject') {
        request.status = 'Rejected'; request.result = 'Rejected by reviewer'; request.reason = 'Rejected during manual review'; request.reviewedAt = new Date().toISOString();
        addAudit('danger', `Manual review rejected · ${request.id} · ${request.reason}`); emit({ type: 'state', data: snapshot(banks.find(bank => bank.id === request.fromBank)) }); res.end(JSON.stringify({ request, state: snapshot(banks.find(bank => bank.id === request.fromBank)) })); return;
      }
      if (decision !== 'pass') { res.writeHead(400); res.end(JSON.stringify({ error: 'Decision must be pass or reject' })); return; }
      const payer = banks.find(bank => bank.id === request.fromBank), payee = banks.find(bank => bank.id === request.toBank);
      const input = { amount: request.amount, fromBank: request.fromBank, toBank: request.toBank, counterparty: request.counterparty, fundingAsset: request.fundingAsset, quoteOutput: request.quoteOutput, minOutput: request.minOutput, validitySeconds: 60, manualApproval: true };
      const evaluation = evaluatePayment(input);
      request.checks = evaluation.checks; request.reviewedAt = new Date().toISOString(); request.reviewDecision = 'Pass';
      if (evaluation.result !== 'Approved') {
        request.status = evaluation.result === 'Manual review' ? 'Review required' : 'Rejected'; request.result = evaluation.result; request.reason = evaluation.reason;
        addAudit('warning', `Manual approval blocked by policy · ${request.id} · ${request.reason}`); const data = snapshot(payer); emit({ type: 'state', data }); res.end(JSON.stringify({ request, state: data })); return;
      }
      try {
        const { amount, cashNeeded, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds } = evaluation; request.result = 'Approved'; request.assetInput = assetInput; request.fundingRate = fundingAsset === 'USDC' ? usdHkdRate : 1; request.haircutPct = state.haircut * 100;
        if (cashNeeded > 0) {
          const { receipt, inputAmount } = await executeLiquiditySwap({ bank: payer, requestId: request.chainRequestId, fundingAsset, assetInput, quoteOutput, minOutput, validitySeconds });
          request.swapTxHash = receipt.hash; state.block = receipt.blockNumber;
          request.ledgerSwapStatus = postLedgerEvent({ key: `${state.runId}:${request.id}:swap`, type: 'DVP_SWAP', requestId: request.id, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, details: { payer: payer.id, facility: 'liquidity-facility', manualApproval: true, fundingAsset }, entries: swapLedgerEntries(payer.id, fundingAsset, inputAmount, parseUnits(quoteOutput.toFixed(2), 2)) });
        }
        const receipt = await (await deposits.connect(payer.signer).transfer(payee.address, parseUnits(amount.toFixed(2), 2))).wait();
        request.status = 'Executed'; request.txHash = receipt.hash; request.reason = 'Approved by reviewer; policy checks passed'; request.ledgerPaymentStatus = postLedgerEvent({ key: `${state.runId}:${request.id}:payment`, type: 'INTERBANK_PAYMENT', requestId: request.id, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, details: { payer: payer.id, beneficiary: payee.id, manualApproval: true }, entries: [
          { account: payer.id, asset: 'wCBDC', side: 'CREDIT', amountMinor: minor(amount) }, { account: payee.id, asset: 'wCBDC', side: 'DEBIT', amountMinor: minor(amount) }
        ] });
        volumeHistory.push({ time: Date.now(), amount }); rollingVolume(); state.block = receipt.blockNumber; await refreshBankBalances();
        const data = snapshot(payer); emit({ type: 'payment-settled', request, balances: data.balances, bankBalances: data.banks, block: state.block }); addAudit('good', `Manual review passed · ${request.id} · payment settled`, receipt.hash); res.end(JSON.stringify({ request, state: data }));
      } catch (error) { request.status = 'Rejected'; request.result = 'Execution failed'; request.reason = error.shortMessage || error.message; res.writeHead(500); res.end(JSON.stringify({ request, error: request.reason })); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/halt') { const receipt = await (await swap.setHalted(!state.halted)).wait(); state.halted = await swap.halted(); state.block = receipt.blockNumber; addAudit(state.halted ? 'danger' : 'good', state.halted ? 'Emergency halt activated · contract confirmed' : 'Autonomous execution resumed · contract confirmed', receipt.hash); emit({ type: 'state', data: snapshot() }); res.end(JSON.stringify(snapshot())); return; }
    if (req.method === 'POST' && url.pathname === '/api/policy') { let body = ''; for await (const chunk of req) body += chunk; const p = JSON.parse(body); if (p.tradeLimit > 0 && p.dailyLimit >= p.tradeLimit && p.haircut >= 0 && p.haircut <= 20) { state.tradeLimit = p.tradeLimit; state.dailyLimit = p.dailyLimit; state.haircut = p.haircut / 100; } addAudit('good', 'Policy parameters updated · ALCO-2026.11'); res.end(JSON.stringify(snapshot())); return; }
    if (req.method === 'POST' && url.pathname === '/api/rtgs/close') { state.rtgsOpen = false; addAudit('warning', 'RTGS window closed · off-hours obligations settle on wCBDC rail'); const data = snapshot(); emit({ type: 'state', data }); res.end(JSON.stringify(data)); return; }
    if (req.method === 'POST' && url.pathname === '/api/rtgs/open') {
      state.rtgsOpen = true;
      const netPositions = banks.map(bank => ({ bankId: bank.id, bank: bank.name, netCredit: Number((state.offHoursNet[bank.id] || 0).toFixed(2)) })).filter(item => Math.abs(item.netCredit) >= 0.01);
      const credits = netPositions.filter(item => item.netCredit > 0);
      const batch = { batchId: `RTGS-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`, messageType: 'pacs.009.001.08', createdAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong' }), settlementAsset: 'HKD central-bank reserve ledger (simulated)', netPositions, messages: credits.map((item, index) => ({ messageId: `${state.serial}-${index + 1}`, creditorBank: item.bank, amount: item.netCredit, currency: 'HKD', status: 'SIMULATED RECONCILIATION' })) };
      if (netPositions.length) { state.rtgsBatches.unshift(batch); state.rtgsBatches = state.rtgsBatches.slice(0, 10); state.offHoursNet = {}; postLedgerEvent({ key: `${state.runId}:${batch.batchId}`, type: 'RTGS_BATCH', details: { messageType: batch.messageType, netPositions: batch.netPositions, messages: batch.messages }, entries: [] }); addAudit('good', `RTGS reopening batch generated · ${batch.batchId} · pacs.009 · ${batch.messages.length} net credit messages`); }
      else addAudit('good', 'RTGS window opened · no off-hours net obligations to reconcile');
      const data = snapshot(); emit({ type: 'state', data }); res.end(JSON.stringify(data)); return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }
  const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  try { const content = await readFile(path.join(root, file)); const ext = path.extname(file); res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[ext] || 'application/octet-stream' }); res.end(content); } catch { res.writeHead(404); res.end('Not found'); }
}

await startChain();
let mutations = Promise.resolve();
http.createServer((req, res) => {
  const run = () => handle(req, res).catch(error => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); });
  if (req.method === 'POST') mutations = mutations.then(run); else void run();
}).listen(port, '0.0.0.0', () => console.log(`ABLE dashboard: http://0.0.0.0:${port} (chain ${state.chainId}, contract ${state.contractAddress})`));
