# Proposal Alignment

This document maps the current local prototype to the supplied ABLE proposal. “Implemented” means present in this prototype and locally exercised; it does not imply production readiness or a live EnsembleTX connection.

| Proposal area | Current prototype | Status |
|---|---|---|
| Multi-bank interbank treasury scope (Sections 1.3, 1.6, 5) | Three participant banks have distinct EVM wallets and independent wCBDC/MMF balances. Requests select a paying bank and a different receiving bank. | Implemented in local simulation |
| Primary liquidity pair (Section 1.6) | Bank-held tokenised MMF is exchanged for a shared mock wCBDC settlement token. | Implemented in local simulation |
| Event-triggered policy-governed autonomy (Sections 1.7, 3.2, 3.5) | Payment submissions run server-side checks for halt, amount, limits, facility allowlist, route, quote, expiry, and haircut-adjusted liquidity; approved requests can execute automatically. | Partially implemented; no sanctions/oracle feeds or human-review workbench |
| Liquidity counterparty/facility (Section 1.8) | A mock facility wallet supplies wCBDC; requests include quote output and minimum output. | Partially implemented; one shared wallet, fixed terms, no depth/outage model |
| Atomic DvP swap (Sections 3.1–3.2, 4.3) | The payer bank exchanges its MMF for wCBDC in one EVM transaction. Failed transfer legs revert together. | Implemented in local simulation |
| Interbank settlement payment (Sections 1.3, 3.3) | A separate transaction transfers wCBDC from the paying bank to the receiving bank. | Implemented as a separate step; not atomic with the prior MMF swap |
| 1:1 central-bank reserve backing (Sections 2.3, 3.3) | `ReserveBackedToken` transfers mock central-bank reserve assets into escrow before issuing the same amount of wCBDC; startup checks locked reserves equal token supply. | Implemented for aggregate local issuance; per-bank earmarking and RTGS release/reconciliation remain |
| RTGS close/open hybrid and ISO 20022 netting (Section 3.3) | Dashboard can simulate RTGS close/open. wCBDC payments continue while closed and accrue bank net positions; reopening emits a pacs.009-style reconciliation batch preview. | Partially implemented; simulated message records only, not CHATS settlement or reserve release |
| Ledger sync and shadow accounting (Sections 2.4, 3.2) | SQLite stores run-scoped opening positions, confirmed DvP and interbank payment postings, RTGS audit events, and a durable event inbox. Integer-minor-unit postings are balanced and idempotent. Dashboard can pause the ledger link, queue confirmed events, reconnect, replay, and reconcile balances. Pending inbox events are replayed on service startup. | Partially implemented; no independent chain-log catch-up for events missed before inbox capture, finality queue, or legacy-core connector |
| Permissioned tokens, production keys and audit controls (Sections 3.4–3.5) | Plain local mock ERC-20 tokens and Ganache test keys; contract has executor authorization, halt, request replay protection, expiry and minimum output. | Partially implemented; no ERC-3643 identity, HSM, WORM store, or production key controls |
| Command center (Section 3.7) | English dashboard shows a selected participant bank, its cash/MMF position, policy controls, interbank request queue, chain status and audit feed. | Implemented for prototype workflows |
| Paired RTGS evaluation and five KPIs (Section 4) | Deterministic compact benchmark replays matched obligations through ABLE and a cash-only Legacy RTGS baseline for 20%, 50%, and 80% cash allocations across ordinary, concentrated off-hours, reduced-liquidity, and ledger-disconnect scenarios. It reports all five KPI groups, cost sensitivity, and raw per-run results. | Partially implemented as a small test model; default is 5 matched seeds × 20 ordinary requests per cell. Latency, yield, provider, and reconnect values use explicit simulation assumptions and are not live-system measurements. |

## Next implementation order

1. Add independent confirmed-chain-log catch-up for a crash between chain confirmation and inbox capture; test interruption, restart, and duplicate delivery.
2. Add per-bank earmarked reserve views, reserve release, validated ISO 20022 messages, and simulated CHATS submission status.
3. Add stable client request idempotency, explicit request states, policy versions, executable quote costs/depth, and a review queue.
4. Calibrate the compact model with documented distributions, then add larger matched-seed runs and independent result review before making research claims.

The current prototype’s `wCBDC` token is a shared mock settlement asset. It is not a commercial-bank deposit token or a live wholesale CBDC. Its aggregate local supply is backed 1:1 by mock central-bank reserve tokens held by the token contract. MMF-to-wCBDC DvP and the onward interbank payment are separate EVM transactions.
