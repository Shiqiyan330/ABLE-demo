import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { enqueueLedgerEvent, initializeLedger, ledgerSnapshot, markLedgerEventProjected, pendingLedgerCount, pendingLedgerEvents, recordLedgerEvent, reconcileLedger } from '../shadow-ledger.js';

function database() {
  const db = new DatabaseSync(':memory:');
  initializeLedger(db);
  return db;
}

const balancedEvent = {
  key: 'run:request:payment', type: 'PAYMENT', requestId: 'request', transactionHash: '0xabc', blockNumber: 12,
  entries: [
    { account: 'bank-a', asset: 'wCBDC', side: 'CREDIT', amountMinor: 12345 },
    { account: 'bank-b', asset: 'wCBDC', side: 'DEBIT', amountMinor: 12345 }
  ]
};

test('ledger rejects unbalanced postings before writing an event', () => {
  const db = database();
  assert.throws(() => recordLedgerEvent(db, { ...balancedEvent, entries: balancedEvent.entries.slice(0, 1) }), /Unbalanced wCBDC/);
  assert.equal(ledgerSnapshot(db).events.length, 0);
  db.close();
});

test('legacy floating-point ledger rows migrate to integer minor units', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ledger_events (event_key TEXT PRIMARY KEY,event_type TEXT NOT NULL,request_id TEXT,transaction_hash TEXT,block_number INTEGER,created_at TEXT NOT NULL,details TEXT NOT NULL);
    CREATE TABLE ledger_entries (event_key TEXT NOT NULL REFERENCES ledger_events(event_key),line_no INTEGER NOT NULL,account TEXT NOT NULL,asset TEXT NOT NULL,side TEXT NOT NULL,amount REAL NOT NULL,PRIMARY KEY(event_key,line_no));
    INSERT INTO ledger_events VALUES ('old:opening','OPENING',NULL,NULL,NULL,'2026-01-01T00:00:00Z','{}');
    INSERT INTO ledger_entries VALUES ('old:opening',1,'bank-a','wCBDC','DEBIT',123.45);`);
  initializeLedger(db);
  const migrated = db.prepare('SELECT amount_minor FROM ledger_entries').get();
  assert.equal(migrated.amount_minor, 12345);
  db.close();
});

test('duplicate event delivery posts entries only once', () => {
  const db = database();
  assert.equal(recordLedgerEvent(db, balancedEvent), true);
  assert.equal(recordLedgerEvent(db, balancedEvent), false);
  const ledger = ledgerSnapshot(db);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].entries.length, 2);
  assert.equal(ledger.balanced, true);
  db.close();
});

test('durable inbox deduplicates delivery and tracks projection state', () => {
  const db = database();
  assert.equal(enqueueLedgerEvent(db, 'run', balancedEvent), true);
  assert.equal(enqueueLedgerEvent(db, 'run', balancedEvent), false);
  assert.equal(pendingLedgerCount(db, 'run'), 1);
  assert.equal(pendingLedgerEvents(db, 'run')[0].key, balancedEvent.key);
  recordLedgerEvent(db, balancedEvent);
  markLedgerEventProjected(db, balancedEvent.key);
  assert.equal(pendingLedgerCount(db, 'run'), 0);
  assert.equal(ledgerSnapshot(db).events.length, 1);
  db.close();
});

test('pending inbox events survive database close and reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'able-ledger-'));
  const databasePath = path.join(directory, `${randomUUID()}.sqlite`);
  try {
    const first = new DatabaseSync(databasePath);
    initializeLedger(first);
    enqueueLedgerEvent(first, 'run', balancedEvent);
    first.close();
    const reopened = new DatabaseSync(databasePath);
    initializeLedger(reopened);
    assert.equal(pendingLedgerCount(reopened, 'run'), 1);
    assert.equal(pendingLedgerEvents(reopened, 'run')[0].key, balancedEvent.key);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconciliation reports chain-to-ledger account differences', () => {
  const db = database();
  recordLedgerEvent(db, { key: 'run:opening', type: 'OPENING', entries: [
    { account: 'bank-a', asset: 'wCBDC', side: 'DEBIT', amountMinor: 10000 },
    { account: 'opening-equity', asset: 'wCBDC', side: 'CREDIT', amountMinor: 10000 },
    { account: 'liquidity-facility', asset: 'tMMF', side: 'DEBIT', amountMinor: 50000 },
    { account: 'opening-equity', asset: 'tMMF', side: 'CREDIT', amountMinor: 50000 }
  ] });
  recordLedgerEvent(db, { ...balancedEvent, entries: [
    { account: 'bank-a', asset: 'wCBDC', side: 'CREDIT', amountMinor: 3000 },
    { account: 'bank-b', asset: 'wCBDC', side: 'DEBIT', amountMinor: 3000 }
  ] });
  const matched = reconcileLedger(db, [
    { account: 'bank-a', asset: 'wCBDC', amountMinor: 7000 },
    { account: 'bank-b', asset: 'wCBDC', amountMinor: 3000 },
    { account: 'liquidity-facility', asset: 'tMMF', amountMinor: 50000 }
  ]);
  assert.equal(matched.matched, true);
  const mismatch = reconcileLedger(db, [
    { account: 'bank-a', asset: 'wCBDC', amountMinor: 7000 },
    { account: 'bank-b', asset: 'wCBDC', amountMinor: 3000 },
    { account: 'liquidity-facility', asset: 'tMMF', amountMinor: 49000 }
  ]);
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.differences[0].differenceMinor, -1000);
  db.close();
});
