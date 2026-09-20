# API

The public API requires no key and supports CORS. Prices and market caps are USD. Monetary values are decimal strings or `null`. Times are ISO 8601 UTC strings.

Token identity is `{ chainId, address }`. EVM addresses are case-insensitive and normalized to lowercase. Native currencies use the literal address `native`. A source asset can have several chain deployments; its price and global market cap are shared.

Responses identify chains by numeric `chainId` and tokens by `chainId` plus `address`. CoinGecko platform IDs and asset IDs are internal implementation details and are not returned, including in operator reports. Detailed upstream errors are logged internally; response errors identify affected chains numerically.

## GET /v1/chains

Returns `{ "chains": [...] }` with `chainId`, `name`, `tokenCount`, and `syncedAt` for each imported chain.

Coverage is discovered automatically from CoinGecko's numeric EVM platform IDs and available token lists. This endpoint reports actual imported coverage rather than a fixed allowlist. New chains become available after a successful catalog synchronization.

Native currency metadata is joined by chain ID from the public Chain ID registry. Contract tokens can be supported even when native metadata is not yet available. A known native currency with no CoinGecko asset mapping has metadata but unavailable pricing. Previously imported chains retain their last valid data if a subsequent list download is unavailable or fails; inspect each chain's `syncedAt` for its last successful import.

## GET /v1/search

Query parameters:

| Parameter | Behavior                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`       | Required, 2–100 characters after trimming. Case-insensitive name/symbol substring for 3+ characters; name/symbol prefix for 2 characters; exact match for a full contract address. |
| `chainId` | Optional positive EVM chain ID.                                                                                                                                                    |
| `limit`   | 1–100, default 20.                                                                                                                                                                 |

```sh
curl 'http://localhost:8787/v1/search?q=usdc&chainId=8453&limit=20'
```

Returns `{ "tokens": [...] }` in **market-cap descending order**, with unknown caps last. Equal caps sort by chain ID, then address. Sorting happens before the limit; name/symbol relevance never overrides market-cap order. Each result is a chain-specific deployment.

Search uses stored caps and makes no upstream requests. Market caps are initially seeded, then updated when prices are requested. A rarely requested asset can have an old cap. `marketCapUpdatedAt` exposes its age. Search results are edge-cached for up to 60 seconds.

## GET /v1/tokens/{chainId}/{address}

Returns metadata, or HTTP 404 if the deployment is absent from the catalog:

```json
{
  "chainId": 8453,
  "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "name": "USDC",
  "symbol": "USDC",
  "decimals": 6,
  "imageUrl": "https://example.com/usdc.png",
  "marketCapUsd": "1000000000",
  "marketCapUpdatedAt": "2026-09-20T12:00:00.000Z",
  "metadataUpdatedAt": "2026-09-20T03:00:00.000Z"
}
```

Values above are illustrative. Image URLs and market caps may be null. A source-provided empty symbol is preserved rather than invented. Metadata lookup returns the stored market cap and does not trigger a price refresh.

## POST /v1/prices

Requires `Content-Type: application/json`. Accepts 1–100 tokens across any supported chains, with a maximum body size of 32 KiB.

```sh
curl 'http://localhost:8787/v1/prices' \
  -H 'Content-Type: application/json' \
  --data '{"tokens":[{"chainId":1,"address":"native"},{"chainId":8453,"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}]}'
```

```json
{
  "currency": "usd",
  "prices": [
    {
      "chainId": 1,
      "address": "native",
      "status": "ok",
      "priceUsd": "2500.12",
      "priceUpdatedAt": "2026-09-20T12:00:00.000Z",
      "marketCapUsd": "300000000000",
      "marketCapUpdatedAt": "2026-09-20T12:00:00.000Z",
      "fetchedAt": "2026-09-20T12:00:10.000Z",
      "nextRefreshAt": "2026-09-20T12:05:09.950Z"
    }
  ]
}
```

The response has one entry per input, in input order, including duplicates. A valid batch receives HTTP 200 even when individual items are unavailable:

| Status              | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `ok`                | Price is available and its source timestamp is at most 300 seconds old.          |
| `stale`             | The cached source timestamp is older than 300 seconds; `priceUsd` is null.       |
| `not_found`         | Chain/address is absent from the imported catalog.                               |
| `price_unavailable` | No asset mapping, source price, or valid source timestamp is available.          |
| `upstream_error`    | The upstream request failed, or a coordinator restart interrupted it.            |
| `rate_limited`      | Provider throttling or the configured shared request budget prevented a refresh. |

Only `ok` carries a non-null price. A recent fetch can contain old source data. For example, if CoinGecko's quote is already 60 seconds old when fetched, it becomes `stale` 240 seconds later; the next attempt is still allowed only at the end of the 300-second cooldown. This explicitly preserves both the source-freshness limit and the upstream-call limit.

The rolling cooldown applies to attempts, including failures, and is shared across callers and mapped deployments. Concurrent requests wait on the same in-flight work. Failed items do not silently reuse old prices. Budget checks that prevent an upstream attempt can be retried earlier, as indicated by `nextRefreshAt`.

Responses use `Cache-Control: no-store`; the Worker internally caches raw per-asset quotes and evaluates source freshness on every response. Search and metadata use `no-cache` downstream to prevent extending their internal edge-cache lifetime.

## Errors and health

- HTTP 400: invalid request data or malformed JSON.
- HTTP 404: unknown endpoint or missing single-token metadata.
- HTTP 413: body too large.
- HTTP 415: price request is not JSON.
- HTTP 503: catalog not initialized or service/storage failure.

Error responses have `{ "error": { "code": "...", "message": "..." } }`.

`GET /health` returns `ready`, `catalogSyncedAt`, and `catalogError`. Readiness means at least one chain has been successfully imported during a completed synchronization. HTTP 503 indicates an uninitialized catalog or a degraded synchronization; successfully imported and previously stored data remain available through the public API during partial failures. `catalogSyncedAt` is the last completed run that imported at least one chain.

## Operator endpoints

All require `Authorization: Bearer <ADMIN_TOKEN>`:

- `POST /admin/sync`: discover EVM platforms and import their available token lists. Returns a report with `status` (`complete`, `partial`, or `failed`), `discoveredChains`, `chains`, `tokens`, `pendingChains`, `syncedAt`, and arrays of `imported`, `skipped`, `failures`, `missingNativeMetadata`, and `missingNativeAssetId`. Returns HTTP 503 for partial or failed synchronization.
- `POST /admin/seed-market-caps`: backfill market caps and images across the catalog, initially and after new chains are added. It does not populate or refresh prices. Returns `assets`, `complete`, `remaining`, and `seededAt`. Runs are resumable: a run that exhausts its time budget reports `complete: false` with the remaining count, and a later run continues where it left off. It is not a one-shot endpoint and may be called repeatedly. The nightly job also refreshes caps for assets whose caps are missing or older than seven days.
- `GET /admin/status`: catalog state and token/asset counts.

Every `imported`, `skipped`, or `failures` entry identifies its chain with `chainId`. Both missing-native arrays contain numeric chain IDs, not provider asset IDs. For example, an imported entry is `{ "chainId": 146, "tokens": 100 }`. `imported` entries also include `discarded`, the number of malformed or wrong-chain list entries skipped for that chain. `skipped` reasons are `unchanged`, `empty_token_list`, `token_list_http_404`, and `token_list_http_410`. `pendingChains` counts chains that produced neither an import, a skip, nor a failure.

The daily cron refreshes metadata and refreshes stale or missing market caps. Keep the HTTP connection open while a manual import/seed runs; these can take minutes for a full catalog. A failed import retains existing data, and a market-cap backfill can be safely re-run until it reports `complete: true`. Per-chain pruning happens only after that chain's validated import completes. Missing lists (HTTP 404/410) and valid empty lists are explicitly reported as skipped. Other errors fail that chain's import, appear in `failures`, and make the overall run partial/failed. The most recent completed report is also stored as `catalog_sync_report` in `/admin/status`.
