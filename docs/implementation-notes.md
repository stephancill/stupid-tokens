# Implementation notes

## Initial implementation

- Implemented Hono routes for chains, indexed token search, single-token metadata, and mixed-chain bulk USD prices (50 inputs; originally 100). Public routes are keyless and CORS-enabled; operator routes use a secret bearer token.
- Added D1 migrations for deployment metadata, shared source assets/quotes, chain state, and FTS5 trigram search. Search sorts all matching candidates by stored global market cap before limiting, with null caps last and deterministic chain/address ties. Two-character queries use indexed prefixes.
- Added token-list synchronization, change-only upserts, and post-import pruning. The original eight-chain allowlist and the `/coins/list` source-ID mapping were both later removed; see the automatic chain coverage and address-keyed pricing sections below.
- Added an operator-triggered market-cap/image backfill. It is resumable rather than one-time, and market-cap updates also accompany price demand. Source timestamp comparisons prevent older caps replacing newer values.
- Added a SQLite-backed Durable Object that coalesces concurrent misses, batches source IDs with both count and URL-size bounds, persists rolling 300-second per-asset attempt reservations before external I/O, enforces global provider budgets, and honors HTTP 429 backoff. Cached reads bypass the coordinator.
- Price responses preserve input order and duplicates, deduplicate mapped deployments upstream, and expose source time, fetch time, and the next refresh time. Quotes older than 300 seconds at source return `stale` with a null price, even if the recent fetch remains within its cooldown. Failed attempts also retain the cooldown.
- Added bounded internal edge caches. Whole POST responses are not cached; source age is evaluated when assembling each response. Missing tokens do not cause upstream calls.
- Added Bun, TypeScript, Oxc formatting/linting, Workers-runtime Vitest integration, deployment configuration, and setup/API documentation.

## Verification

- Type checking, linting, formatting, Workers-runtime integration tests, and a Wrangler deployment dry run pass.
- Twenty-six Workers-runtime integration tests cover market-cap ordering, substring/address queries, import updates and pruning, imports spanning multiple chunks, a maximum-size bulk price request, concurrent deduplication, persistence across forced object restarts, failed-refresh cooldowns, budgets and backoff, stale prices, validation, native-token ingestion, automatic chain discovery, unavailable and empty lists, partial synchronization failures, canonical GET caching and redirects, freshness-bounded `max-age`, and source isolation, source gating, and merge behaviour.
- Validated live CoinGecko platform/coin-ID responses and seven full token lists containing 18,328 entries. Live data exposed an empty symbol, so the schema preserves source-provided empty symbols; missing images remain nullable. The Gnosis token list was also retrieved and inspected.
- Local D1 migrations apply successfully. Local HTTP checks confirm CORS preflight and explicit not-ready responses before catalog initialization. The root path now serves the landing page.
- Bundled Worker is approximately 895 KiB uncompressed / 150 KiB gzip.

## Deployment state

- Deployed as the `stupid-tokens` Worker on the custom domain `tokens.stupidtech.net`, backed by the `stupid-tokens` D1 database (`75a5c131-46ba-40e3-b126-1e663e220c1a`, WEUR). `wrangler.jsonc` contains the real account ID, database ID, and custom-domain route, so `bun run deploy` works from a checked-out copy.
- `workers_dev` is disabled, so the Worker is reachable only via the custom domain.
- All migrations (0001–0006) are applied remotely. `ADMIN_TOKEN` is set as a Worker secret and stored only in the ignored `.env.local` locally. No CoinGecko key is configured; the deployment runs keyless.
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
- Token lists are fetched serially with a 250 ms gap instead of at 2-4 way concurrency. An in-run retry pass was added and later removed; throttled chains are now retried by the next scheduled sync.
- Malformed entries are discarded per entry and counted, instead of failing the whole chain. Only a list with no valid entries is reported empty.
- Added `migrations/0002_chain_content_hash.sql` and a normalized content hash per chain. Unchanged lists are skipped, so repeat and nightly syncs only re-import genuine changes.
- Catalog responses now include `pendingChains` (chains that produced neither an import, skip, nor failure) and imported entries include `discarded`. A sync that imports nothing because everything is unchanged reports `complete`, while a sync that imports nothing on a never-synchronized catalog reports `failed`.
- Removed the unused `list` field from chain discovery; token lists are always addressed by CoinGecko platform ID.
- Reworked market-cap seeding into a resumable backfill shared with the nightly job. A backfill that exhausts its time budget reports `complete: false` with `remaining` and is not recorded as complete, so it can be re-run; previously an incomplete seed was permanently marked done. The nightly job now also refreshes caps that are missing or older than seven days, so newly added tokens get caps without operator action.

## Catalog convergence and readiness

- Found in production that no sync run had ever completed: a 275-chain sweep exceeds the invocation budget, so `catalog_synced_at` was never written and the API reported itself unready while holding 26k tokens. The import lock also persisted for an hour after a killed run, blocking retries.
- Sync invocations are now bounded to a configurable budget (default three minutes) and always write a report. Remaining chains are reported in `pending` with a `budgetExhausted` flag, so repeated calls converge.
- The import lock now expires after ten minutes instead of one hour, and a concurrent call returns HTTP 409 rather than a generic failure.
- Readiness now tracks a usable catalog: any run that leaves at least one chain imported marks the catalog usable. Partial coverage is a warning surfaced through `catalogStatus` and `catalogPendingChains` rather than an outage. Previously any failure left health and all `/v1` routes returning 503.
- Unavailable lists (HTTP 404/410) and valid empty lists are non-degrading skips, since many listed platforms publish no token list. Only failures or deferred chains make a usable catalog `partial`.
- Sync reports now include `pendingChains`, `pending`, and `budgetExhausted`, and `admin/status` and `health` expose the summarised status.

## Automatic chain coverage

- Replaced the initial eight-chain allowlist with automatic discovery from CoinGecko's numeric Chainlist/EIP-155 platform IDs. Platform IDs are URL-encoded without changing their case; the live source includes uppercase, underscore, and space-containing IDs, plus a non-EVM empty-ID placeholder.
- Public token-list downloads now use each platform ID, including the canonical `ethereum` list URL. HTTP 404/410 and valid empty lists are reported as unavailable. Other HTTP, validation, and import errors are isolated and reported per chain; existing data is retained for failed/unavailable chains.
- Native currency metadata is read dynamically from the public Chain ID registry. Unknown registry chains still get contract-token coverage, and missing native metadata is reported. The separate missing-native-asset-id list was removed when pricing moved to address-keyed sources.
- Import results are returned and persisted as `catalog_sync_report`. Import concurrency was later reduced to serial fetching with a ten-second timeout per list. A partial run returns HTTP 200 and leaves health ready; only a run that imports nothing on a never-synchronized catalog returns HTTP 503.
- Verified discovery against live source snapshots: 275 numeric EVM platform candidates, with native currency metadata available for 266. These are discovery counts, not a claim that every candidate has an available and valid token list. Retrieved the canonical Ethereum list and the Sonic/ENI lists to verify coverage beyond the former allowlist and handling of a missing native asset mapping.
- Updated Workers-runtime tests to cover automatically discovered chains, URL encoding, null-ID exclusions, native decimals from the registry, missing native metadata/mappings, unavailable/empty lists, wrong-chain and malformed data, preservation of prior data, and degraded health.
- Reports use the `app_state` table. Later work did require migrations: 0002 (chain content hash), 0003 (GeckoTerminal network slug), and 0004 (chain check state).

## Provider-neutral responses

- Removed `platformId` from `/v1/chains`; clients must use numeric `chainId` instead. The chain cache namespace was changed so cached responses cannot reintroduce the removed field.
- Removed platform identifiers from synchronization reports. Imported/skipped/failed entries use `chainId`. Provider asset identifiers were subsequently removed from the design entirely when pricing moved to address-keyed sources.
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
- Sync convergence, first attempt: only chains whose `synced_at` is stale are fetched, and reports gained `freshChains` with `pending` counting only due chains. This was incomplete because skipped chains never recorded a timestamp, so they stayed due forever; see the convergence fixes section below, which supersedes this.
- Updated Workers-runtime tests to mock the three providers and to assert per-deployment market-cap ordering, and updated the API and architecture documentation.

## Provider fault isolation

- Found by probing from Cloudflare's network that GeckoTerminal returns HTTP 429 to Workers while DefiLlama and DexScreener return 200. Because the three sources were awaited in a single array literal, a GeckoTerminal 429 aborted the whole refresh and discarded the successful DefiLlama price, so no price was ever served.
- Added `trySources`, which isolates each provider: a throttled or broken source contributes nothing and is logged, while the remaining sources still produce a result. A refresh is only treated as an upstream failure when every source fails, which preserves the existing backoff behaviour.
- Applied the same isolation to the market-cap path, so caps can still come from DexScreener when GeckoTerminal is throttled.
- Added a per-run source gate (`createSourceGate`). Isolation alone still paid a failing request on every market-cap batch, so a 12-minute backfill spent most of its budget on GeckoTerminal requests that could not succeed. The gate closes a throttled source for the remainder of the run: `refreshMarketCaps` gates GeckoTerminal, and the price coordinator closes it for the lifetime of its Durable Object instance. Only sources explicitly listed as gateable can be closed, so the primary price source and the last remaining fallback still surface total failure to the caller. A later run starts with a clean gate, so a recovered source is used again.
- Added a Workers-runtime test that a throttled GeckoTerminal is attempted only once per backfill run and that DexScreener still supplies the cap.

## Freshness-aware source merge

- Verified against a real wallet (82 tokens across 7 chains, balances sourced from Alchemy because Dune Sim DNS was unavailable). Native currencies priced correctly and matched Alchemy closely (ETH 2632.96 vs 2637.92, AVAX 11.161 vs 11.166). All 68 unpriced tokens were airdrop spam that Alchemy could not price either, so there were no false negatives.
- That run exposed a merge defect: YFI is liquid (Alchemy 2197) but returned `stale`, because the merge took the first source with any price and DefiLlama's timestamp had lagged past the freshness limit, shadowing fresher DEX prices.
- `mergeQuotes` now prefers the highest-priority source whose price is still within the freshness window, falling back to any available price (which the response then reports as `stale`). A missing timestamp is treated as fresh because freshness is then unknown. Market cap and image still prefer the first source that provides them.
- Added a runtime test proving a fresh lower-priority DEX price supersedes a stale primary price, and kept a test that withholds a price when every source is stale.

## Landing site

- Added a static landing page with a brief API reference at `public/index.html`, served through the Worker's `ASSETS` binding on the custom domain. `GET /v1` now returns the machine-readable endpoint index that previously lived at `/`.
- Styling follows the shared Stupid minimal aesthetic: system-ui type, a 46rem column, light-gray code blocks, no framework or build step. The page carries a full set of Open Graph tags and a lowercased `stupid tokens` title.
- Generated `favicon.png` (32px), `apple-touch-icon.png` (180px), and `og.png` (1200x630) from the supplied mark with ImageMagick, so the tab icon and link preview match.
- Documented endpoint behaviour on the page: identity as `chainId` plus `address`, `native` for native currencies, market-cap-ordered search, the per-item price statuses, the five-minute refresh cooldown, request limits, and the upstream sources.

## Convergence fixes

- Diagnosed why the catalog could never stay complete: skipped chains recorded no timestamp, so the 68 chains whose lists are empty or missing were re-fetched on every single run forever; and the 24-hour metadata gate made every imported chain due daily, so a single three-minute daily pass faced ~275 fetches.
- Added `checked_at` and `sync_status` to `chains` (migration 0004). Successful imports record both; skipped or failed chains record the outcome without touching `synced_at`, so they no longer stay permanently due.
- Retry cadences are now outcome-aware: a transient failure (throttling or a 5xx) is retried after 6 hours, a permanently unavailable list after 7 days, and successful metadata is refreshed after 7 days. Previously every non-success stayed due forever and every success expired daily.
- Raised the metadata refresh gate from 24 hours to 7 days. Token lists change slowly, so the due set drops from the whole catalog to a small remainder.
- Reduced token-list retry attempts from five to two and removed the in-run retry pass, since failures are now retried by the next scheduled run.
- Changed the cron from daily to every six hours, and gated the upstream-heavy market-cap refresh to once per day so it does not multiply upstream load.
- Added tests that a recently checked unavailable chain is not re-fetched, that it is re-checked once its gate lapses, and that a throttled chain retries sooner than a permanently unavailable one.

## Bulk request cap

- Reduced the bulk price request limit from 100 to 50 tokens, matching the intended usage and keeping a single request well inside Workers subrequest limits. Updated the landing page, API documentation, and the validation test.

## Cacheable bulk prices

- Investigated why `POST /v1/prices` could not be cached: Workers Cache only caches GET/HEAD, the response was explicitly `no-store`, and a request body cannot form a cache key. Confirmed against the Workers Cache documentation that enabling it serves responses without running the Worker, is tiered by default, and collapses concurrent requests for the same key into one invocation.
- Added `GET /v1/prices?tokens=chainId:address,...` as the preferred form, capped at 50 tokens. Tokens are sorted and deduplicated, and non-canonical requests receive a cacheable `308` to the canonical URL so ordering and address casing cannot fragment the cache.
- Responses carry `Cache-Control: public, max-age=N` where `N` is the shortest remaining freshness in the batch: the earlier of the next permitted refresh and the source timestamp plus 300 seconds, capped at 300. A lifetime of zero or less returns `no-store`. A stale batch is cached only until a refresh becomes possible. `stale-while-revalidate` is deliberately not used because it would serve data beyond the documented five-minute limit.
- Refactored price assembly into a shared `loadPrices` used by both forms. The bulk path now uses a single batched D1 read instead of a per-token Cache API fan-out, and only tokens whose cooldown has lapsed reach the coordinator, removing up to 50 subrequests per request.
- `POST` remains supported with identical semantics but is always `no-store`.
- Workers Cache itself is not yet enabled; the response headers are correct, so enabling it is a configuration-only change once the entrypoint headers above are live.

## Cache-Control for Workers Cache readiness

- Audited every endpoint before enabling Workers Cache and found that `no-cache` on search and token metadata would defeat caching entirely: per the Workers Cache documentation, `no-cache` stores the response but revalidates inline with the Worker on every request, so the Worker runs and CPU is billed on every hit.
- Search is now `public, max-age=60`, matching its internal edge-cache window. Token metadata is `public, max-age=60, stale-while-revalidate=3600`, which is safe because metadata only changes on catalog sync. A not-found token answer is equally stable and carries the same header.
- `GET /v1` now states `public, max-age=3600` explicitly. It previously had no `Cache-Control` at all, which under Workers Cache would have been cached for two hours by RFC 9111 heuristic freshness rather than by intent.
- Documented that migrations are not run by the Workers Builds deploy, so schema changes must be applied with `wrangler d1 migrations apply --remote` after deploying. Migration 0004 was found unapplied in production, which would have broken the next scheduled sync.

## Verified in production

- Convergence confirmed after applying migration 0004: one bounded pass imported 11 chains and cleared the backlog to `pendingChains: 0`, and subsequent passes report `complete` with `0` pending and `0` failures in about **1.5 seconds**, down from 180 seconds per pass. A steady-state sync now costs almost nothing.
- Final chain accounting across 275 discovered platforms: 187 synchronized, 68 unavailable (re-checked after 7 days), 20 failed (retried after 6 hours), and **0 never seen**. Nothing is permanently due, which was the original defect.
- Catalog holds 26,485 tokens across 187 chains.
- Market-cap backfill converged after the progress and gating fixes: two runs (2,355 then 1,091 assets) reported `complete: true`, and every subsequent run reports zero work in about one second. Final coverage is 7,852 of 26,485 assets with a cap and 22,079 recorded as checked. The remaining 18,633 have no resolvable cap because they are long-tail tokens on chains the price sources do not index, so they sort last by design and are re-checked after the seven-day window rather than blocking progress.
- Verified the fix against the exact token that had stalled: a Base token with a 4.45M market cap on DexScreener previously stayed NULL and now resolves.
- Search ordering is confirmed working against live data: a `usdc` search returns deployments ordered by descending market cap across chains.
- Per-deployment market caps are visibly independent, for example USDC resolving to slightly different values on different chains because each comes from that chain's own DEX data. This is the intended consequence of the per-deployment design rather than a shared global cap.
- Market-cap coverage was far from converged: 24,146 of 26,485 assets had never had a cap fetched, so ranked search only showed the seeded minority and Base USDC was absent from `q=usdc`. A demand price request (`POST /v1/prices`) fills the cap immediately, and the resumable backfill now converges faster because a throttled GeckoTerminal is dropped after its first failed batch instead of being retried on every batch.
- Price serving verified end to end against live sources: DefiLlama supplied prices, DexScreener supplied market caps, and native currencies priced correctly on five chains.

## Logo resolution

- Investigated low-resolution `imageUrl` values in API responses. The token-list import stored CoinGecko's `logoURI` verbatim, and every one of the 5,851 logos in the Ethereum list (and 100% of sampled entries across lists) uses the 25x25 `/thumb/` variant on `assets.coingecko.com`. The 250x250 `/large/` variant is the same asset at the same URL with a different size segment, so it costs no extra upstream request.
- GeckoTerminal already returns `/large/`, but its images only reach the API as a fallback when the token-list image is the `tokens.image_url` null case, so the low-resolution thumbnail won for essentially every imported token.
- Added `normalizeImageUrl`, which rewrites `/thumb/` to `/large/` only for the `assets.coingecko.com` and `coin-images.coingecko.com` hosts, leaving unrelated hosts untouched. It is applied to token-list logos during import and to GeckoTerminal images when quotes are built.
- Added migration `0005_normalize_image_size.sql`, which rewrites already-stored `/thumb/` URLs in `tokens.image_url` and `assets.image_url` so existing rows are fixed without waiting for a full re-sync. The normalized import also changes the per-chain content hash, so the next sync re-imports lists and reconciles any rows the migration missed.
- Verified the three size variants live for USDC: `/thumb/` is 25x25 (983 B), `/small/` is 50x50 (2.3 KB), and `/large/` is 250x250 (19 KB); a random sample of twelve `/large/` rewrites all returned HTTP 200.
- Added a Workers-runtime test asserting that a CoinGecko `/thumb/` logo is stored as `/large/` and that a non-CoinGecko host containing `/thumb/` is left unchanged.

## Landing page refresh

- Reworded the landing page around the product description "chain-agnostic token search and bulk token pricing API" and updated its meta and Open Graph descriptions to match.
- Refreshed the landing page docs against the implementation: added the `GET /v1` index to the endpoint table, documented that `q` is 2–100 characters and that `limit` defaults to 20, updated the sample search `imageUrl` to the `/large/` variant, corrected the stale-cache wording (a stale batch is cached only until a refresh is permitted, or served `no-store` when one already is), and noted that images use the largest available size.
- Added the preferred `GET /v1/prices` and `GET /health` to the machine-readable `GET /v1` endpoint index, which previously listed only the uncached `POST` form.

## Backfill progress and source gating

- Found in production that the market-cap backfill stalled: coverage sat at 4,406 of 26,485 assets across successive runs. Two distinct causes, both variations of the "permanently due" defect fixed earlier for chains.
- **Unresolvable caps blocked progress.** Assets whose cap no source can provide stayed NULL, and the selection query ordered NULLs first, so every run re-attempted the same uncappable assets and never reached the rest. Verified with a live counter-example: a Base token with a 4.45M market cap on DexScreener remained NULL because the run never got to it. Added `migrations/0005_asset_market_cap_checked_at.sql`; every attempted asset records `market_cap_checked_at` whether or not a cap was resolved, and selection now requires both a stale cap and a lapsed check window (7 days).
- **A throttled source was re-probed on every batch.** GeckoTerminal returns 429 to Cloudflare egress, so each 60-asset batch paid a failing request (with retries and backoff) before falling back to DexScreener. Added a per-run `SourceGate` circuit breaker: once a gated source reports throttling it is skipped for the remainder of that invocation, while ungated sources keep serving. Only GeckoTerminal is gated, so the primary price source and the last remaining fallback can never be silenced by a sibling's error.
- `trySources` now counts _attempted_ sources rather than all loaders when deciding whether every source failed, so skipping a gated source cannot be mistaken for total upstream failure.
- Added tests covering the gate (a throttled GeckoTerminal is dropped for the rest of a run while fallback caps still land) and progress (an unresolvable cap records its attempt, is not re-selected immediately, and becomes due again once the check window lapses).

## GET-only bulk prices

- Removed `POST /v1/prices`. Bulk prices are served only from the canonical, cacheable `GET /v1/prices?tokens=...`, so the response can always sit in front of the Worker. This is a breaking change for callers that used the JSON body; the `POST` form was never cacheable because a request body cannot form a cache key.
- Removed the now-unused `bodyLimit` middleware and the 32 KiB body limit, since no public endpoint accepts a request body. Also removed the `415` content-type check and the `413` body-too-large response.
- Because the only request is canonical, the response has one entry per canonical token in canonical order; the previous "one entry per input, including duplicates" behaviour only existed for the body form.
- Updated the `GET /v1` endpoint index, the landing page, `docs/api.md`, and `docs/architecture.md`, and refactored the bulk-price tests onto the GET form.

## Price changes (1h, 24h, 7d)

- Added percent price changes over 1h, 24h, and 7d to bulk price responses as `priceChange: { h1, h24, d7 }`, each a percentage string or `null`. The value is a percentage (`1.5` means +1.5%), not a ratio.
- The source is DefiLlama's address-keyed `percentage` endpoint, already on the primary provider, so no new upstream or identity mapping was introduced. It accepts one period per request and returns a percentage directly, so a fully covered refresh batch costs three additional requests (1h, 24h, 7d). Each period is isolated: a failing period is logged and skipped, and only a total failure marks the changes unavailable, so a secondary failure can never discard the primary price.
- Added `migrations/0006_asset_price_changes.sql` with `change_1h`, `change_24h`, `change_7d`, and `changes_updated_at`. The percentage endpoint carries no source timestamp, so the fetch time is stored and change writes are guarded by it, mirroring the market-cap guard. A failed or partial change fetch leaves previously stored changes untouched rather than clearing them.
- Changes are merged independently of the price source and are withheld from a response whenever the entry is not `ok`, so a stale, unavailable, or failed price never reports changes. GeckoTerminal and DexScreener supply no changes, so a token priced only by a DEX fallback has none.
- Renamed the `writeQuotes` flag from `updateMarketCap` to `writeSourceValues`, since it now guards both market caps and price changes.
- Added runtime tests: changes are served and stored with one request per window; a failed percentage endpoint keeps the price and previously stored changes; and a stale or unknown token reports null changes. Updated the DefiLlama call-counting helpers to separate the price endpoint from the percentage calls.
- Updated the landing page, `docs/api.md`, and `docs/architecture.md`.
- Migration 0006 was applied remotely (`wrangler d1 migrations apply --remote`) before deploying the Worker, and the live `/v1/prices` response was verified to include sane changes (native ETH roughly +3.2% over 24h and +5.5% over 7d; USDC near flat). Migrations are not run by the Workers Builds deploy, so schema changes must always be applied before the code that reads them goes live.

## Token metadata in bulk price responses

- Bulk price entries now include `name`, `symbol`, `decimals`, `imageUrl`, and `metadataUpdatedAt`, so a caller can render a token list without a separate metadata request per token. Fields are `null` for a `not_found` token, keeping the entry shape stable.
- The data comes from the same cached identity lookup (`getTokens`, namespace `price-identities`) that `loadPrices` already performs to resolve each price, so no additional D1 query, upstream request, or cache namespace was introduced.
- `priceResponse` gained an optional `metadata` argument; `loadPrices` passes the already-fetched token row. The edge `Cache-Control` calculation is unchanged because metadata only changes on catalog sync.
- Added a runtime test asserting populated metadata for a known token, null metadata for an unknown token, and that no extra upstream call is made. Updated the landing page and `docs/api.md`/`docs/architecture.md` samples.

## Landing page accuracy pass

- Refreshed the landing page against the current implementation: documented `priceChange` and the price-entry metadata fields, added `metadataUpdatedAt` to the bulk-price sample, and noted that a 2-character search query matches prefixes rather than substrings.
- Corrected the sources copy: DefiLlama is the source of prices and percent price changes, while GeckoTerminal and DexScreener provide liquidity-gated price fallbacks and market caps (GeckoTerminal also fills a missing image). The page previously implied the DEX sources supplied no prices.
- Updated the page title/Open Graph descriptions to mention price changes and token metadata, and removed the word "keyless" from the descriptions (the copy already states "no API key").
