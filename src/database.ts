import type { QuoteRow, TokenId, TokenRow } from "./types";

const tokenColumns = `t.chain_id, t.address, t.asset_id, t.name, t.symbol, t.decimals,
  COALESCE(t.image_url, a.image_url) AS image_url, t.metadata_updated_at,
  a.market_cap_usd, a.market_cap_updated_at`;
const quoteColumns = `id, price_usd, price_updated_at, market_cap_usd, market_cap_updated_at,
  fetched_at, last_attempt_at, refresh_after, price_status`;

export async function getTokens({ db, tokens }: { db: D1Database; tokens: TokenId[] }) {
  const result = await db
    .prepare(`SELECT ${tokenColumns} FROM tokens t
    LEFT JOIN assets a ON a.id = t.asset_id
    JOIN json_each(?) r ON t.chain_id = json_extract(r.value, '$.chainId')
      AND t.address = json_extract(r.value, '$.address')`)
    .bind(JSON.stringify(tokens))
    .all<TokenRow>();
  return result.results;
}

export async function searchTokens({
  db,
  query,
  chainId,
  limit,
}: {
  db: D1Database;
  query: string;
  chainId?: number;
  limit: number;
}) {
  let predicate: string;
  let match: string;
  if (/^0x[0-9a-f]{40}$/i.test(query)) {
    predicate = "t.address = ?";
    match = query.toLowerCase();
  } else if ([...query].length >= 3) {
    predicate = "t.id IN (SELECT rowid FROM token_search WHERE token_search MATCH ?)";
    match = `"${query.replaceAll('"', '""')}"`;
  } else {
    predicate = `t.id IN (SELECT id FROM tokens WHERE name LIKE ? ESCAPE '\\'
      UNION SELECT id FROM tokens WHERE symbol LIKE ? ESCAPE '\\')`;
    match = `${query.replace(/[\\%_]/g, "\\$&")}%`;
  }
  const args: (number | string)[] = [match];
  if ([...query].length < 3) args.push(match);
  if (chainId !== undefined) args.push(chainId);
  args.push(limit);
  const result = await db
    .prepare(`SELECT ${tokenColumns} FROM tokens t
    LEFT JOIN assets a ON a.id = t.asset_id WHERE ${predicate}
    ${chainId === undefined ? "" : "AND t.chain_id = ?"}
    ORDER BY a.market_cap_usd DESC NULLS LAST, t.chain_id ASC, t.address ASC LIMIT ?`)
    .bind(...args)
    .all<TokenRow>();
  return result.results;
}

export async function getChainSources({ db, chainIds }: { db: D1Database; chainIds: number[] }) {
  const rows = await db
    .prepare(
      `SELECT c.id, c.platform_id, c.gt_network FROM chains c
       WHERE c.id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(chainIds))
    .all<{ id: number; platform_id: string; gt_network: string | null }>();
  return new Map(
    rows.results.map((row) => [
      row.id,
      { chainId: row.id, platformId: row.platform_id, geckoTerminalNetwork: row.gt_network },
    ]),
  );
}

export async function getQuotes({ db, ids }: { db: D1Database; ids: string[] }) {
  if (!ids.length) return [];
  return (
    await db
      .prepare(`SELECT ${quoteColumns} FROM assets WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<QuoteRow>()
  ).results;
}

export async function writeQuotes({
  db,
  quotes,
  updateMarketCap,
}: {
  db: D1Database;
  quotes: QuoteRow[];
  updateMarketCap: boolean;
}) {
  if (!quotes.length) return;
  await db
    .prepare(`UPDATE assets SET
    price_usd = json_extract(q.value, '$.price_usd'),
    price_updated_at = json_extract(q.value, '$.price_updated_at'),
    fetched_at = json_extract(q.value, '$.fetched_at'),
    last_attempt_at = json_extract(q.value, '$.last_attempt_at'),
    refresh_after = json_extract(q.value, '$.refresh_after'),
    price_status = json_extract(q.value, '$.price_status')
    ${
      updateMarketCap
        ? `, market_cap_usd = CASE
          WHEN COALESCE(json_extract(q.value, '$.market_cap_updated_at'), 0) >= COALESCE(assets.market_cap_updated_at, 0)
          THEN json_extract(q.value, '$.market_cap_usd') ELSE assets.market_cap_usd END,
       market_cap_updated_at = CASE
          WHEN COALESCE(json_extract(q.value, '$.market_cap_updated_at'), 0) >= COALESCE(assets.market_cap_updated_at, 0)
          THEN json_extract(q.value, '$.market_cap_updated_at') ELSE assets.market_cap_updated_at END`
        : ""
    }
    FROM json_each(?) q WHERE assets.id = json_extract(q.value, '$.id')`)
    .bind(JSON.stringify(quotes))
    .run();
}

export async function stateValue({ db, key }: { db: D1Database; key: string }) {
  return (
    (
      await db
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .bind(key)
        .first<{ value: string }>()
    )?.value ?? null
  );
}

export async function setState({ db, key, value }: { db: D1Database; key: string; value: string }) {
  await db
    .prepare(
      "INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}
