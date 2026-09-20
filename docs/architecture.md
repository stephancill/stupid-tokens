# Architecture

## Product contract

Public, keyless EVM token metadata, name/symbol/address search ordered by market cap, and USD bulk pricing. A request accepts up to 50 mixed-chain tokens. Native currencies use `native` as the address. Unknown tokens and unavailable prices have explicit per-item statuses.

Token lists provide deployment metadata, including decimals and nullable images. Prices and market caps come from address-keyed providers, so identity is always `chainId + address` and no provider coin-ID mapping is required.

Price and market-cap sources are tried in order and merged per field:

1. **DefiLlama** (`coins.llama.fi`) is the primary price source. It accepts large batches, returns a source `timestamp` and a `confidence`, and supports native currencies through the zero address. It does not provide market caps.
2. **GeckoTerminal** (`api.geckoterminal.com`) supplies per-deployment market caps and images, and acts as a price fallback. It is queried per network with up to 30 addresses and reports pool liquidity.
3. **DexScreener** (`api.dexscreener.com`) is the long-tail fallback, queried through the chain-scoped `/tokens/v1/{chain}/{addresses}` endpoint. Its unscoped endpoint ignores the chain, so it must not be used. A token can have many pairs, so only the deepest-liquidity pair is considered.

DEX-derived prices are trivially manipulable in thin pools, so GeckoTerminal and DexScreener values are only accepted when pool liquidity meets a minimum. DefiLlama prices are aggregated and additionally require a minimum reported confidence. Market cap is per deployment rather than one global value shared across chains, which matches the chain-specific token list.

Provider chain slugs are derived from the CoinGecko platform ID with a small alias table, and GeckoTerminal network slugs are discovered from its `/networks` endpoint because they differ (`eth` versus `ethereum`). CoinGecko remains in use only for the chain list and public token lists; the large `/coins/list` mapping call is no longer needed.

Prices refresh only on demand. A source asset gets at most one upstream attempt in a rolling 300-second interval, including failed attempts. The interval starts immediately before dispatch, and persists across coordinator eviction. Price age uses the source timestamp; cache lifetime uses the attempt timestamp. The API exposes both and reports stale source prices explicitly rather than implying that a recent fetch guarantees recent source data.

Search uses the latest stored market caps, with null values last and chain/address tie-breakers. Market caps are seeded by an operator backfill, refreshed alongside demand-driven price requests, and refreshed by the nightly job for assets whose caps are missing or older than seven days. Less-used assets may have old market caps. The displayed value is the value used for sorting. A backfill that runs out of time leaves unseeded assets for the next run and is not recorded as complete.

## Runtime

- Hono Worker: validation, CORS, public endpoints, bounded edge caching.
- Bulk prices are served from a canonical `GET` so responses can be cached in front of the Worker. The lifetime is the shortest remaining freshness across the batch, bounded by both the refresh interval and the source timestamp, so a cached response can never outlive the five-minute freshness limit. A `POST` form remains for callers that cannot build a URL, and is never cached.
- D1: chains, assets, deployment metadata, FTS5 trigram search, quotes, sync state.
- One SQLite-backed Durable Object: micro-batches cache misses, shares in-flight work, persists per-asset refresh reservations and provider budgets, and writes results back to D1. The object handles refresh traffic; cached price reads use D1 or the edge cache.
- Daily Cron Trigger: refreshes metadata only. Prices have no polling schedule.

Name/symbol queries of at least three characters use indexed substring matching. Two-character queries use indexed prefixes. Exact addresses use an address index. All candidate matches are sorted before applying the limit.

Chain coverage is discovered on every catalog synchronization from CoinGecko's `/asset_platforms`. Platforms with a positive, safe-integer `chain_identifier` (CoinGecko's Chainlist/EIP-155 ID) are candidates; platforms with a null ID are excluded. Platform IDs are preserved and URL-encoded when downloading `https://tokens.coingecko.com/{platformId}/all.json`. Duplicate chain IDs are rejected.

Token lists are community maintained, so entries are sanitized instead of trusted: entries without a valid EVM address, with a chain ID that does not match the target chain, or without a name are discarded and counted per chain. A list that yields no valid entries is reported as `empty_token_list`. Discarding is non-fatal so one bad row cannot block a chain.

Each imported list is hashed over its normalized contents. A sync skips a chain whose stored hash is unchanged, so repeat and nightly syncs only re-import chains whose lists actually changed and only re-fetch chains that previously failed.

Native currency names, symbols, and decimals come from the public `https://chainid.network/chains.json` registry, validated with Zod and joined by chain ID. Registry membership does not limit contract-token coverage. When native metadata is missing, contract tokens still import and the report identifies the missing native metadata; decimals are never guessed. If the registry knows the currency but CoinGecko has no native asset mapping, native metadata imports with unavailable pricing.

Imports run serially with a short gap and brief retries because the token-list CDN throttles concurrent and rapid requests. Upstream requests send a descriptive `User-Agent`, which CoinGecko requires for keyless access; requests without one receive HTTP 403. Transient throttling (HTTP 403/429) and server errors are retried with exponential backoff, and chains still throttled after the bulk sweep are retried once more. Throttled chains are reported as failures if the retry also fails, and are picked up by the next sync.

Other HTTP, validation, and import failures are recorded per chain; successful chains remain usable. Unavailable lists (HTTP 404/410) and valid empty lists are non-degrading skips, because many listed platforms legitimately publish no token list. A structured `catalog_sync_report` is persisted in D1 and returned to operators. Each sync invocation is bounded to roughly eight minutes and always writes its report, so a large catalog converges over successive runs; deferred chains are reported in `pending` with `budgetExhausted`. Readiness requires only a usable catalog, so partial coverage is a warning rather than an outage, and the sync endpoint returns HTTP 503 only when nothing could be imported and no catalog exists. Existing data is retained for unavailable or failed chains; `syncedAt` remains the last valid import time for each such chain.

## Cost controls

Bulk limits, shared 300-second reservations, provider-level request budgets, short-lived shared edge caches, and change-only catalog upserts bound work. Public requests cannot start metadata imports or market-cap seeding. Unknown tokens never trigger upstream lookups.

None of the price sources require an API key. DefiLlama accepts large batches; GeckoTerminal and DexScreener accept 30 addresses per request, so one 100-token bulk request costs a small, fixed number of upstream calls per refresh. Keyless sources share low, contended rate pools, so the default request budget is deliberately conservative and the nightly job refreshes only metadata that is due rather than polling continuously.

Upstream data access and public data redistribution are separate concerns; production operation requires appropriate upstream terms.
