import { CHAIN_REGISTRY_URL, discoverChains } from "./chains";
import { apiJson, fetchJson, priceBatch } from "./coingecko";
import { setState, stateValue } from "./database";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import {
  catalogReportSchema,
  chainRegistrySchema,
  coinsSchema,
  marketsSchema,
  platformsSchema,
  tokenListSchema,
  type TokenListToken,
} from "./validation";

export type CatalogToken = {
  chainId: number;
  address: string;
  assetId: string | null;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl: string | null;
};

export function contentHash({ tokens }: { tokens: CatalogToken[] }) {
  const canonical = tokens
    .map((token) =>
      [
        token.chainId,
        token.address,
        token.assetId ?? "",
        token.name,
        token.symbol,
        token.decimals,
        token.imageUrl ?? "",
      ].join("\u0000"),
    )
    .join("\u0001");
  const bytes = new TextEncoder().encode(canonical);
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

// Token lists are community maintained and contain invalid or misplaced entries.
function parseTokens({ chainId, list }: { chainId: number; list: TokenListToken[] }) {
  const tokens: CatalogToken[] = [];
  let discarded = 0;
  for (const token of list) {
    if (!EVM_ADDRESS.test(token.address) || token.chainId !== chainId || !token.name) {
      discarded++;
      continue;
    }
    tokens.push({
      chainId,
      address: token.address,
      assetId: null,
      name: token.name,
      symbol: token.symbol ?? "",
      decimals: token.decimals ?? 18,
      imageUrl: token.logoURI ?? null,
    });
  }
  return { tokens, discarded };
}

export async function importChain({
  db,
  chain,
  tokens,
  hash,
  now,
}: {
  db: D1Database;
  chain: { id: number; name: string; platform: string };
  tokens: CatalogToken[];
  hash?: string;
  now: number;
}) {
  if (tokens.length === 0 || tokens.some((token) => token.chainId !== chain.id))
    throw new Error(`Invalid token list for chain ${chain.id}`);
  const unique = new Map(tokens.map((token) => [token.address, token]));
  if (unique.size !== tokens.length)
    throw new Error(`Duplicate token addresses in chain ${chain.id}`);
  await db
    .prepare(`INSERT INTO chains(id, name, platform_id) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform_id = excluded.platform_id`)
    .bind(chain.id, chain.name, chain.platform)
    .run();
  for (let offset = 0; offset < tokens.length; offset += 200) {
    const payload = JSON.stringify(tokens.slice(offset, offset + 200));
    await db.batch([
      db
        .prepare(`INSERT INTO assets(id) SELECT DISTINCT json_extract(value, '$.assetId') FROM json_each(?)
        WHERE json_extract(value, '$.assetId') IS NOT NULL ON CONFLICT(id) DO NOTHING`)
        .bind(payload),
      db
        .prepare(`INSERT INTO tokens(chain_id, address, asset_id, name, symbol, decimals, image_url, metadata_updated_at)
        SELECT json_extract(value, '$.chainId'), json_extract(value, '$.address'), json_extract(value, '$.assetId'),
          json_extract(value, '$.name'), json_extract(value, '$.symbol'), json_extract(value, '$.decimals'), json_extract(value, '$.imageUrl'), ?
        FROM json_each(?) WHERE 1 ON CONFLICT(chain_id, address) DO UPDATE SET
          asset_id = excluded.asset_id, name = excluded.name, symbol = excluded.symbol,
          decimals = excluded.decimals, image_url = excluded.image_url, metadata_updated_at = excluded.metadata_updated_at
        WHERE tokens.asset_id IS NOT excluded.asset_id OR tokens.name IS NOT excluded.name OR tokens.symbol IS NOT excluded.symbol
          OR tokens.decimals IS NOT excluded.decimals OR tokens.image_url IS NOT excluded.image_url`)
        .bind(now, payload),
    ]);
  }
  // Prune only after a complete, validated chain import. Failed downloads never clear a catalog.
  await db.batch([
    db
      .prepare(
        "DELETE FROM tokens WHERE chain_id = ? AND address NOT IN (SELECT value FROM json_each(?))",
      )
      .bind(chain.id, JSON.stringify(tokens.map((token) => token.address))),
    db
      .prepare("UPDATE chains SET synced_at = ?, content_hash = ? WHERE id = ?")
      .bind(now, hash ?? null, chain.id),
  ]);
}

async function withImportLock<T>({
  env,
  key,
  run,
}: {
  env: Env;
  key: string;
  run: () => Promise<T>;
}) {
  const now = Date.now();
  const owner = `${now}:${crypto.randomUUID()}`;
  // A killed invocation never releases its lock, so expire stale locks quickly.
  const result = await env.DB.prepare(`INSERT INTO app_state(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_state.value AS INTEGER) < ? RETURNING value`)
    .bind(key, owner, now - 10 * 60_000)
    .first<{ value: string }>();
  if (result?.value !== owner)
    throw new HTTPException(409, { message: "An import is already running" });
  try {
    return await run();
  } finally {
    await env.DB.prepare("DELETE FROM app_state WHERE key = ? AND value = ?")
      .bind(key, owner)
      .run();
  }
}

export async function syncCatalog({ env, budgetMs = 3 * 60_000 }: { env: Env; budgetMs?: number }) {
  return withImportLock({
    env,
    key: "catalog_lock",
    run: async () => {
      // Bound each invocation so a run always finishes and records its report. Remaining
      // chains are reported and picked up by the next run.
      const deadline = Date.now() + budgetMs;
      try {
        const [coins, platforms, registry] = await Promise.all([
          apiJson({ env, path: "/coins/list", query: { include_platform: "true" } }).then((data) =>
            coinsSchema.parse(data),
          ),
          apiJson({ env, path: "/asset_platforms" }).then((data) => platformsSchema.parse(data)),
          fetchJson({ url: CHAIN_REGISTRY_URL }).then((data) => chainRegistrySchema.parse(data)),
        ]);
        const chains = discoverChains({ platforms, registry });
        if (!chains.length) throw new Error("CoinGecko returned no EVM platforms");
        const mapping = new Map<string, string>();
        for (const coin of coins) {
          for (const [platform, address] of Object.entries(coin.platforms ?? {})) {
            if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) continue;
            const key = `${platform}:${address.toLowerCase()}`;
            const previous = mapping.get(key);
            if (previous && previous !== coin.id)
              throw new Error(`Ambiguous CoinGecko mapping: ${key}`);
            mapping.set(key, coin.id);
          }
        }
        const imported: { chainId: number; tokens: number; discarded: number }[] = [];
        const skipped: { chainId: number; reason: string }[] = [];
        const failures: { chainId: number; message: string }[] = [];
        const missingNativeMetadata: number[] = [];
        const missingNativeAssetId: number[] = [];
        const retryable: typeof chains = [];
        const existingHashes = new Map(
          (
            await env.DB.prepare(
              "SELECT id, content_hash FROM chains WHERE content_hash IS NOT NULL",
            ).all<{
              id: number;
              content_hash: string;
            }>()
          ).results.map((row) => [row.id, row.content_hash]),
        );
        const alreadySynced =
          (
            await env.DB.prepare(
              "SELECT COUNT(*) AS count FROM chains WHERE synced_at IS NOT NULL",
            ).first<{ count: number }>()
          )?.count ?? 0;

        async function importOneChain({
          chain,
          retry = false,
        }: {
          chain: (typeof chains)[number];
          retry?: boolean;
        }) {
          const identity = { chainId: chain.id };
          try {
            const list = tokenListSchema.parse(
              await fetchJson({
                url: `https://tokens.coingecko.com/${encodeURIComponent(chain.platform)}/all.json`,
                timeoutMs: 10_000,
                attempts: 5,
              }),
            );
            if (!list.tokens.length) {
              skipped.push({ ...identity, reason: "empty_token_list" });
              return;
            }
            const { tokens, discarded } = parseTokens({ chainId: chain.id, list: list.tokens });
            for (const token of tokens)
              token.assetId = mapping.get(`${chain.platform}:${token.address}`) ?? null;
            if (chain.native) {
              tokens.push({
                chainId: chain.id,
                address: "native",
                assetId: chain.nativeAssetId,
                ...chain.native,
                imageUrl: null,
              });
            }
            if (!tokens.length) {
              skipped.push({ ...identity, reason: "empty_token_list" });
              return;
            }
            const hash = await contentHash({ tokens });
            if (existingHashes.get(chain.id) === hash) {
              skipped.push({ ...identity, reason: "unchanged" });
              return;
            }
            await importChain({ db: env.DB, chain, tokens, hash, now: Date.now() });
            imported.push({ ...identity, tokens: tokens.length, discarded });
            if (!chain.native) missingNativeMetadata.push(chain.id);
            if (!chain.nativeAssetId) missingNativeAssetId.push(chain.id);
          } catch (error) {
            const status =
              error instanceof Error && "upstreamStatus" in error ? error.upstreamStatus : null;
            if (status === 404 || status === 410) {
              skipped.push({ ...identity, reason: `token_list_http_${status}` });
            } else if (status === 429 || status === 403) {
              if (retry) {
                const message = "Throttled by the token-list CDN on retry";
                failures.push({ ...identity, message });
                console.error("chain_import_throttled", { ...identity, message });
              } else {
                retryable.push(chain);
              }
            } else {
              const message =
                error instanceof Error ? error.message.slice(0, 2000) : "Unknown import error";
              failures.push({ ...identity, message });
              console.error("chain_import_failed", { ...identity, message });
            }
          }
        }

        let cursor = 0;
        let budgetExhausted = false;
        // The token-list CDN throttles concurrent requests, so fetch serially with a small gap.
        async function importNextChains() {
          for (;;) {
            const chain = chains[cursor++];
            if (!chain) return;
            if (Date.now() > deadline) {
              budgetExhausted = true;
              cursor--;
              return;
            }
            await importOneChain({ chain });
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        await importNextChains();
        if (retryable.length && !budgetExhausted) {
          console.log("catalog_retrying_throttled_chains", { chains: retryable.length });
          for (const chain of retryable.sort((a, b) => a.id - b.id)) {
            if (Date.now() > deadline) {
              budgetExhausted = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await importOneChain({ chain, retry: true });
          }
        }
        const finishedAt = new Date().toISOString();
        const pending = chains
          .filter(
            (chain) =>
              !imported.some((item) => item.chainId === chain.id) &&
              !skipped.some((item) => item.chainId === chain.id) &&
              !failures.some((item) => item.chainId === chain.id),
          )
          .map((chain) => chain.id);
        const report = catalogReportSchema.parse({
          // Unavailable lists are a permanent, non-degrading skip. Only failures or deferred
          // chains make a usable catalog partial.
          status:
            imported.length || alreadySynced > 0
              ? failures.length || pending.length
                ? "partial"
                : "complete"
              : "failed",
          budgetExhausted,
          discoveredChains: chains.length,
          chains: imported.length,
          tokens: imported.reduce((sum, chain) => sum + chain.tokens, 0),
          pendingChains: pending.length,
          pending: pending.sort((a, b) => a - b),
          syncedAt: finishedAt,
          imported: imported.sort((a, b) => a.chainId - b.chainId),
          skipped: skipped.sort((a, b) => a.chainId - b.chainId),
          failures: failures.sort((a, b) => a.chainId - b.chainId),
          missingNativeMetadata: missingNativeMetadata.sort((a, b) => a - b),
          missingNativeAssetId: missingNativeAssetId.sort((a, b) => a - b),
        });
        // A usable catalog stays usable; partial coverage is a warning, not an outage.
        const usable = imported.length > 0 || alreadySynced > 0;
        const error =
          report.status === "complete"
            ? ""
            : `${report.status}: imported ${imported.length}/${chains.length} chains; ${failures.length} failed; ${pending.length} pending`;
        await setState({ db: env.DB, key: "catalog_sync_report", value: JSON.stringify(report) });
        await setState({ db: env.DB, key: "catalog_error", value: usable ? "" : error });
        if (usable) await setState({ db: env.DB, key: "catalog_synced_at", value: finishedAt });
        return report;
      } catch (error) {
        await setState({
          db: env.DB,
          key: "catalog_error",
          value: error instanceof Error ? error.message.slice(0, 2000) : "Unknown catalog error",
        });
        throw error;
      }
    },
  });
}

async function marketCapBatch({ env, ids, now }: { env: Env; ids: string[]; now: number }) {
  const batch = priceBatch({ ids });
  if (!batch.length) return 0;
  const markets = marketsSchema.parse(
    await apiJson({
      env,
      path: "/coins/markets",
      query: {
        ids: batch.join(","),
        vs_currency: "usd",
        per_page: "250",
        page: "1",
        sparkline: "false",
      },
    }),
  );
  const payload = markets.map((market) => ({
    id: market.id,
    image: market.image ?? null,
    cap: market.market_cap ?? null,
    updatedAt: market.last_updated ? Math.min(Date.parse(market.last_updated), now) : now,
  }));
  if (payload.length) {
    await env.DB.prepare(`UPDATE assets SET
      image_url = COALESCE(json_extract(m.value, '$.image'), assets.image_url),
      market_cap_usd = CASE WHEN COALESCE(assets.market_cap_updated_at, 0) <= json_extract(m.value, '$.updatedAt')
        THEN json_extract(m.value, '$.cap') ELSE assets.market_cap_usd END,
      market_cap_updated_at = MAX(COALESCE(assets.market_cap_updated_at, 0), json_extract(m.value, '$.updatedAt'))
      FROM json_each(?) m WHERE assets.id = json_extract(m.value, '$.id')`)
      .bind(JSON.stringify(payload))
      .run();
  }
  return payload.length;
}

// Caps keep search ordering meaningful, so they are refreshed on demand, by the nightly
// job for stale/missing values, and by the one-time backfill below.
export async function refreshMarketCaps({
  env,
  maxAgeMs,
  deadline,
}: {
  env: Env;
  maxAgeMs: number;
  deadline: number;
}) {
  const ids = (
    await env.DB.prepare(`SELECT DISTINCT t.asset_id AS id FROM tokens t
      JOIN assets a ON a.id = t.asset_id
      WHERE t.asset_id IS NOT NULL
        AND (a.market_cap_updated_at IS NULL OR a.market_cap_updated_at < ?)
      ORDER BY a.market_cap_usd IS NULL DESC, a.market_cap_usd DESC`)
      .bind(Date.now() - maxAgeMs)
      .all<{ id: string }>()
  ).results.map((row) => row.id);
  let updated = 0;
  let cursor = 0;
  let throttled = false;
  // Keyless upstreams throttle above a few requests per minute, so stay serial and gentle.
  while (cursor < ids.length) {
    if (Date.now() > deadline) {
      throttled = true;
      console.log("market_cap_refresh_deadline", { remaining: ids.length - cursor });
      break;
    }
    try {
      updated += await marketCapBatch({
        env,
        ids: ids.slice(cursor, cursor + 250),
        now: Date.now(),
      });
    } catch (error) {
      throttled = true;
      console.error("market_cap_refresh_failed", {
        remaining: ids.length - cursor,
        message: error instanceof Error ? error.message : "Unknown upstream failure",
      });
      break;
    }
    cursor += 250;
    if (cursor < ids.length) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return { updated, remaining: throttled ? ids.length - cursor : 0 };
}

export async function seedMarketCaps({ env }: { env: Env }) {
  return withImportLock({
    env,
    key: "market_seed_lock",
    run: async () => {
      if (!(await stateValue({ db: env.DB, key: "catalog_synced_at" })))
        throw new Error("Sync the catalog before seeding market caps");
      // Large backfill budget; the scheduled job keeps caps fresh afterwards.
      const { updated, remaining } = await refreshMarketCaps({
        env,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        deadline: Date.now() + 12 * 60_000,
      });
      const finishedAt = new Date().toISOString();
      if (!remaining)
        await setState({ db: env.DB, key: "market_caps_seeded_at", value: finishedAt });
      return { assets: updated, complete: !remaining, remaining, seededAt: finishedAt };
    },
  });
}
