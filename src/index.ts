import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { cacheKey, cached } from "./cache";
import { refreshMarketCaps, seedMarketCaps, syncCatalog } from "./catalog";
import { getQuotes, getTokens, searchTokens, setState, stateValue } from "./database";
import { priceResponse, tokenKey, tokenResponse, type Env, type QuoteRow } from "./types";
import { catalogReportSchema, priceRequestSchema, searchSchema, tokenIdSchema } from "./validation";

export { PriceCoordinator } from "./prices";

const app = new Hono<{ Bindings: Env }>();
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);
app.use(
  "*",
  bodyLimit({
    maxSize: 32_768,
    onError: (c) =>
      c.json(
        { error: { code: "body_too_large", message: "Request body must be at most 32 KiB" } },
        413,
      ),
  }),
);

function validate<T>({ schema, value }: { schema: z.ZodType<T>; value: unknown }): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPException(400, { message: z.prettifyError(result.error) });
  return result.data;
}

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const code =
      error.status >= 500
        ? "service_unavailable"
        : error.status === 401
          ? "unauthorized"
          : "invalid_request";
    return c.json({ error: { code, message: error.message } }, error.status);
  }
  console.error("request_failed", { path: c.req.path, message: error.message });
  return c.json(
    { error: { code: "service_unavailable", message: "The request could not be completed" } },
    503,
  );
});
app.notFound((c) => c.json({ error: { code: "not_found", message: "Endpoint not found" } }, 404));

app.get("/", (c) =>
  c.json({
    name: "Stupid Tokens",
    version: "1",
    currency: "usd",
    endpoints: [
      "GET /v1/chains",
      "GET /v1/search?q=usdc",
      "GET /v1/tokens/:chainId/:address",
      "POST /v1/prices",
    ],
    attribution: { name: "Data provided by CoinGecko", url: "https://www.coingecko.com/en/api" },
  }),
);

app.get("/health", async (c) => {
  const [syncedAt, error] = await Promise.all([
    stateValue({ db: c.env.DB, key: "catalog_synced_at" }),
    stateValue({ db: c.env.DB, key: "catalog_error" }),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      ready: syncedAt !== null,
      catalogSyncedAt: syncedAt,
      catalogError: error ? "Catalog synchronization failed; see Worker logs" : null,
    },
    syncedAt && !error ? 200 : 503,
  );
});

app.use("/v1/*", async (c, next) => {
  const syncedAt = await cached({
    namespace: "ready",
    key: "catalog",
    ttl: 30,
    ctx: c.executionCtx,
    load: async () => {
      const value = await stateValue({ db: c.env.DB, key: "catalog_synced_at" });
      if (!value)
        throw new HTTPException(503, { message: "Catalog has not been synchronized yet" });
      return value;
    },
  });
  c.header("X-Catalog-Synced-At", syncedAt);
  await next();
});

app.get("/v1/chains", async (c) => {
  const data = await cached({
    namespace: "chains-v2",
    key: "all",
    ttl: 300,
    ctx: c.executionCtx,
    load: async () => {
      const rows =
        await c.env.DB.prepare(`SELECT c.id, c.name, c.synced_at, COUNT(t.id) AS token_count
      FROM chains c JOIN tokens t ON t.chain_id = c.id WHERE c.synced_at IS NOT NULL GROUP BY c.id ORDER BY c.id`).all<{
          id: number;
          name: string;
          synced_at: number;
          token_count: number;
        }>();
      return rows.results.map((row) => ({
        chainId: row.id,
        name: row.name,
        tokenCount: row.token_count,
        syncedAt: new Date(row.synced_at).toISOString(),
      }));
    },
  });
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ chains: data });
});

app.get("/v1/search", async (c) => {
  const query = validate({ schema: searchSchema, value: c.req.query() });
  const normalized = { ...query, q: query.q.toLowerCase() };
  const data = await cached({
    namespace: "search",
    key: normalized,
    ttl: 60,
    ctx: c.executionCtx,
    load: async () => {
      const rows = await searchTokens({
        db: c.env.DB,
        query: normalized.q,
        chainId: query.chainId,
        limit: query.limit,
      });
      return rows.map((row) => tokenResponse({ row }));
    },
  });
  // Revalidation prevents downstream caches from restarting the edge's TTL.
  c.header("Cache-Control", "no-cache");
  return c.json({ tokens: data });
});

app.get("/v1/tokens/:chainId/:address", async (c) => {
  const token = validate({
    schema: tokenIdSchema,
    value: { chainId: Number(c.req.param("chainId")), address: c.req.param("address") },
  });
  const data = await cached({
    namespace: "token",
    key: token,
    ttl: 60,
    ctx: c.executionCtx,
    load: async () => {
      const [row] = await getTokens({ db: c.env.DB, tokens: [token] });
      return row ? tokenResponse({ row }) : null;
    },
  });
  c.header("Cache-Control", "no-cache");
  if (!data)
    return c.json({ error: { code: "not_found", message: "Token is not in the catalog" } }, 404);
  return c.json(data);
});

app.post("/v1/prices", async (c) => {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
    throw new HTTPException(415, { message: "Content-Type must be application/json" });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON" });
  }
  const { tokens } = validate({ schema: priceRequestSchema, value: body });
  const unique = [...new Map(tokens.map((token) => [tokenKey(token), token])).values()].sort(
    (a, b) => tokenKey(a).localeCompare(tokenKey(b)),
  );
  const metadata = await cached({
    namespace: "price-identities",
    key: unique,
    ttl: 300,
    ctx: c.executionCtx,
    load: () => getTokens({ db: c.env.DB, tokens: unique }),
  });
  const byToken = new Map(
    metadata.map((row) => [tokenKey({ chainId: row.chain_id, address: row.address }), row]),
  );
  const ids = [...new Set(metadata.flatMap((row) => (row.asset_id ? [row.asset_id] : [])))];
  const quotes = new Map<string, QuoteRow>();
  const keys = new Map<string, Request>();
  const misses: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const key = await cacheKey({ namespace: "quote", value: id });
      keys.set(id, key);
      const hit = await caches.default.match(key);
      const row = hit ? await hit.json<QuoteRow>() : null;
      if (row && row.refresh_after > Date.now() && row.price_status !== "refreshing")
        quotes.set(id, row);
      else misses.push(id);
    }),
  );
  const stored = await getQuotes({ db: c.env.DB, ids: misses });
  const refresh: string[] = [];
  for (const quote of stored) {
    if (quote.refresh_after <= Date.now() || quote.price_status === "refreshing")
      refresh.push(quote.id);
    else quotes.set(quote.id, quote);
  }
  if (refresh.length) {
    const results = await c.env.PRICES.getByName("coingecko").getPrices({ ids: refresh });
    for (const quote of results) quotes.set(quote.id, quote);
  }
  for (const id of misses) {
    const quote = quotes.get(id);
    const key = keys.get(id);
    if (!quote || !key || quote.price_status === "refreshing") continue;
    const ttl = Math.min(300, Math.floor((quote.refresh_after - Date.now()) / 1000));
    if (ttl > 0)
      c.executionCtx.waitUntil(
        caches.default.put(
          key,
          Response.json(quote, { headers: { "cache-control": `public, max-age=${ttl}` } }),
        ),
      );
  }
  const now = Date.now();
  c.header("Cache-Control", "no-store");
  return c.json({
    currency: "usd",
    prices: tokens.map((token) => {
      const metadata = byToken.get(tokenKey(token));
      const quote = metadata?.asset_id ? quotes.get(metadata.asset_id) : undefined;
      const result = priceResponse({ token, quote, now });
      return metadata ? result : { ...result, status: "not_found" };
    }),
  });
});

app.use("/admin/*", async (c, next) => {
  if (!c.env.ADMIN_TOKEN)
    throw new HTTPException(503, { message: "Admin token is not configured" });
  const provided = new TextEncoder().encode(c.req.header("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${c.env.ADMIN_TOKEN}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new HTTPException(401, { message: "Unauthorized" });
  c.header("Cache-Control", "no-store");
  await next();
});
app.post("/admin/sync", async (c) => {
  const report = await syncCatalog({ env: c.env });
  return c.json(report, report.status === "complete" ? 200 : 503);
});
app.post("/admin/seed-market-caps", async (c) => c.json(await seedMarketCaps({ env: c.env })));
app.get("/admin/status", async (c) => {
  const state = (
    await c.env.DB.prepare(
      "SELECT key, value FROM app_state WHERE key IN ('catalog_synced_at', 'market_caps_seeded_at', 'catalog_error', 'catalog_sync_report')",
    ).all<{ key: string; value: string }>()
  ).results;
  return c.json({
    state: state.map(({ key, value }) => ({
      key,
      value:
        key === "catalog_sync_report"
          ? JSON.stringify(catalogReportSchema.parse(JSON.parse(value)))
          : key === "catalog_error" && value
            ? "Catalog synchronization failed; see Worker logs"
            : value,
    })),
    counts: await c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM tokens) AS tokens, (SELECT COUNT(*) FROM assets) AS assets",
    ).first(),
  });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env) {
    try {
      const report = await syncCatalog({ env });
      console.log("catalog_synced", report);
      const caps = await refreshMarketCaps({
        env,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        deadline: Date.now() + 10 * 60_000,
      });
      console.log("market_caps_refreshed", caps);
      if (report.status !== "complete")
        throw new Error(
          `Catalog sync ${report.status}: ${report.failures.length} chain imports failed`,
        );
    } catch (error) {
      await setState({
        db: env.DB,
        key: "catalog_error",
        value: error instanceof Error ? error.message : "Unknown import error",
      });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
