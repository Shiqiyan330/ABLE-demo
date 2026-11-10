export function initializeLedger(db) {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS ledger_events (
      event_key TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      request_id TEXT,
      transaction_hash TEXT,
      block_number INTEGER,
      created_at TEXT NOT NULL,
      details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      event_key TEXT NOT NULL REFERENCES ledger_events(event_key),
      line_no INTEGER NOT NULL,
      account TEXT NOT NULL,
      asset TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      PRIMARY KEY(event_key, line_no)
    );
    CREATE TABLE IF NOT EXISTS ledger_inbox (
      event_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','PROJECTED')),
      received_at TEXT NOT NULL,
      projected_at TEXT
    );`);
  const columns = db.prepare('PRAGMA table_info(ledger_entries)').all().map(column => column.name);
  if (!columns.includes('amount_minor') && columns.includes('amount')) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE ledger_entries RENAME TO ledger_entries_legacy;
      CREATE TABLE ledger_entries (
        event_key TEXT NOT NULL REFERENCES ledger_events(event_key),
        line_no INTEGER NOT NULL,
        account TEXT NOT NULL,
        asset TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        PRIMARY KEY(event_key, line_no)
      );
      INSERT INTO ledger_entries(event_key,line_no,account,asset,side,amount_minor)
        SELECT event_key,line_no,account,asset,side,CAST(ROUND(amount * 100) AS INTEGER) FROM ledger_entries_legacy;
      DROP TABLE ledger_entries_legacy;
      COMMIT;`);
  }
}

export function enqueueLedgerEvent(db, runId, event) {
  const result = db.prepare(`INSERT OR IGNORE INTO ledger_inbox(event_key,run_id,payload,status,received_at)
    VALUES (?,?,?,'PENDING',?)`).run(event.key, runId, JSON.stringify(event), new Date().toISOString());
  return result.changes > 0;
}

export function pendingLedgerEvents(db, runId = null) {
  const rows = db.prepare(`SELECT payload FROM ledger_inbox WHERE status='PENDING' AND (? IS NULL OR run_id=?) ORDER BY rowid`).all(runId, runId);
  return rows.map(row => JSON.parse(row.payload));
}

export function pendingLedgerCount(db, runId = null) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ledger_inbox WHERE status='PENDING' AND (? IS NULL OR run_id=?)`).get(runId, runId).count;
}

export function markLedgerEventProjected(db, eventKey) {
  db.prepare(`UPDATE ledger_inbox SET status='PROJECTED',projected_at=? WHERE event_key=? AND status='PENDING'`)
    .run(new Date().toISOString(), eventKey);
}

export function recordLedgerEvent(db, event) {
  const totals = new Map();
  for (const entry of event.entries) {
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0) throw new Error('Ledger amounts must be positive safe integers in minor units');
    if (!['DEBIT', 'CREDIT'].includes(entry.side)) throw new Error('Ledger side must be DEBIT or CREDIT');
    const pair = totals.get(entry.asset) || { DEBIT: 0, CREDIT: 0 };
    pair[entry.side] += entry.amountMinor;
    totals.set(entry.asset, pair);
  }
  for (const [asset, pair] of totals) if (pair.DEBIT !== pair.CREDIT) throw new Error(`Unbalanced ${asset} ledger event`);

  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare(`INSERT OR IGNORE INTO ledger_events
      (event_key,event_type,request_id,transaction_hash,block_number,created_at,details)
      VALUES (?,?,?,?,?,?,?)`).run(event.key, event.type, event.requestId || null, event.transactionHash || null,
      event.blockNumber ?? null, event.createdAt || new Date().toISOString(), JSON.stringify(event.details || {}));
    if (inserted.changes === 0) {
      db.exec('ROLLBACK');
      return false;
    }
    const addEntry = db.prepare(`INSERT INTO ledger_entries
      (event_key,line_no,account,asset,side,amount_minor) VALUES (?,?,?,?,?,?)`);
    event.entries.forEach((entry, index) => addEntry.run(event.key, index + 1, entry.account, entry.asset, entry.side, entry.amountMinor));
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function ledgerSnapshot(db, limit = 20, runId = null) {
  const events = db.prepare(`SELECT e.*, COUNT(l.line_no) AS entry_count FROM ledger_events e
    LEFT JOIN ledger_entries l ON l.event_key=e.event_key WHERE (? IS NULL OR e.event_key LIKE ?)
    GROUP BY e.event_key ORDER BY e.rowid DESC LIMIT ?`).all(runId, runId ? `${runId}:%` : null, limit).map(event => ({
      ...event,
      details: JSON.parse(event.details),
      entries: db.prepare(`SELECT account,asset,side,amount_minor AS amountMinor FROM ledger_entries
        WHERE event_key=? ORDER BY line_no`).all(event.event_key)
    }));
  const filter = runId ? `${runId}:%` : null;
  const totals = db.prepare(`SELECT l.asset, SUM(CASE WHEN l.side='DEBIT' THEN l.amount_minor ELSE -l.amount_minor END) AS net_minor
    FROM ledger_entries l JOIN ledger_events e USING(event_key) WHERE (? IS NULL OR e.event_key LIKE ?)
    GROUP BY l.asset ORDER BY l.asset`).all(runId, filter);
  const imbalance = db.prepare(`SELECT e.event_key,l.asset,SUM(CASE WHEN l.side='DEBIT' THEN l.amount_minor ELSE -l.amount_minor END) AS net_minor
    FROM ledger_entries l JOIN ledger_events e USING(event_key) WHERE (? IS NULL OR e.event_key LIKE ?)
    GROUP BY e.event_key,l.asset HAVING net_minor != 0`).all(runId, filter);
  return { events, totals, balanced: imbalance.length === 0, unbalancedEvents: imbalance };
}

export function reconcileLedger(db, chainAccounts, runId = null) {
  const ledger = new Map(db.prepare(`SELECT account,asset,
    SUM(CASE WHEN l.side='DEBIT' THEN l.amount_minor ELSE -l.amount_minor END) AS amount_minor
    FROM ledger_entries l JOIN ledger_events e USING(event_key) WHERE l.account != 'opening-equity' AND (? IS NULL OR e.event_key LIKE ?)
    GROUP BY account,asset`).all(runId, runId ? `${runId}:%` : null).map(row => [`${row.account}:${row.asset}`, row.amount_minor]));
  const differences = [];
  const chain = new Map(chainAccounts.map(actual => [`${actual.account}:${actual.asset}`, actual]));
  const keys = new Set([...ledger.keys(), ...chain.keys()]);
  for (const key of keys) {
    const actual = chain.get(key) || { account: key.split(':')[0], asset: key.split(':')[1], amountMinor: 0 };
    const expected = ledger.get(key) || 0;
    if (expected !== actual.amountMinor) differences.push({ ...actual, ledgerAmountMinor: expected, differenceMinor: actual.amountMinor - expected });
  }
  return { matched: differences.length === 0, differences };
}

