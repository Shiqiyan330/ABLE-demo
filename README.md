# ABLE Treasury Prototype

Local prototype for policy-governed treasury requests, event monitoring, atomic token exchange, and an English treasury dashboard.

## Run

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4173`. The server compiles and deploys mock tokens, `ReserveBackedToken`, and `AtomicDvPSwap` to a fresh in-memory Ganache chain each time it starts. The prototype has three participant banks (Harbour, Meridian, Eastbridge), each with an independent wallet, wCBDC settlement balance, tokenised MMF balance, and tokenised government-bond holding. Bonds are tracked on-chain and in the shadow ledger as portfolio assets; the payment DvP flow currently exchanges MMF for wCBDC. Set `$env:PORT='4174'` before `npm start` to use another port.

## Railway deployment

Deploy this as one Node.js service. Set `ABLE_DATA_DIR` to the mounted persistent volume path (for example `/data`) so SQLite and benchmark results persist. The Ganache chain is in memory and redeploys with fresh test accounts and contract addresses after each restart. Bind address is `0.0.0.0`; Railway supplies `PORT`. Do not use production funds or keys.

## First demo: four core modules

The English dashboard focuses on policy checks, contract execution, event monitoring and bank positions. Extended ledger, RTGS and model-evaluation panels are collapsed below the core workflow.

Use **Reset demo** before presenting, then select a scenario and click **Run checks & submit**:

| Scenario | Request | Expected result |
| --- | --- | --- |
| Cash payment | Harbour → Eastbridge, HKD 500,000 | Direct wCBDC payment; Transfer event |
| Liquidity + DvP | Meridian → Eastbridge, HKD 1,600,000 | Exchange HKD 631,578.95 MMF for HKD 600,000 wCBDC, then pay; SwapExecuted and Transfer events |
| Limit breach | Harbour → Eastbridge, HKD 2,500,000 | Reject against the HKD 2 million payment cap |
| Manual review | HKD 500,000 via Unlisted Counterparty | Hold in the review queue |

Emergency halt updates both the orchestration service and the deployed swap contract. Reset restores initial balances, history, policy and the event cursor. The rolling limit covers all participant banks over the previous 24 hours. Requests are checked again immediately before execution, and mutation requests are serialized.

The listener polls confirmed EVM logs every 500 ms, deduplicates by transaction hash and log index, and streams events to the dashboard using Server-Sent Events. A block cursor makes event delivery work after local snapshot resets. Banks each hold their own wallet balance. The three named facility options are test aliases for one funded facility wallet.

## Verify

```powershell
npm test
# With npm start running; resets the local demo before and after:
node tests/api-smoke.js
```

Contract tests verify successful DvP, unauthorized callers, expiry, minimum output, replay prevention, emergency halt, and rollback of the first token transfer when the second fails. API smoke checks verify policy decisions, unchanged rejected-payment balances, successful DvP balances, rolling limits, reconciliation, reset and post-reset event delivery.

## MVP flow

1. Select a paying bank and a different receiving bank, then submit a payment amount.
2. The service evaluates emergency halt, amount limits, rolling volume, liquidity facility allowlist, route validity, quote constraints, and haircut-adjusted liquidity.
3. Rejected or escalated requests never call the swap contract.
4. If the paying bank needs liquidity, its own wallet executes `AtomicDvPSwap.swap`: MMF moves from that bank to the facility, and wCBDC moves from the facility to the paying bank atomically.
5. After the swap confirms, the paying bank transfers shared wCBDC to the receiving bank in a separate transaction. This second transaction is interbank settlement; it is not atomic with the MMF swap.
6. The server scans `SwapExecuted` and `Transfer` logs and broadcasts chain events and participant-bank balances to connected dashboards with Server-Sent Events.
7. Close RTGS in the dashboard to model off-hours operation. wCBDC payments continue on-chain and accumulate bilateral net positions. Reopening generates a pacs.009-style batch preview; it does not submit to CHATS or debit a separate reserve ledger.
8. Confirmed swaps and payments are written to a SQLite shadow ledger in integer minor units. The ledger rejects unbalanced postings, deduplicates by run-scoped event key, records opening balances, and exposes `/api/ledger` plus `/api/ledger/reconcile`.
9. Use “Pause ledger link” to simulate a temporary ledger disconnect. Confirmed settlement continues and queues its postings in the SQLite inbox; “Reconnect ledger” replays them idempotently and reports the chain reconciliation result.
10. Use “Run compact evaluation” to replay matched requests through ABLE and the Legacy RTGS model. It runs 5 seeds × 20 ordinary requests in each of 12 allocation/scenario cells and saves raw results to `runtime/benchmark-results.json`.

## Evaluation model

The compact benchmark uses a 30-day, HKD 10 million portfolio; 20%, 50%, and 80% initial cash allocations; 2% annual MMF yield; 5% haircut; 3 bps payment fee; 2 bps base spread; 0.5 bps base slippage; zero financing cost; and a 2-hour payment deadline. Reduced-liquidity runs use 80 bps spread, 25 bps slippage, 15% provider unavailability, and HKD 300,000 executable depth. The ABLE latency and reconnect values are deterministic model assumptions. Results are test-system outputs, not measured bank, market, or production-chain performance. KPI thresholds are shown alongside results and are not used to tune the workload.

## Included controls

- Solidity contracts: `ReserveBackedToken` locks mock central-bank reserves before issuing wCBDC; each participant bank is an authorized executor in `AtomicDvPSwap`, which checks emergency halt, unique request IDs, expiry, minimum output, and all-or-nothing swap legs.
- Risk checks: per-trade cap, rolling 24-hour cap, allowlist, 5% default MMF haircut, available liquidity, and escalation for a facility outside the allowlist.
- Audit feed: policy changes, policy rejection/escalation, confirmed swaps, and payment settlement.

## Test-system scope

The shared `wCBDC` token is a mock representation of a common central-bank settlement asset; it is not an actual wholesale CBDC or bank deposit. Local issuance is backed 1:1 by mock central-bank reserve tokens locked in the token contract. Operating-hour reserve earmarking, separate per-bank reserve ledgers, RTGS reopening and release, ISO 20022 net settlement, independent chain-log catch-up for events not yet captured by the inbox, liquidity-provider outages/depth, core banking sync, sanctions, oracle feeds, HSM, and production authentication are not connected. SQLite persists posted ledger entries and captured pending inbox events, which are namespaced by simulation run and replayed on service startup. Ganache restarts from a fresh in-memory chain, so this replay recovers ledger records, not prior local-chain state. The local reset operation clears the ledger and inbox and reverts Ganache to its initial snapshot. Funds and reserve assets are test tokens. Manual review holds a request for inspection; approval and release can be added in the next iteration.
