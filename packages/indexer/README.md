# StellarAgent Soroban event indexer

This package turns the contract events emitted by Payment Channel, Escrow, Rate
Limiter, and Agent Wallet Factory into a durable audit trail. It supports a
one-shot backfill and a continuously polling live tail.

## Run

```bash
export SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
export INDEXER_START_LEDGER=1234
export INDEXER_DEPLOYMENT_FILE=deployments/local.json
export INDEXER_DATABASE=stellaragent-events.sqlite
export REPORT_DATABASE=stellaragent-reports.sqlite

pnpm --filter @stellaragent/indexer build
pnpm --filter @stellaragent/indexer exec stellaragent-indexer catch-up
pnpm --filter @stellaragent/indexer exec stellaragent-indexer catch-up --from-ledger 1234
pnpm --filter @stellaragent/indexer exec stellaragent-indexer tail
```

Instead of `INDEXER_DEPLOYMENT_FILE`, the four addresses can be supplied as
`PAYMENT_CHANNEL_CONTRACT`, `ESCROW_CONTRACT`, `RATE_LIMITER_CONTRACT`, and
`AGENT_WALLET_FACTORY_CONTRACT`. `INDEXER_ROLLBACK_WINDOW` defaults to 12
ledgers, `INDEXER_FINALITY_LAG` to 1, `INDEXER_POLL_INTERVAL_MS` to 5000, and
the REST server's `PORT` to 3001. The report worker is enabled by default;
`REPORT_POLL_INTERVAL_MS` defaults to 5000 and `REPORT_WORKER_ENABLED=false`
creates an API-only replica. Email uses `REPORT_EMAIL_GATEWAY_URL` and optional
`REPORT_EMAIL_GATEWAY_TOKEN`; CORS uses `AUDIT_API_CORS_ORIGIN`.

Soroban RPC retains only a bounded event history. Set `INDEXER_START_LEDGER` to
the earliest deployment ledger still retained by the selected RPC provider for
the initial catch-up. `--from-ledger` deliberately replays and replaces all
stored events from an explicit checkpoint, which is useful for recovery or a
larger manual rollback.

## Query API

- `GET /agents/:address/events` — every event in which the address participates
- `GET /channels/:channelId/spend` — payment history and summed source amount
- `GET /jobs/:jobId/lifecycle` — ordered lifecycle and derived job status
- `GET /channels/:channelId/state`, `GET /jobs/:jobId/state`,
  `GET /rate-limits/:address/state`, and `GET /agent-info/:id/state` — latest
  complete on-chain record reconstructed from state snapshot events
- `GET /events?limit=100&offset=0` — ordered event feed
- `GET /ledger` and `GET /ledger/issues` — normalized entries and data issues
- `GET|POST /reports/statements/:kind/:address` — statement preview or
  statement with supplied on-chain reconciliation
- `GET /reports/statements/:kind/:address/export?format=csv|json|iif` —
  backpressure-aware verifiable export
- `GET|POST /reports/schedules`, `GET /reports/deliveries`, and
  `POST /reports/deliveries/:id/replay` — delivery administration
- `GET /health` — service status and next ledger checkpoint

The same queries are available as typed methods on `EventStore`;
`iterateLedgerEntries` pages without a total-row ceiling. The operating and
proof-boundary guide is [`../../docs/audit-trail.md`](../../docs/audit-trail.md).

## SQLite schema

`events` stores one row per RPC event. Its primary key is the RPC event ID; it
also stores contract identity, ledger/transaction ordering data, normalized
namespace/action/entity columns, decoded JSON, and the original topic/value XDR.
`event_participants` is a many-to-many address/role index used by agent audit
queries. `checkpoints` stores the next ledger for each stream.

Balanced `ledger_entries`/`ledger_postings`, confirmed `transaction_fees`, and
retained `ledger_issues` form the reporting layer. The separate report database
stores schedules, immutable artifacts, SHA-256 digests, idempotency keys,
leases, attempts, and dead letters.

Each poll deliberately re-fetches `INDEXER_ROLLBACK_WINDOW` ledgers. In one
SQLite transaction it deletes that ledger range, inserts the canonical response,
and advances the checkpoint. This makes restarts idempotent and removes events
from a replaced ledger, including the case where its replacement has no matching
events. `INDEXER_FINALITY_LAG` avoids committing the RPC head itself.

The raw XDR columns are intentional: normalized schemas can evolve without
discarding the exact on-chain record.

## Local standalone integration test

The normal test suite uses real ScVal XDR and a deterministic RPC double. A
gated integration suite invokes the deployed factory three times on Soroban
standalone, catches up through RPC, checks the decoded lifecycle, and compares
its final active state with `get_agent`:

```bash
stellar network start local
pnpm deploy:contracts --network local --source alice
STELLAR_LOCAL_INTEGRATION=1 \
  pnpm --filter @stellaragent/indexer test
```

Set `STELLAR_LOCAL_SOURCE`, `SOROBAN_RPC_URL`, or
`INDEXER_DEPLOYMENT_FILE` when using non-default local settings.

## State reconstruction and legacy deployments

The contracts keep their existing action event tuples unchanged and now also
publish an additive `state/channel`, `state/job`, `state/limit`, or `state/agent`
snapshot after every state mutation. The latest snapshot is the exact complete
contract record; replaying snapshots reconstructs the record at every mutation.

Deployments built before this change do not contain those snapshot events.
Their action audit trail remains fully queryable, but fields that were never in
the old payloads (channel token/period, job deadline/task/result, rate-limit
configuration, and agent name) cannot be recovered historically.

## Backfilling from a historical ledger

`stellaragent-indexer catch-up --from-ledger 1200000` pages through history from
that ledger (resumable via the persisted checkpoint), then `--tail` composes with
it: catch up first, then follow the head. `INDEXER_FROM_LEDGER` sets the same
starting point from the environment.
