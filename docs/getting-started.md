# Getting started

## Local development

1. Install dependencies:

   ```sh
   bun install
   ```

2. Copy `.env.local.example` to `.env.local` and set a randomly generated `ADMIN_TOKEN`. Wrangler reads this file for local development; it is ignored by Git.

   No CoinGecko key is required: the default `demo` mode uses the [keyless public API](https://docs.coingecko.com/docs/keyless-public-api). If you have a Demo or Pro key, set `COINGECKO_API_KEY` to raise upstream limits. Set `COINGECKO_PLAN` to `pro` only when using a Pro key.

3. Apply migrations and start the Worker:

   ```sh
   bun run db:migrate
   bun run dev
   ```

4. Import metadata, then backfill market caps. Replace the placeholder with the admin token from `.env.local`. The market-cap backfill is resumable: repeat it until it reports `"complete": true`.

   ```sh
   curl --fail-with-body -X POST http://localhost:8787/admin/sync \
     -H 'Authorization: Bearer <ADMIN_TOKEN>'
   curl --fail-with-body -X POST http://localhost:8787/admin/seed-market-caps \
     -H 'Authorization: Bearer <ADMIN_TOKEN>'
   ```

5. Query the [public API](api.md). Prices are populated only when requested.

## Checks

```sh
bun run format
bun run check
```

Tests run locally in the Workers runtime with real D1, Cache API, and Durable Object bindings, and mocked outbound HTTP. They cover sorted search, catalog updates, cross-chain batch deduplication, cooldown persistence across restarts, failed attempts, provider budgets, stale data, and ingestion. No API credentials or paid calls are needed for tests.

`bun run build` bundles the Worker with `wrangler deploy --dry-run`; it does not deploy it.

## Deploy to Cloudflare

Use a Workers Paid account for production: the full metadata sync can exceed Free-plan CPU/subrequest allowances. The plan starts at $5/month; upstream API costs and any storage/CPU overages are separate.

1. Authenticate and create D1:

   ```sh
   bunx wrangler login
   bunx wrangler d1 create stupid-tokens
   ```

2. Replace the placeholder `database_id` in `wrangler.jsonc` with the returned ID.

3. Set the required admin secret. Optionally also set a CoinGecko key to raise upstream limits:

   ```sh
   bunx wrangler secret put ADMIN_TOKEN
   # Optional:
   # bunx wrangler secret put COINGECKO_API_KEY
   ```

4. Migrate and deploy:

   ```sh
   bun run db:migrate:remote
   bun run deploy
   ```

5. Run the two operator import endpoints against the deployed URL and confirm `/health`. A custom domain can be configured in Cloudflare or Wrangler. The public API remains keyless; operator endpoints require the admin token.

## Configuration and operation

| Setting                     | Default | Purpose                                                                                                   |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `COINGECKO_PLAN`            | `demo`  | `demo` or `pro`, selecting the correct host/header.                                                       |
| `COINGECKO_API_KEY`         | Unset   | Optional. Keyless public API when unset; Demo/Pro key when set. Token-list downloads never require a key. |
| `ADMIN_TOKEN`               | Secret  | Authenticates operator endpoints.                                                                         |
| `PRICE_REQUESTS_PER_MINUTE` | `80`    | Shared price-call ceiling across the service.                                                             |
| `PRICE_REQUESTS_PER_MONTH`  | `9000`  | Shared price-call ceiling per UTC calendar month.                                                         |

Budgets count attempts conservatively, including unsuccessful requests. Metadata sync and market-cap backfill use separate API calls; leave headroom for them. Run initial catalog/market-cap imports before opening the service to traffic. Price budgeting also honors provider `Retry-After` on HTTP 429. Raising a budget takes effect on retry, within at most a minute for budget-blocked quotes.

The Worker runs against CoinGecko's **keyless public API** by default. Keyless limits are roughly 10–30 requests/minute from a shared IP pool, and CoinGecko explicitly warns that keyless access is not suitable for production or scheduled polling. The default `PRICE_REQUESTS_PER_MINUTE` is therefore conservative at 15, and the daily cron runs one catalog sync plus a bounded market-cap refresh rather than continuous polling. Cloudflare Workers also share egress addresses, so keyless limits can be contended by unrelated traffic. For a production deployment, sign up for a free Demo key (`COINGECKO_API_KEY`) or upgrade to Pro and raise the budgets accordingly. Setting a key adds the correct header automatically; setting `COINGECKO_PLAN=pro` switches to the Pro host.

Monitor `/admin/status`, Worker error logs, provider usage, and D1 read/write metrics. Inspect `catalog_sync_report` for imported/skipped chains, per-chain failures, and unavailable native metadata or native asset mappings. A partial import serves the successful chains while `/health` and `/admin/sync` return HTTP 503, and scheduled invocations fail visibly. Observability samples ordinary requests at 1%; logging inside failed refreshes records the asset count and a sanitized error, never the API key.

Chain discovery is automatic: each sync reads CoinGecko's `/asset_platforms`, selects platforms with numeric Chainlist/EIP-155 IDs, and downloads their platform-specific public token lists. There is no chain allowlist to edit. `src/chains.ts` contains discovery logic. Names/symbols/decimals for native currencies come from `https://chainid.network/chains.json`, fetched once per synchronization, while CoinGecko supplies native asset IDs. Missing native metadata does not block contract-token imports; it is explicitly reported rather than filled with assumed decimals. Existing token-list logos are used as external URLs; the market-cap backfill fills missing asset/native images.

Metadata ingestion validates a list before modifying a chain, rejects conflicting asset mappings, duplicate chain IDs, and duplicate token identities, discards malformed or wrong-chain token entries, upserts only changed records, and removes missing entries after a successful chain import. Lists are fetched serially with a short gap and brief retries because the token-list CDN throttles concurrent requests; chains still throttled after the bulk sweep are retried once. Every request sends a descriptive `User-Agent`, which CoinGecko requires for keyless access. Unchanged lists are skipped using a stored content hash, so repeat and nightly syncs only re-import what changed. The full catalog is not transactionally replaced across chains. HTTP 404/410 and valid empty lists are skipped and reported; other errors are recorded as failures and retried on the next sync. Existing data for skipped/failed chains is retained with its original per-chain sync timestamp. Initial seeding and newer price requests compare market-cap source timestamps so old seed data does not replace newer values.

The initial implementation uses a singleton refresh coordinator, with all cache-hit traffic served outside it. If measured refresh demand outgrows one object, shard by stable asset ID while preserving global provider budgeting. No sharding is needed just to serve more cached reads.

CoinGecko's standard API access and data redistribution permissions differ. A public production deployment needs terms that cover this use case. See [CoinGecko licensing](https://support.coingecko.com/hc/en-us/articles/16760512207257-What-are-the-differences-between-commercial-and-custom-licenses).
