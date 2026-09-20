import { CHAIN_REGISTRY_URL, discoverChains } from "./chains";
import { apiJson, fetchJson, priceBatch } from "./coingecko";
import { setState, stateValue } from "./database";
import type { Env } from "./types";
import {
  catalogReportSchema,
  chainRegistrySchema,
  coinsSchema,
  marketsSchema,
  platformsSchema,
  tokenListSchema,
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

export async function importChain({
  db,
  chain,
  tokens,
  now,
}: {
  db: D1Database;
  chain: { id: number; name: string; platform: string };
  tokens: CatalogToken[];
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
    db.prepare("UPDATE chains SET synced_at = ? WHERE id = ?").bind(now, chain.id),
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
  const result = await env.DB.prepare(`INSERT INTO app_state(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_state.value AS INTEGER) < ? RETURNING value`)
    .bind(key, owner, now - 3_600_000)
    .first<{ value: string }>();
  if (result?.value !== owner) throw new Error("An import is already running");
  try {
    return await run();
  } finally {
    await env.DB.prepare("DELETE FROM app_state WHERE key = ? AND value = ?")
      .bind(key, owner)
      .run();
  }
}

export async function syncCatalog({ env }: { env: Env }) {
  return withImportLock({
    env,
    key: "catalog_lock",
    run: async () => {
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
        const imported: { chainId: number; tokens: number }[] = [];
        const skipped: { chainId: number; reason: string }[] = [];
        const failures: { chainId: number; message: string }[] = [];
        const missingNativeMetadata: number[] = [];
        const missingNativeAssetId: number[] = [];
        let cursor = 0;
        async function importNextChains() {
          for (;;) {
            const chain = chains[cursor++];
            if (!chain) return;
            const identity = { chainId: chain.id };
            try {
              const list = tokenListSchema.parse(
                await fetchJson({
                  url: `https://tokens.coingecko.com/${encodeURIComponent(chain.platform)}/all.json`,
                  timeoutMs: 10_000,
                }),
              );
              if (!list.tokens.length) {
                skipped.push({ ...identity, reason: "empty_token_list" });
                continue;
              }
              const tokens: CatalogToken[] = list.tokens.map((token) => ({
                chainId: token.chainId,
                address: token.address,
                assetId: mapping.get(`${chain.platform}:${token.address}`) ?? null,
                name: token.name,
                symbol: token.symbol,
                decimals: token.decimals,
                imageUrl: token.logoURI ?? null,
              }));
              if (chain.native) {
                tokens.push({
                  chainId: chain.id,
                  address: "native",
                  assetId: chain.nativeAssetId,
                  ...chain.native,
                  imageUrl: null,
                });
              }
              await importChain({ db: env.DB, chain, tokens, now: Date.now() });
              imported.push({ ...identity, tokens: tokens.length });
              if (!chain.native) missingNativeMetadata.push(chain.id);
              if (!chain.nativeAssetId) missingNativeAssetId.push(chain.id);
            } catch (error) {
              if (
                error instanceof Error &&
                "upstreamStatus" in error &&
                (error.upstreamStatus === 404 || error.upstreamStatus === 410)
              ) {
                skipped.push({ ...identity, reason: `token_list_http_${error.upstreamStatus}` });
              } else {
                const message =
                  error instanceof Error ? error.message.slice(0, 2000) : "Unknown import error";
                failures.push({ ...identity, message });
                console.error("chain_import_failed", { ...identity, message });
              }
            }
          }
        }
        // Bound concurrent list parsing, network connections, and D1 writes across hundreds of chains.
        await Promise.all(Array.from({ length: 4 }, () => importNextChains()));
        const finishedAt = new Date().toISOString();
        const report = catalogReportSchema.parse({
          status: !imported.length ? "failed" : failures.length ? "partial" : "complete",
          discoveredChains: chains.length,
          chains: imported.length,
          tokens: imported.reduce((sum, chain) => sum + chain.tokens, 0),
          syncedAt: finishedAt,
          imported: imported.sort((a, b) => a.chainId - b.chainId),
          skipped: skipped.sort((a, b) => a.chainId - b.chainId),
          failures: failures.sort((a, b) => a.chainId - b.chainId),
          missingNativeMetadata: missingNativeMetadata.sort((a, b) => a - b),
          missingNativeAssetId: missingNativeAssetId.sort((a, b) => a - b),
        });
        const error =
          report.status === "complete"
            ? ""
            : `${report.status}: imported ${imported.length}/${chains.length} chains; ${failures.length} failed`;
        await setState({ db: env.DB, key: "catalog_sync_report", value: JSON.stringify(report) });
        await setState({ db: env.DB, key: "catalog_error", value: error });
        if (imported.length)
          await setState({ db: env.DB, key: "catalog_synced_at", value: finishedAt });
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

export async function seedMarketCaps({ env }: { env: Env }) {
  return withImportLock({
    env,
    key: "market_seed_lock",
    run: async () => {
      if (await stateValue({ db: env.DB, key: "market_caps_seeded_at" }))
        throw new Error("Market caps have already been seeded");
      const ids = (
        await env.DB.prepare(
          "SELECT DISTINCT asset_id AS id FROM tokens WHERE asset_id IS NOT NULL ORDER BY asset_id",
        ).all<{ id: string }>()
      ).results.map((row) => row.id);
      if (!ids.length) throw new Error("Sync the catalog before seeding market caps");
      let offset = 0;
      let count = 0;
      while (offset < ids.length) {
        const batch = priceBatch({ ids: ids.slice(offset, offset + 250) });
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
        const now = Date.now();
        const payload = markets.map((market) => ({
          id: market.id,
          image: market.image ?? null,
          cap: market.market_cap ?? null,
          updatedAt: market.last_updated ? Math.min(Date.parse(market.last_updated), now) : now,
        }));
        await env.DB.prepare(`UPDATE assets SET
        image_url = COALESCE(json_extract(m.value, '$.image'), assets.image_url),
        market_cap_usd = CASE WHEN COALESCE(assets.market_cap_updated_at, 0) <= json_extract(m.value, '$.updatedAt')
          THEN json_extract(m.value, '$.cap') ELSE assets.market_cap_usd END,
        market_cap_updated_at = MAX(COALESCE(assets.market_cap_updated_at, 0), json_extract(m.value, '$.updatedAt'))
        FROM json_each(?) m WHERE assets.id = json_extract(m.value, '$.id')`)
          .bind(JSON.stringify(payload))
          .run();
        count += markets.length;
        offset += batch.length;
        // Leave headroom under the Demo plan's minute limit during the one-time seed.
        if (offset < ids.length) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const finishedAt = new Date().toISOString();
      await setState({ db: env.DB, key: "market_caps_seeded_at", value: finishedAt });
      return { assets: count, seededAt: finishedAt };
    },
  });
}
