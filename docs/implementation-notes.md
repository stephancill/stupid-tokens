# Implementation notes

## Initial implementation

- Implemented Hono routes for chains, indexed token search, single-token metadata, and mixed-chain bulk USD prices (up to 100 inputs). Public routes are keyless and CORS-enabled; operator routes use a secret bearer token.
- Added D1 migrations for deployment metadata, shared source assets/quotes, chain state, and FTS5 trigram search. Search sorts all matching candidates by stored global market cap before limiting, with null caps last and deterministic chain/address ties. Two-character queries use indexed prefixes.
- Added daily CoinGecko token-list synchronization, source ID mapping through `/coins/list` and `/asset_platforms`, change-only upserts, and post-import pruning. The initial registry covers eight EVM mainnets and their native currencies.
- Added an operator-triggered, one-time market-cap/image seed. Subsequent market-cap updates accompany price demand. Source timestamp comparisons prevent older caps replacing newer values, including overlap with initial seeding.
- Added a SQLite-backed Durable Object that coalesces concurrent misses, batches source IDs with both count and URL-size bounds, persists rolling 300-second per-asset attempt reservations before external I/O, enforces global provider budgets, and honors HTTP 429 backoff. Cached reads bypass the coordinator.
- Price responses preserve input order and duplicates, deduplicate mapped deployments upstream, and expose source time, fetch time, and the next refresh time. Quotes older than 300 seconds at source return `stale` with a null price, even if the recent fetch remains within its cooldown. Failed attempts also retain the cooldown.
- Added bounded internal edge caches. Whole POST responses are not cached; source age is evaluated when assembling each response. Missing tokens do not cause upstream calls.
- Added Bun, TypeScript, Oxc formatting/linting, Workers-runtime Vitest integration, deployment configuration, and setup/API documentation.

## Verification

- Type checking, linting, formatting, Workers-runtime integration tests, and a Wrangler deployment dry run pass.
- Seventeen integration tests cover market-cap ordering, substring/address queries, import updates and pruning, imports spanning multiple chunks, a full 100-token price request, concurrent/cross-chain deduplication, persistence across forced object restarts, failed refresh cooldowns, budgets/backoff, stale prices, validation, native-token ingestion, initial market-cap seeding, automatic chain discovery, unavailable lists, and partial synchronization failures.
- Validated live CoinGecko platform/coin-ID responses and seven full token lists containing 18,328 entries. Live data exposed an empty symbol, so the schema preserves source-provided empty symbols; missing images remain nullable. The Gnosis token list was also retrieved and inspected.
- Local D1 migrations apply successfully. Local HTTP checks confirm the root endpoint, CORS preflight, and explicit not-ready responses before catalog initialization.
- Bundled Worker is approximately 874 KiB uncompressed / 146 KiB gzip.

## Deployment state

- Deployed as the `stupid-tokens` Worker on the custom domain `tokens.stupidtech.net`, backed by the `stupid-tokens` D1 database (`75a5c131-46ba-40e3-b126-1e663e220c1a`, WEUR). `wrangler.jsonc` contains the real account ID, database ID, and custom-domain route, so `bun run deploy` works from a checked-out copy.
- `workers_dev` is disabled, so the Worker is reachable only via the custom domain.
- Both migrations are applied remotely. `ADMIN_TOKEN` is set as a Worker secret and stored only in the ignored `.env.local` locally. No CoinGecko key is configured; the deployment runs keyless.
- Runtime secrets are independent of deployments, so deploying from CI does not clear them.
- The public GitHub repository is `stephancill/stupid-tokens`.
- The repository is connected to the Worker through Workers Builds: production branch `main`, build command `bun install`, deploy command `bunx wrangler deploy`, non-production branch builds disabled. The non-production command remains the default `npx wrangler versions upload`, and preview URLs would not be generated anyway because the Worker uses Durable Objects. Pushes to `main` therefore deploy automatically.
- Workers Builds uses a pre-existing build token. The build configuration lives in Cloudflare, not in the repository, so it is not reproducible from source; recreating it requires the dashboard or a user-scoped API token with the Workers Builds Configuration permission.

## Keyless upstream default

- Removed the unconditional CoinGecko key requirement. `apiConfig` now accepts an absent or empty `COINGECKO_API_KEY` and omits the key header entirely.
- **Keyless access from Workers requires a descriptive `User-Agent`.** CoinGecko returns HTTP 403 without one, so all upstream requests now send `stupid-tokens/1.0 (+https://tokens.stupidtech.net)`. Discovered while validating the deployed Worker, where the original implementation failed immediately.
- Added bounded retries with backoff for transient throttling and server errors: HTTP 403, 429, 5xx, and network failures. Failed price refreshes previously classified only 429 as throttling; 403 is now treated the same way.
- Lowered the default `PRICE_REQUESTS_PER_MINUTE` from 80 to 15 for production. Keyless access shares a low, dynamic IP-based pool (roughly 10–30 calls/minute), and Cloudflare egress IPs are shared with unrelated traffic.
- Kept `COINGECKO_PLAN` defaulting to `demo` so a Demo key works by setting only `COINGECKO_API_KEY`, while a Pro key additionally sets `COINGECKO_PLAN=pro`.
- Updated `.env.local.example`, deployment instructions, and API/architecture docs. Added runtime tests for the absent key header, the descriptive User-Agent, and throttling retries.

## Catalog ingestion hardening

- Found by running the sync against real data: the token-list CDN throttles concurrent and rapid requests, and some lists contain null versions, null chain IDs, non-EVM addresses, or entries for other chains.
- Token lists are now fetched serially with a 250 ms gap instead of at 2–4 way concurrency, and lists that are still throttled after the bulk sweep get one serial retry pass. Throttled chains that fail again are reported and retried by the next sync.
- Malformed entries are discarded per entry and counted, instead of failing the whole chain. Only a list with no valid entries is reported empty.
- Added `migrations/0002_chain_content_hash.sql` and a normalized content hash per chain. Unchanged lists are skipped, so repeat and nightly syncs only re-import genuine changes.
- Catalog responses now include `pendingChains` (chains that produced neither an import, skip, nor failure) and imported entries include `discarded`. A sync that imports nothing because everything is unchanged reports `complete`, while a sync that imports nothing on a never-synchronized catalog reports `failed`.
- Removed the unused `list` field from chain discovery; token lists are always addressed by CoinGecko platform ID.
- Reworked market-cap seeding into a resumable backfill shared with the nightly job. A backfill that exhausts its time budget reports `complete: false` with `remaining` and is not recorded as complete, so it can be re-run; previously an incomplete seed was permanently marked done. The nightly job now also refreshes caps that are missing or older than seven days, so newly added tokens get caps without operator action.

## Catalog convergence and readiness

- Found in production that no sync run had ever completed: a 275-chain sweep exceeds the invocation budget, so `catalog_synced_at` was never written and the API reported itself unready while holding 26k tokens. The import lock also persisted for an hour after a killed run, blocking retries.
- Sync invocations are now bounded to a configurable budget (default eight minutes) and always write a report. Remaining chains are reported in `pending` with a `budgetExhausted` flag, so repeated calls converge.
- The import lock now expires after ten minutes instead of one hour, and a concurrent call returns HTTP 409 rather than a generic failure.
- Readiness now tracks a usable catalog: any run that leaves at least one chain imported marks the catalog usable. Partial coverage is a warning surfaced through `catalogStatus` and `catalogPendingChains` rather than an outage. Previously any failure left health and all `/v1` routes returning 503.
- Unavailable lists (HTTP 404/410) and valid empty lists are non-degrading skips, since many listed platforms publish no token list. Only failures or deferred chains make a usable catalog `partial`.
- Sync reports now include `pendingChains`, `pending`, and `budgetExhausted`, and `admin/status` and `health` expose the summarised status.

## Automatic chain coverage

- Replaced the initial eight-chain allowlist with automatic discovery from CoinGecko's numeric Chainlist/EIP-155 platform IDs. Platform IDs are URL-encoded without changing their case; the live source includes uppercase, underscore, and space-containing IDs, plus a non-EVM empty-ID placeholder.
- Public token-list downloads now use each platform ID, including the canonical `ethereum` list URL. HTTP 404/410 and valid empty lists are reported as unavailable. Other HTTP, validation, and import errors are isolated and reported per chain; existing data is retained for failed/unavailable chains.
- Native currency metadata is read dynamically from the public Chain ID registry. Unknown registry chains still get contract-token coverage; missing native metadata and missing CoinGecko native asset mappings are listed separately in the sync report.
- Added four-way bounded import concurrency and ten-second token-list timeouts. Import results are returned and persisted as `catalog_sync_report`; partial/failed imports produce operator HTTP 503 responses, degraded health, and failed scheduled invocations while successful chain data remains queryable.
- Verified discovery against live source snapshots: 275 numeric EVM platform candidates, with native currency metadata available for 266. These are discovery counts, not a claim that every candidate has an available and valid token list. Retrieved the canonical Ethereum list and the Sonic/ENI lists to verify coverage beyond the former allowlist and handling of a missing native asset mapping.
- Updated Workers-runtime tests to cover automatically discovered chains, URL encoding, null-ID exclusions, native decimals from the registry, missing native metadata/mappings, unavailable/empty lists, wrong-chain and malformed data, preservation of prior data, and degraded health.
- No database migration is required; reports use the existing `app_state` table.

## Provider-neutral responses

- Removed `platformId` from `/v1/chains`; clients must use numeric `chainId` instead. The chain cache namespace was changed so cached responses cannot reintroduce the removed field.
- Removed platform identifiers from synchronization reports. Imported/skipped/failed entries use `chainId`, and both missing-native arrays contain chain IDs. Source asset IDs remain internal to ingestion, storage, and price coordination.
- Added an explicit report response schema and projected operator status fields. Detailed upstream errors are kept in Worker logs, with provider-neutral chain-based failure messages in responses.
- Updated API documentation and existing runtime assertions for the response contract. No compatibility aliases are provided for removed provider-specific fields.

## Address-keyed multi-source pricing

- Replaced CoinGecko's coin-ID pricing with address-keyed sources, so identity is `chainId + address` end to end and the 3.7 MB `/coins/list` mapping call plus its ambiguous-asset resolution are gone. CoinGecko is still used for the chain list and public token lists.
- Added DefiLlama as the primary price source (large batches, source timestamp, confidence, native via the zero address), GeckoTerminal for per-deployment market caps and images, and DexScreener as the long-tail fallback.
- DexScreener must use the chain-scoped `/tokens/v1/{chain}/{addresses}` endpoint. Verified live that the unscoped `/latest/dex/tokens/{addresses}` returns pairs from unrelated chains for the same address.
- DEX prices are only accepted when pool liquidity clears a minimum, and DefiLlama prices require a minimum confidence, because thin pools are trivially manipulable.
- Market caps are now per deployment rather than one global value shared across chains. Search ordering therefore reflects the deployment being searched.
- Added `migrations/0003_chain_geckoterminal_network.sql`. GeckoTerminal network slugs differ from CoinGecko platform ids (`eth` vs `ethereum`), so they are discovered from GeckoTerminal's `/networks` endpoint during sync rather than guessed. DefiLlama and DexScreener slugs are derived from the platform id with a small alias table.
- Assets are keyed by the deployment itself (`chainId:address`), which reuses the existing quote, reservation, budget, and search-join machinery without a schema rewrite.
- Fixed a related defect: the market-cap backfill passed an effectively infinite max age, which overflowed the SQL cutoff and selected no rows. The backfill now uses a 30-day window, so it is idempotent once complete while still filling newly added tokens.
- Sync convergence fix: only chains whose `synced_at` is stale are fetched. Because `synced_at` is written only on success, failed or never-imported chains stay due and are retried, while fresh chains are skipped entirely. Previously every run re-fetched from the start and could never advance past the time budget. Reports now include `freshChains`, and `pending` counts only due chains.
- Updated Workers-runtime tests to mock the three providers and to assert per-deployment market-cap ordering, and updated the API and architecture documentation.

## Provider fault isolation

- Found by probing from Cloudflare's network that GeckoTerminal returns HTTP 429 to Workers while DefiLlama and DexScreener return 200. Because the three sources were awaited in a single array literal, a GeckoTerminal 429 aborted the whole refresh and discarded the successful DefiLlama price, so no price was ever served.
- Added `trySources`, which isolates each provider: a throttled or broken source contributes nothing and is logged, while the remaining sources still produce a result. A refresh is only treated as an upstream failure when every source fails, which preserves the existing backoff behaviour.
- Applied the same isolation to the market-cap path, so caps can still come from DexScreener when GeckoTerminal is throttled.

## Freshness-aware source merge

- Verified against a real wallet (82 tokens across 7 chains, balances sourced from Alchemy because Dune Sim DNS was unavailable). Native currencies priced correctly and matched Alchemy closely (ETH 2632.96 vs 2637.92, AVAX 11.161 vs 11.166). All 68 unpriced tokens were airdrop spam that Alchemy could not price either, so there were no false negatives.
- That run exposed a merge defect: YFI is liquid (Alchemy 2197) but returned `stale`, because the merge took the first source with any price and DefiLlama's timestamp had lagged past the freshness limit, shadowing fresher DEX prices.
- `mergeQuotes` now prefers the highest-priority source whose price is still within the freshness window, falling back to any available price (which the response then reports as `stale`). A missing timestamp is treated as fresh because freshness is then unknown. Market cap and image still prefer the first source that provides them.
- Added a runtime test proving a fresh lower-priority DEX price supersedes a stale primary price, and kept a test that withholds a price when every source is stale.
