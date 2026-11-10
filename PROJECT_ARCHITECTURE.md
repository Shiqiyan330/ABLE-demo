# ABLE Project Architecture

## 1. Architecture Goal

The supplied proposal is the target architecture. The current local prototype is a Node.js dashboard and application service backed by an in-memory Ganache EVM and Solidity contracts. It evaluates the deposit/MMF liquidity mechanism for multiple participant banks and includes a compact deterministic Legacy RTGS paired benchmark. A calibrated, proposal-scale evaluation remains future work.

The proposal's production-facing language is a target architecture, not a claim that the prototype connects to HKMA EnsembleTX, live bank ledgers, production oracles, HSMs, or real tokenized assets. The current prototype has no corresponding external adapters for these systems.

## 2. Scope Boundary

### Current implementation status

- Implemented: Node.js policy/payment service, local EVM, Solidity reserve-backed settlement token and atomic MMF/wCBDC swap, multi-bank dashboard, sequential policy checks, RTGS close/open simulation, SQLite shadow postings and durable inbox, account reconciliation, and temporary-disconnect/replay demonstration.
- Partial: haircut-adjusted funding and facility allowlist; quote timestamp, provider depth/availability, sanctions and market oracle checks are not modeled.
- Implemented as a compact model: matched-seed workload generator, cash-only Legacy RTGS comparator, four scenarios, and five KPI groups; model costs and latencies are assumptions, not live performance observations.
- Planned: proposal-scale statistical runs, independently calibrated cost/deadline distributions, and validated production data adapters.
- Planned production integration: bank event feeds, core ledger interfaces, permissioned asset identity, HSM keys, and WORM audit storage.

### Interbank settlement model

The prototype represents multiple participant banks with separate wallets and balance sheets. Each bank holds its own MMF position and a balance in a shared mock wCBDC token used for interbank settlement. A payment names a paying bank and a distinct receiving bank. The payer's MMF-to-wCBDC liquidity swap is atomic; the subsequent wCBDC transfer from payer bank to receiver bank is a separate chain transaction. This models participant separation and a common settlement asset, but does not model issuer-specific tokenized deposit liabilities or legal settlement finality.

The prototype issues shared mock wCBDC against aggregate mock reserve tokens at 1:1 and records bank-level off-hours net positions. Reopening creates a pacs.009-style preview and ledger audit event. Per-bank reserve earmarking, reserve release, validated ISO 20022 messages, and actual RTGS submission remain follow-on modules.

### Explicitly out of MVP scope

- Live EnsembleTX, CHATS, bank core, sanctions, or market-data connections.
- Production HSM/key custody, multi-source Chainlink feeds, WORM storage, and cross-chain routing.
- Stablecoins, bonds, equities, receivables, and repo execution as active simulated asset routes. Preserve extension points, but evaluate only deposits and MMFs.
- Claiming that the local prototype provides production-grade 2PC or legal settlement finality. The local ledger uses idempotent postings, a durable captured-event inbox, replay, and reconciliation; document the remaining event-capture and production-core gaps.

## 3. Target Logical Architecture

The following diagram describes the proposal-aligned target. The current dashboard and payment service implement only part of these boundaries; external event ingestion and production adapters are not present yet, and the benchmark remains a compact simulation model.

```text
                    +------------------------------+
                    | CLI / Treasury Dashboard     |
                    | balances, queue, limits, log |
                    +---------------+--------------+
                                    | commands / queries
                                    v
+------------------+    +----------+-----------+    +----------------------+
| Scenario & Event  |--->| Orchestrator /       |--->| Policy Guardrail      |
| Simulator         |    | Request State Machine|    | Engine               |
| payments, prices, |    +----------+-----------+    +----------+-----------+
| stress, clock     |               | approved                 | decision
+------------------+               v                           v
                         +----------+-----------+     +--------------------+
                         | Liquidity & Quote     |<--->| Policy Config /    |
                         | Engine                |     | Allowlist / Limits |
                         +----------+-----------+     +--------------------+
                                    | executable quote + signed intent
                                    v
                         +----------+-----------+
                         | Chain Adapter         |
                         | local EVM / simulator |
                         +----------+-----------+
                                    | SwapExecuted / reverted
                                    v
                         +----------+-----------+
                         | Event Consumer &     |
                         | Reconciliation       |
                         +-----+------------+----+
                               |            |
                       +-------v----+ +-----v----------------+
                       | SQLite     | | Audit / Metrics      |
                       | Shadow GL  | | JSONL + benchmark DB |
                       +------------+ +----------------------+

       Same workload / seed ---> Legacy RTGS Baseline ---> Baseline metrics
```

The execution adapter is the boundary around chain-specific behavior. The simulator and local EVM should expose the same narrow interface, so the policy engine and benchmark harness do not depend on a particular chain implementation.

## 4. Current and Planned Repository Layout

```text
Current implementation:
  server.js                 # API, policy checks, orchestration, local chain deployment
  shadow-ledger.js          # SQLite postings and reconciliation functions
  contracts/                # Solidity tokens and atomic swap
  index.html, app.js, *.css # dashboard and payment demo
  tests/                    # shadow-ledger unit tests
  runtime/                  # ignored SQLite ledger database

Planned logical modules:
  events/                   # deterministic workload and external event adapters
  orchestration/            # explicit request state machine and immutable intents
  liquidity/                # executable quotes, fees, depth and haircut calculations
  policy/                   # versioned rules, reason codes and exception queue
  execution/                 # replaceable local EVM and simulator adapters
  ledger/                    # confirmed-event consumer, durable replay and reconciliation
  baseline/                  # Legacy RTGS model
  metrics/                   # KPI definitions and paired-run aggregation
```

This separates the current repository from the proposal-aligned target; planned modules are not claims about existing code.

## 5. Core Domain Model

- `PaymentRequest`: `request_id`, `created_at`, `deadline`, `currency`, `amount`, `counterparty_id`, `source`, `status`.
- `TreasuryPosition`: available tokenized deposit balance, MMF units, unit price, encumbered/pledged amounts, and as-of time. Keep encumbered reserves separate from discretionary liquidity.
- `Quote`: input/output asset and amount, price, haircut, fee, spread/slippage, provider, expiry, and quote timestamp.
- `Policy`: allowed assets/counterparties, per-trade cap, rolling-window cap, minimum post-trade cash, maximum haircut, quote staleness threshold, and halt state.
- `PolicyDecision`: `APPROVE`, `REJECT`, or `ESCALATE`, with stable reason codes and evaluated policy version.
- `ExecutionIntent`: immutable approved request + quote + policy decision identifiers, nonce, expiry, and expected balance deltas.
- `SettlementResult`: transaction hash, block/confirmation metadata, actual deltas, and success/revert reason.
- `LedgerEntry`: transaction/event ID, account, debit/credit, asset, amount, timestamp, and source hash. Each posting batch must balance per asset.
- `AuditRecord`: request ID, event time, actor/component, input references, policy version, decision, outcome, and transaction hash when applicable.

Use integer minor units or fixed-point decimal arithmetic for all amounts. Do not use binary floating point for balances, prices, fees, or accounting postings.

## 6. Request Lifecycle and Invariants

1. Event source emits a payment request or treasury trigger with a stable ID and deterministic timestamp.
2. Orchestrator validates schema, deduplicates the trigger ID, records `RECEIVED`, and loads a consistent position snapshot.
3. Liquidity engine determines whether existing settlement cash covers the obligation. If not, it requests an executable MMF-to-deposit quote and computes haircut-adjusted proceeds and all costs.
4. Policy engine evaluates the request and quote. Rejections and escalations are terminal for autonomous execution and must never invoke the contract.
5. Approved requests become an immutable execution intent. The signer is a local development key in the MVP; tests use a deterministic test key only.
6. The contract checks authorization, expiry/nonce, asset pair, minimum output, and balance/allowance, then performs both token transfers atomically. Any failed condition reverts both legs.
7. Event consumer waits for the configured local finality condition, stores the chain event idempotently, and posts balanced ledger entries. Duplicate delivery must not duplicate postings.
8. Reconciliation compares chain-derived balances with shadow-ledger balances, reports differences, and moves unresolved requests into an exception state.
9. Payment is marked `COMPLETED` only when settlement cash is available and the payment leg has executed; a successful asset swap alone is not proof that the beneficiary payment settled.

Key invariants:

- No unauthorized or policy-rejected request moves funds.
- A swap either transfers both asset legs or neither.
- One request/chain event can create at most one ledger posting.
- Debit equals credit per asset and posting batch.
- A stale quote, expired intent, replayed nonce, halt state, or over-limit request cannot execute.
- Encumbered/pledged reserves are never counted as discretionary cash or released by the optimizer.
- Every request ends in a recorded terminal result or a visible pending/exception state; no silent drops.

## 7. Module Interfaces

Keep interfaces narrow and replaceable:

```python
class QuoteProvider(Protocol):
    def get_quote(self, asset_in: Asset, asset_out: Asset, amount_in: Money,
                  at: datetime) -> Quote: ...

class PolicyEvaluator(Protocol):
    def evaluate(self, request: PaymentRequest, position: TreasuryPosition,
                 quote: Quote | None, policy: Policy, at: datetime) -> PolicyDecision: ...

class SettlementExecutor(Protocol):
    def execute(self, intent: ExecutionIntent) -> SettlementResult: ...

class LedgerRepository(Protocol):
    def record_event_once(self, event: ChainEvent) -> bool: ...
    def post(self, entries: Sequence[LedgerEntry]) -> None: ...
    def reconcile(self, chain_positions: Mapping[Asset, Money]) -> ReconciliationResult: ...
```

The dashboard and experiment runner call the same application services. They must not bypass the policy evaluator or write ledger rows directly.

## 8. Evaluation Architecture

The experiment runner generates one workload and replays it to ABLE and Legacy RTGS with matched seeds. Record raw request-level events as well as run-level summaries. Separate simulated business waiting time from local prototype processing/confirmation time.

Scenarios from the proposal:

- Ordinary demand.
- Concentrated off-hours demand.
- Reduced market liquidity (wider spread, lower executable depth, or unavailable quote).
- Temporary ledger disconnection (event consumer pauses, then reconnects and replays).

Allocations: 20%, 50%, and 80% initial discretionary, unencumbered liquidity in cash; refine feasible minimum buffers in 5-percentage-point steps. At least 30 matched runs per allocation/scenario and at least 100 normal fundable requests per workload.

Report all five proposal KPIs:

1. Net yield improvement in annualized bps after fees, spread, slippage, and financing costs.
2. Settlement latency (median, p95), on-time completion, and incomplete requests.
3. Relative minimum cash-buffer reduction, while confirming all normal obligations meet deadlines.
4. Manual-review rate split into routine cases and injected exceptions; unauthorized movement count.
5. Decision/audit coverage, event-to-dashboard delay, duplicate postings, reconciliation differences, and reconnect recovery time.

Treat acceptance values as proposed thresholds, not achieved results. A miss is a reported result; do not tune workloads or exclude failed requests to force a pass.

## 9. Build Order

1. Freeze terms, units, state transitions, assumptions, and deterministic scenario format.
2. Implement domain types, event schema, fixed-point money, and pure liquidity/policy functions; add unit tests.
3. Implement the RTGS baseline and workload generator; verify paired replay and deadline semantics.
4. Implement the atomic Solidity contract and contract tests for success, revert, replay, expiry, cap, and both-leg atomicity.
5. Implement local chain adapter and orchestration state machine; exercise approved/rejected/escalated flows end to end.
6. Implement idempotent event consumer, shadow ledger, and reconciliation; test duplicate delivery and disconnect/replay.
7. Add audit/metrics and run the full paired scenario matrix; retain raw outputs and generate a concise results report.
8. Add CLI/dashboard last, reading from application services and persisted run state.

## 10. Key Design Decisions to Confirm as a Team

- **MVP execution model:** use a single local EVM transaction for the deposit/MMF swap, but model the later beneficiary payment as a separate payment event. This avoids implying that the external payment leg is atomic with the asset swap.
- **Liquidity source:** implement a deterministic simulated facility with explicit price, fees, spread, capacity, and availability. Do not use a constant unlimited zero-cost AMM; vary these inputs in reduced-liquidity scenarios.
- **Accounting:** model the shadow ledger as an idempotent projection of confirmed chain events. Describe this as retryable reconciliation, not production 2PC.
- **Timing:** use a simulated business clock for RTGS hours and a monotonic wall clock for prototype processing latency; report the two separately.
- **Dashboard:** start with CLI if schedule is tight. A dashboard is presentation only and must not become a second policy implementation.

## 11. Acceptance Checklist

- One command runs unit/contract/integration tests and the benchmark suite from a clean checkout.
- Every request has a stable ID, a policy decision, and an auditable terminal/pending state.
- All injected policy violations are rejected or escalated as specified, with zero fund movement.
- Successful swaps are atomic; reverted swaps leave both token balances unchanged.
- Event replay and duplicate delivery do not create duplicate ledger entries.
- Reconciliation shows zero unexplained differences in the normal suite and recovers disconnected events within the proposed threshold.
- KPI calculations use paired runs, explicit costs, and the proposal's definitions.
- Results distinguish simulation assumptions, target thresholds, measured outcomes, and production-only controls.
