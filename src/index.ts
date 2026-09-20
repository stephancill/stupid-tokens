import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { cached } from "./cache";
import { refreshMarketCaps, seedMarketCaps, syncCatalog } from "./catalog";
import { getQuotes, getTokens, searchTokens, setState, stateValue } from "./database";
import {
  priceResponse,
  REFRESH_MS,
  tokenKey,
  tokenResponse,
  type Env,
  type QuoteRow,
  type TokenId,
} from "./types";
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
          : error.status === 409
            ? "conflict"
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

// The static site lives in ./public and is served through the assets binding. API routes keep
// precedence because they are registered below; "/" serves the landing page.
app.get("/", (c) => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));

// Machine-readable index for API clients.
app.get("/v1", (c) =>
  c.json({
    name: "stupid tokens",
    version: "1",
    currency: "usd",
    docs: "https://tokens.stupidtech.net",
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
  const [syncedAt, error, report] = await Promise.all([
    stateValue({ db: c.env.DB, key: "catalog_synced_at" }),
    stateValue({ db: c.env.DB, key: "catalog_error" }),
    stateValue({ db: c.env.DB, key: "catalog_sync_report" }),
  ]);
  const summary = report ? catalogReportSchema.parse(JSON.parse(report)) : null;
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      ready: syncedAt !== null,
      catalogSyncedAt: syncedAt,
      catalogStatus: summary?.status ?? null,
      catalogPendingChains: summary?.pendingChains ?? null,
      catalogError: error ? "Catalog synchronization failed; see Worker logs" : null,
    },
    syncedAt ? 200 : 503,
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

// Shared price assembly. Bulk reads use one batched D1 query rather than a per-token cache
// fan-out, and only tokens whose cooldown has lapsed reach the refresh coordinator.
async function loadPrices({
  env,
  ctx,
  tokens,
}: {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  tokens: TokenId[];
}) {
  const unique = [...new Map(tokens.map((token) => [tokenKey(token), token])).values()].sort(
    (a, b) => tokenKey(a).localeCompare(tokenKey(b)),
  );
  const metadata = await cached({
    namespace: "price-identities",
    key: unique,
    ttl: 300,
    ctx,
    load: () => getTokens({ db: env.DB, tokens: unique }),
  });
  const byToken = new Map(
    metadata.map((row) => [tokenKey({ chainId: row.chain_id, address: row.address }), row]),
  );
  const ids = [...new Set(metadata.flatMap((row) => (row.asset_id ? [row.asset_id] : [])))];
  const now = Date.now();
  const quotes = new Map<string, QuoteRow>();
  const stored = await getQuotes({ db: env.DB, ids });
  const refresh: string[] = [];
  for (const quote of stored) {
    if (quote.refresh_after <= now || quote.price_status === "refreshing") refresh.push(quote.id);
    else quotes.set(quote.id, quote);
  }
  if (refresh.length) {
    const results = await env.PRICES.getByName("coingecko").getPrices({ ids: refresh });
    for (const quote of results) quotes.set(quote.id, quote);
  }
  const prices = tokens.map((token) => {
    const row = byToken.get(tokenKey(token));
    const quote = row?.asset_id ? quotes.get(row.asset_id) : undefined;
    const result = priceResponse({ token, quote, now });
    return row ? result : { ...result, status: "not_found" };
  });
  return { prices, ttlSeconds: responseTtl({ prices, now }) };
}

// How long the whole response may be cached. A batch is only cacheable while every token in it
// is still fresh, so the shortest remaining lifetime wins. Capped at the refresh interval.
function responseTtl({ prices, now }: { prices: ReturnType<typeof priceResponse>[]; now: number }) {
  const ttlFor = (price: (typeof prices)[number]) => {
    if (price.status === "not_found") return 300;
    const refreshAt = price.nextRefreshAt ? Date.parse(price.nextRefreshAt) : now;
    const sourceAt = price.priceUpdatedAt ? Date.parse(price.priceUpdatedAt) : null;
    const limit =
      price.status === "ok" && sourceAt !== null
        ? Math.min(refreshAt, sourceAt + REFRESH_MS)
        : refreshAt;
    return Math.floor((limit - now) / 1000);
  };
  return Math.max(0, Math.min(REFRESH_MS / 1000, ...prices.map(ttlFor)));
}

function parseTokenId({ value }: { value: string }): { chainId: number; address: string } {
  const separator = value.indexOf(":");
  if (separator === -1)
    throw new HTTPException(400, { message: `Expected chainId:address, received "${value}"` });
  return { chainId: Number(value.slice(0, separator)), address: value.slice(separator + 1) };
}

// Cacheable form: GET with a canonical, sorted, deduplicated token list. Non-canonical requests
// are redirected so ordering and casing cannot fragment the cache.
app.get("/v1/prices", async (c) => {
  const raw = c.req.query("tokens") ?? "";
  const parsed = raw
    .split(",")
    .filter(Boolean)
    .map((value) => parseTokenId({ value }));
  const { tokens } = validate({ schema: priceRequestSchema, value: { tokens: parsed } });
  const canonical = [...new Set(tokens.map(tokenKey))].sort().join(",");
  if (raw !== canonical) {
    c.header("Cache-Control", "public, max-age=86400");
    return c.redirect(`/v1/prices?tokens=${canonical}`, 308);
  }
  const { prices, ttlSeconds } = await loadPrices({
    env: c.env,
    ctx: c.executionCtx,
    tokens,
  });
  c.header("Cache-Control", ttlSeconds > 0 ? `public, max-age=${ttlSeconds}` : "no-store");
  return c.json({ currency: "usd", prices });
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
  // POST stays uncached: the body cannot form a cache key.
  c.header("Cache-Control", "no-store");
  return c.json({
    currency: "usd",
    prices: (await loadPrices({ env: c.env, ctx: c.executionCtx, tokens })).prices,
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
  return c.json(report, report.status === "failed" ? 503 : 200);
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
      // Market caps move slowly and are the most upstream-hungry step, so refresh once a day.
      const capsAt = Number(
        (await stateValue({ db: env.DB, key: "market_caps_refreshed_at" })) ?? 0,
      );
      if (Date.now() - capsAt > 20 * 60 * 60 * 1000) {
        const caps = await refreshMarketCaps({
          env,
          maxAgeMs: 7 * 24 * 60 * 60 * 1000,
          deadline: Date.now() + 10 * 60_000,
        });
        console.log("market_caps_refreshed", caps);
        await setState({
          db: env.DB,
          key: "market_caps_refreshed_at",
          value: String(Date.now()),
        });
      }
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
