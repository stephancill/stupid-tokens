import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  abortAllDurableObjects,
  reset,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importChain, refreshMarketCaps, seedMarketCaps, syncCatalog } from "../src/catalog";
import { getTokens, searchTokens, setState, stateValue } from "../src/database";
import { REFRESH_MS, type Env as AppEnv } from "../src/types";
import worker from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

async function request({ path, init }: { path: string; init?: RequestInit }) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://example.com${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const address = ({ n }: { n: number }) => `0x${n.toString(16).padStart(40, "0")}`;

async function seed() {
  const asset = ({ chainId, address: addr }: { chainId: number; address: string }) =>
    `${chainId}:${addr}`;
  const tokens = [
    {
      chainId: 1,
      address: address({ n: 1 }),
      assetId: asset({ chainId: 1, address: address({ n: 1 }) }),
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      imageUrl: null,
    },
    {
      chainId: 1,
      address: address({ n: 2 }),
      assetId: asset({ chainId: 1, address: address({ n: 2 }) }),
      name: "Large USDC Token",
      symbol: "LUSDC",
      decimals: 18,
      imageUrl: "https://example.com/token.png",
    },
    {
      chainId: 1,
      address: address({ n: 3 }),
      assetId: asset({ chainId: 1, address: address({ n: 3 }) }),
      name: "Unknown USDC",
      symbol: "USDCX",
      decimals: 18,
      imageUrl: null,
    },
    {
      chainId: 1,
      address: "native",
      assetId: asset({ chainId: 1, address: "native" }),
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
      imageUrl: null,
    },
  ];
  await importChain({
    db: env.DB,
    chain: { id: 1, name: "Ethereum", platform: "ethereum" },
    gtNetwork: "eth",
    tokens,
    now: Date.now(),
  });
  const base = { ...tokens[0]!, chainId: 8453, address: address({ n: 4 }) };
  await importChain({
    db: env.DB,
    chain: { id: 8453, name: "Base", platform: "base" },
    gtNetwork: "base",
    tokens: [{ ...base, assetId: asset({ chainId: 8453, address: base.address }) }],
    now: Date.now(),
  });
  await env.DB.prepare(
    "UPDATE assets SET market_cap_usd = CASE WHEN id = ? THEN 100 WHEN id = ? THEN 1000 ELSE NULL END",
  )
    .bind(
      asset({ chainId: 1, address: address({ n: 1 }) }),
      asset({ chainId: 1, address: address({ n: 2 }) }),
    )
    .run();
  await setState({ db: env.DB, key: "catalog_synced_at", value: new Date().toISOString() });
  return tokens;
}

async function prices({ tokens }: { tokens: { chainId: number; address: string }[] }) {
  // The GET form is canonical: sorted and deduplicated. Mirrors the Worker's `tokenKey` ordering.
  const canonical = [...new Set(tokens.map((token) => `${token.chainId}:${token.address}`))]
    .sort()
    .join(",");
  return request({ path: `/v1/prices?tokens=${canonical}` });
}

async function pricesGet({ tokens }: { tokens: string }) {
  return request({ path: `/v1/prices?tokens=${tokens}` });
}

// Percent changes returned by the DefiLlama percentage endpoint, keyed by window. The source
// already reports percentages.
type MockChange = { h1: number | null; h24: number | null; d7: number | null };

// Prices now come from address-keyed providers. DefiLlama supplies the price and percent price
// changes; GeckoTerminal supplies market caps; DexScreener is the fallback.
function mockPrices({
  delay = 0,
  status = 200,
  age = 0,
  price = 0.00000012,
  marketCap = 1234567,
  geckoPrice = undefined as string | null | undefined,
  changes = { h1: 1, h24: 2, d7: 3 } as MockChange | null,
  changeStatus = 200,
}: {
  delay?: number;
  status?: number;
  age?: number;
  price?: number;
  marketCap?: number;
  geckoPrice?: string | null;
  changes?: MockChange | null;
  changeStatus?: number;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (url.hostname === "coins.llama.fi") {
      if (status !== 200)
        return new Response("Upstream error", { status, headers: { "Retry-After": "120" } });
      if (url.pathname.startsWith("/percentage/")) {
        if (changeStatus !== 200) return new Response("Upstream error", { status: changeStatus });
        const ids = decodeURIComponent(url.pathname.split("/percentage/")[1] ?? "").split(",");
        const period = url.searchParams.get("period");
        const field = period === "1h" ? "h1" : period === "24h" ? "h24" : "d7";
        const percent = changes?.[field] ?? null;
        return Response.json({
          coins: Object.fromEntries(
            percent === null
              ? []
              : ids.filter(Boolean).map((id) => [id, percent] as [string, number]),
          ),
        });
      }
      const ids = decodeURIComponent(url.pathname.split("/prices/current/")[1] ?? "").split(",");
      const timestamp = Math.floor((Date.now() - age) / 1000);
      return Response.json({
        coins: Object.fromEntries(
          ids
            .filter(Boolean)
            .map((id) => [id, { price, timestamp, confidence: 0.99, decimals: 18, symbol: "TKN" }]),
        ),
      });
    }
    if (url.hostname === "api.geckoterminal.com") {
      if (status !== 200) return new Response("Upstream error", { status });
      const addresses = decodeURIComponent(url.pathname.split("/tokens/multi/")[1] ?? "").split(
        ",",
      );
      return Response.json({
        data: addresses.filter(Boolean).map((address) => ({
          attributes: {
            address,
            price_usd: geckoPrice === undefined ? String(price) : geckoPrice,
            market_cap_usd: String(marketCap),
            image_url: "https://example.com/token.png",
            total_reserve_in_usd: "1000000",
          },
        })),
      });
    }
    if (url.hostname === "api.dexscreener.com") {
      if (status !== 200) return new Response("Upstream error", { status });
      return Response.json([]);
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  });
}

// Providers make several calls per refresh. DefiLlama serves prices and percent changes from
// the same host, so assertions distinguish the price endpoint from the percentage calls.
function llamaRequests(upstream: { mock: { calls: unknown[][] } }, pathPart: string) {
  return upstream.mock.calls.filter(([input]) => {
    const url = new URL(String(input));
    return url.hostname === "coins.llama.fi" && url.pathname.startsWith(pathPart);
  }).length;
}
function llamaCalls(upstream: { mock: { calls: unknown[][] } }) {
  return llamaRequests(upstream, "/prices/current/");
}
function llamaChangeCalls(upstream: { mock: { calls: unknown[][] } }) {
  return llamaRequests(upstream, "/percentage/");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalog and search", () => {
  it("orders every matching name/symbol by market cap before limiting, with null caps last", async () => {
    await seed();
    const response = await request({ path: "/v1/search?q=USDC&limit=2" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const data = await response.json<{
      tokens: { symbol: string; marketCapUsd: string | null; chainId: number }[];
    }>();
    expect(data.tokens.map((token) => token.symbol)).toEqual(["LUSDC", "USDC"]);
    expect(data.tokens.map((token) => token.marketCapUsd)).toEqual(["1000", "100"]);
    const all = await searchTokens({ db: env.DB, query: "usdc", limit: 100 });
    // Market caps are per deployment now, so the Base token has no cap and sorts last.
    expect(all.map((token) => token.chain_id)).toEqual([1, 1, 1, 8453]);
    expect(all.at(-1)?.market_cap_usd).toBeNull();
    const filtered = await searchTokens({ db: env.DB, query: "us", chainId: 8453, limit: 20 });
    expect(filtered).toHaveLength(1);
  });

  it("supports substring names, exact addresses, literal FTS input, and short prefixes", async () => {
    await seed();
    expect(await searchTokens({ db: env.DB, query: "oin", limit: 20 })).toHaveLength(2);
    expect(await searchTokens({ db: env.DB, query: address({ n: 2 }), limit: 20 })).toHaveLength(1);
    expect(await searchTokens({ db: env.DB, query: '" OR *', limit: 20 })).toEqual([]);
    expect(await searchTokens({ db: env.DB, query: "et", limit: 20 })).toHaveLength(1);
  });

  it("updates the search index on rename, prunes removed tokens, and avoids rewriting unchanged metadata", async () => {
    const tokens = await seed();
    const chain = { id: 1, name: "Ethereum", platform: "ethereum" };
    const [before] = await getTokens({ db: env.DB, tokens: [tokens[0]!] });
    await importChain({ db: env.DB, chain, tokens, now: Date.now() + 1000 });
    const [unchanged] = await getTokens({ db: env.DB, tokens: [tokens[0]!] });
    expect(unchanged?.metadata_updated_at).toBe(before?.metadata_updated_at);
    await importChain({
      db: env.DB,
      chain,
      tokens: [{ ...tokens[0]!, name: "Renamed Token", symbol: "NEW" }],
      now: Date.now() + 2000,
    });
    expect(await searchTokens({ db: env.DB, query: "renamed", limit: 20 })).toHaveLength(1);
    expect(await searchTokens({ db: env.DB, query: "usdc", chainId: 1, limit: 20 })).toEqual([]);
    expect(await getTokens({ db: env.DB, tokens: [tokens[1]!] })).toEqual([]);
  });

  it("requires a synchronized catalog and protects operator endpoints", async () => {
    const health = await request({ path: "/health" });
    expect(health.status).toBe(503);
    const search = await request({ path: "/v1/search?q=usdc" });
    expect(search.status).toBe(503);
    expect(await search.json()).toMatchObject({ error: { code: "service_unavailable" } });
    const sync = await request({ path: "/admin/sync", init: { method: "POST" } });
    expect(sync.status).toBe(401);
  });
});

describe("bulk prices and global refresh coordination", () => {
  it("shares a batch across concurrent requests and mapped chain deployments", async () => {
    await seed();
    const upstream = mockPrices({ delay: 100 });
    const tokens = [
      { chainId: 1, address: address({ n: 1 }) },
      { chainId: 8453, address: address({ n: 4 }) },
    ];
    // Duplicate inputs collapse into the canonical, sorted request.
    const first = prices({ tokens: [...tokens, tokens[0]!] });
    const second = prices({ tokens: [{ chainId: 1, address: address({ n: 2 }) }] });
    // Arrive after D1's refresh reservation exists, while the upstream is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const third = prices({ tokens });
    const responses = await Promise.all([first, second, third]);
    for (const response of responses) expect(response.status).toBe(200);
    const data = await responses[0]!.json<{
      prices: { status: string; chainId: number; priceUsd: string }[];
    }>();
    expect(data.prices.map((price) => price.chainId)).toEqual([1, 8453]);
    expect(data.prices.every((price) => price.status === "ok")).toBe(true);
    expect(data.prices[0]?.priceUsd).toBe("0.00000012");
    const joined = await responses[2]!.json<{ prices: { status: string }[] }>();
    expect(joined.prices.every((price) => price.status === "ok")).toBe(true);
    // One shared refresh: one DefiLlama price call and three percentage calls (1h/24h/7d), plus
    // one GeckoTerminal cap call per chain.
    const llamaPriceCalls = upstream.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return url.hostname === "coins.llama.fi" && url.pathname.startsWith("/prices/current/");
    });
    expect(llamaPriceCalls).toHaveLength(1);
    const url = new URL(String(llamaPriceCalls[0]![0]));
    expect(
      decodeURIComponent(url.pathname.split("/prices/current/")[1]!).split(",").sort(),
    ).toEqual([
      "base:0x0000000000000000000000000000000000000004",
      "ethereum:0x0000000000000000000000000000000000000001",
      "ethereum:0x0000000000000000000000000000000000000002",
    ]);
    // Keyless: no provider key header is sent, but a descriptive User-Agent is.
    const headers = llamaPriceCalls[0]![1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("x-cg-demo-api-key");
    expect(headers["user-agent"]).toContain("stupid-tokens");
    // Each change window is fetched once and shared across the concurrent callers.
    expect(llamaChangeCalls(upstream)).toBe(3);
    const cached = await prices({ tokens });
    expect(cached.status).toBe(200);
    expect(llamaCalls(upstream)).toBe(1);
    expect(llamaChangeCalls(upstream)).toBe(3);
    expect(
      (
        await env.DB.prepare("SELECT market_cap_usd FROM assets WHERE id = ?")
          .bind("1:0x0000000000000000000000000000000000000001")
          .first<{ market_cap_usd: number }>()
      )?.market_cap_usd,
    ).toBe(1234567);
  });

  it("persists cooldowns across eviction and allows a new refresh only after expiry", async () => {
    await seed();
    const upstream = mockPrices();
    let stub = env.PRICES.getByName("coingecko");
    await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    await abortAllDurableObjects();
    stub = env.PRICES.getByName("coingecko");
    await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(llamaCalls(upstream)).toBe(1);
    await env.DB.prepare("UPDATE assets SET refresh_after = ? WHERE id = ?")
      .bind(Date.now() - 1, "1:0x0000000000000000000000000000000000000001")
      .run();
    // Even an outdated D1 record cannot bypass the durable reservation.
    await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(llamaCalls(upstream)).toBe(1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE reservations SET until_ms = ? WHERE id = ?",
        Date.now() - 1,
        "1:0x0000000000000000000000000000000000000001",
      );
    });
    await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(llamaCalls(upstream)).toBe(2);
  });

  it("does not retry failed refreshes within five minutes and returns explicit per-item failures", async () => {
    await seed();
    const upstream = mockPrices({ status: 500 });
    let stub = env.PRICES.getByName("coingecko");
    const [first] = await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(first?.price_status).toBe("upstream_error");
    expect(first!.refresh_after - first!.last_attempt_at!).toBe(REFRESH_MS);
    // Transient upstream errors are retried briefly before the cooldown is finalized.
    expect(llamaCalls(upstream)).toBe(2);
    await abortAllDurableObjects();
    stub = env.PRICES.getByName("coingecko");
    await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(llamaCalls(upstream)).toBe(2);
  });

  it("enforces provider-wide monthly budgets without another upstream call", async () => {
    await seed();
    const upstream = mockPrices();
    const stub = env.PRICES.getByName("coingecko");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO budgets(name, window, used) VALUES (?, ?, ?)",
        "month",
        new Date().toISOString().slice(0, 7),
        Number(env.PRICE_REQUESTS_PER_MONTH),
      );
    });
    const [quote] = await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] });
    expect(quote?.price_status).toBe("rate_limited");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("retries throttled upstreams, then backs off across different assets", async () => {
    await seed();
    let calls = 0;
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      throw Object.assign(new Error("CoinGecko returned HTTP 429"), {
        upstreamStatus: 429,
        retryAt: Date.now() + 120_000,
      });
    });
    const stub = env.PRICES.getByName("coingecko");
    expect(
      (await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000001"] }))[0]
        ?.price_status,
    ).toBe("rate_limited");
    // The primary source retries once before the refresh is considered failed.
    expect(llamaCalls(upstream)).toBe(2);
    // Every source is still attempted so one throttled provider cannot discard the others.
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(2);
    expect(
      (await stub.getPrices({ ids: ["1:0x0000000000000000000000000000000000000002"] }))[0]
        ?.price_status,
    ).toBe("rate_limited");
    // The global backoff prevents any further upstream calls for other assets.
    expect(calls).toBe(afterFirst);
  });

  it("distinguishes stale source timestamps and unknown tokens without making unknown-token calls", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE assets SET market_cap_usd = 999, market_cap_updated_at = ? WHERE id = ?",
    )
      .bind(Date.now(), "1:0x0000000000000000000000000000000000000001")
      .run();
    // With every source stale, the price is withheld rather than served beyond the limit.
    const upstream = mockPrices({ age: REFRESH_MS + 10_000, geckoPrice: null });
    const response = await prices({
      tokens: [
        { chainId: 1, address: address({ n: 1 }) },
        { chainId: 1, address: address({ n: 999 }) },
      ],
    });
    const data = await response.json<{
      prices: {
        status: string;
        priceUsd: string | null;
        marketCapUsd: string | null;
        priceChange: { h1: string | null; h24: string | null; d7: string | null };
      }[];
    }>();
    expect(data.prices.map((price) => price.status)).toEqual(["stale", "not_found"]);
    expect(data.prices.every((price) => price.priceUsd === null)).toBe(true);
    // Changes ride with the price, so a stale or unknown token reports none.
    expect(data.prices.every((price) => price.priceChange.d7 === null)).toBe(true);
    // A stale source price yields no price, but the per-deployment cap still refreshes.
    expect(data.prices[0]?.marketCapUsd).toBe("1234567");
    expect(
      await env.DB.prepare("SELECT market_cap_usd FROM assets WHERE id = ?")
        .bind("1:0x0000000000000000000000000000000000000001")
        .first("market_cap_usd"),
    ).toBe(1234567);
    expect(llamaCalls(upstream)).toBe(1);
  });

  it("prefers a fresher lower-priority source over a stale primary price", async () => {
    await seed();
    const upstream = mockPrices({ age: REFRESH_MS + 10_000, geckoPrice: "0.5" });
    const response = await prices({ tokens: [{ chainId: 1, address: address({ n: 1 }) }] });
    const data = await response.json<{ prices: { status: string; priceUsd: string | null }[] }>();
    // DefiLlama's timestamp is beyond the freshness limit, so the fresh DEX price is used.
    expect(data.prices[0]?.status).toBe("ok");
    expect(data.prices[0]?.priceUsd).toBe("0.5");
    expect(llamaCalls(upstream)).toBe(1);
  });

  it("serves and stores 1h/24h/7d percent changes from the primary source", async () => {
    await seed();
    const upstream = mockPrices({ changes: { h1: 1, h24: 2.5, d7: -3 } });
    const response = await prices({ tokens: [{ chainId: 1, address: address({ n: 1 }) }] });
    const data = await response.json<{
      prices: {
        status: string;
        priceChange: { h1: string | null; h24: string | null; d7: string | null };
      }[];
    }>();
    expect(data.prices[0]?.status).toBe("ok");
    // The source reports percentages directly.
    expect(data.prices[0]?.priceChange).toEqual({ h1: "1", h24: "2.5", d7: "-3" });
    // One request per window, regardless of how many tokens are in the batch.
    expect(llamaChangeCalls(upstream)).toBe(3);
    const stored = await env.DB.prepare(
      "SELECT change_1h, change_24h, change_7d, changes_updated_at FROM assets WHERE id = ?",
    )
      .bind("1:0x0000000000000000000000000000000000000001")
      .first<{
        change_1h: number;
        change_24h: number;
        change_7d: number;
        changes_updated_at: number | null;
      }>();
    expect(stored?.change_1h).toBe(1);
    expect(stored?.change_24h).toBe(2.5);
    expect(stored?.change_7d).toBe(-3);
    expect(stored?.changes_updated_at).not.toBeNull();
  });

  it("keeps the price and previously stored changes when the percentage endpoint fails", async () => {
    const id = "1:0x0000000000000000000000000000000000000001";
    await seed();
    // Prime a stored change set, then let the secondary source fail on the next refresh.
    await env.DB.prepare(
      "UPDATE assets SET change_1h = 1, change_24h = 2, change_7d = 3, changes_updated_at = ? WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    const upstream = mockPrices({ changeStatus: 500 });
    const response = await prices({ tokens: [{ chainId: 1, address: address({ n: 1 }) }] });
    const data = await response.json<{
      prices: { status: string; priceUsd: string | null; priceChange: { d7: string | null } }[];
    }>();
    // A price source that fails only on changes must not discard its price.
    expect(data.prices[0]?.status).toBe("ok");
    expect(data.prices[0]?.priceUsd).toBe("0.00000012");
    // Failed attempts do not clear previously stored changes.
    expect(data.prices[0]?.priceChange.d7).toBe("3");
    // The secondary source is retried once per window before the refresh gives up on it.
    expect(llamaChangeCalls(upstream)).toBe(6);
    expect(llamaCalls(upstream)).toBe(1);
  });

  it("serves a cacheable canonical GET and redirects non-canonical token lists", async () => {
    await seed();
    const upstream = mockPrices();
    const a = `1:${address({ n: 1 })}`;
    const b = `1:${address({ n: 2 })}`;

    // Unsorted, duplicated input redirects to the canonical form so the cache cannot fragment.
    const redirect = await pricesGet({ tokens: `${b},${a},${b}` });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`/v1/prices?tokens=${a},${b}`);
    expect(redirect.headers.get("cache-control")).toContain("max-age=86400");

    const response = await pricesGet({ tokens: `${a},${b}` });
    expect(response.status).toBe(200);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("public");
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
    // Bounded by the five-minute refresh interval.
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(300);

    const data = await response.json<{ prices: { address: string; status: string }[] }>();
    expect(data.prices.map((price) => price.address)).toEqual([
      address({ n: 1 }),
      address({ n: 2 }),
    ]);
    expect(data.prices.every((price) => price.status === "ok")).toBe(true);
    // One shared refresh for the whole batch.
    expect(llamaCalls(upstream)).toBe(1);
  });

  it("bounds max-age by the source freshness window, not just the refresh interval", async () => {
    await seed();
    // A price whose source timestamp is already 200s old may only be cached for the 100s
    // remaining, so a cached response can never outlive the five-minute freshness limit.
    mockPrices({ age: 200_000, geckoPrice: null });
    const response = await pricesGet({ tokens: `1:${address({ n: 1 })}` });
    expect(response.status).toBe(200);
    const data = await response.json<{ prices: { status: string }[] }>();
    expect(data.prices[0]?.status).toBe("ok");
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(80);
    expect(maxAge).toBeLessThan(120);
  });

  it("caches a stale answer only until a refresh becomes possible", async () => {
    await seed();
    mockPrices({ age: REFRESH_MS + 10_000, geckoPrice: null });
    const response = await pricesGet({ tokens: `1:${address({ n: 1 })}` });
    const data = await response.json<{ prices: { status: string }[] }>();
    expect(data.prices[0]?.status).toBe("stale");
    // Nothing better can be produced before the cooldown lapses, so caching until then is safe.
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(300);
  });

  it("validates bulk size and addresses", async () => {
    await seed();
    const upstream = mockPrices();
    expect((await prices({ tokens: [] })).status).toBe(400);
    expect((await prices({ tokens: [{ chainId: 1, address: "ETH" }] })).status).toBe(400);
    expect(
      (
        await prices({
          tokens: Array.from({ length: 51 }, (_, index) => ({
            chainId: 1,
            address: address({ n: index }),
          })),
        })
      ).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("upstream ingestion", () => {
  it("imports across chunk boundaries and serves a maximum-size bulk request", async () => {
    const tokens = Array.from({ length: 450 }, (_, index) => ({
      chainId: 1,
      address: address({ n: index + 1000 }),
      assetId: `1:${address({ n: index + 1000 })}`,
      name: `Boundary Token ${index}`,
      symbol: `B${index}`,
      decimals: 18,
      imageUrl: null,
    }));
    const chain = { id: 1, name: "Ethereum", platform: "ethereum" };
    await importChain({ db: env.DB, chain, tokens, now: Date.now() });
    await setState({ db: env.DB, key: "catalog_synced_at", value: new Date().toISOString() });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tokens").first("count")).toBe(450);
    const upstream = mockPrices();
    const response = await prices({
      tokens: tokens.slice(-50).map(({ chainId, address }) => ({ chainId, address })),
    });
    const data = await response.json<{ prices: { status: string; address: string }[] }>();
    expect(data.prices).toHaveLength(50);
    expect(data.prices.every((price) => price.status === "ok")).toBe(true);
    expect(data.prices.at(-1)?.address).toBe(tokens.at(-1)?.address);
    expect(llamaCalls(upstream)).toBeGreaterThan(0);
    await expect(
      importChain({ db: env.DB, chain, tokens: [tokens[0]!, tokens[0]!], now: Date.now() }),
    ).rejects.toThrow("Duplicate");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tokens").first("count")).toBe(450);
  });

  it("imports chain lists and native currencies, then seeds caps without overwriting fresh on-demand data", async () => {
    const chains = [
      { id: 1, name: "Ethereum", platform: "ethereum" },
      { id: 146, name: "Sonic", platform: "sonic" },
    ];
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "chainid.network")
        return Response.json(
          chains.map((chain) => ({
            chainId: chain.id,
            nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 8 },
          })),
        );
      if (url.hostname === "api.geckoterminal.com" && url.pathname.endsWith("/networks"))
        return Response.json({
          data: chains.map((chain) => ({
            id: `gt-${chain.platform}`,
            attributes: { coingecko_asset_platform_id: chain.platform },
          })),
        });
      if (url.pathname.endsWith("/asset_platforms"))
        return Response.json(
          chains.map((chain) => ({
            id: chain.platform,
            name: chain.name,
            chain_identifier: chain.id,
            native_coin_id: "test-native",
          })),
        );
      if (url.hostname === "tokens.coingecko.com") {
        const chain = chains.find((chain) => url.pathname === `/${chain.platform}/all.json`)!;
        return Response.json({
          name: "CoinGecko",
          timestamp: new Date().toISOString(),
          version: { major: 1, minor: 0, patch: 0 },
          tokens: [
            {
              chainId: chain.id,
              address: address({ n: 7 }),
              name: "Test",
              symbol: chain.id === 1 ? "" : "TEST",
              decimals: 18,
            },
          ],
        });
      }
      if (url.hostname === "api.geckoterminal.com")
        return Response.json({
          data: [
            {
              attributes: {
                address: address({ n: 7 }),
                price_usd: "1.5",
                market_cap_usd: "42",
                image_url: "https://example.com/test.png",
                total_reserve_in_usd: "1000000",
              },
            },
          ],
        });
      if (url.hostname === "api.dexscreener.com") return Response.json([]);
      throw new Error(`Unexpected upstream request: ${url}`);
    });
    const imported = await syncCatalog({ env });
    expect(imported.status).toBe("complete");
    expect(imported.tokens).toBe(chains.length * 2);
    expect(
      (await getTokens({ db: env.DB, tokens: [{ chainId: 146, address: "native" }] }))[0]?.decimals,
    ).toBe(8);
    await env.DB.prepare(
      "UPDATE assets SET market_cap_usd = 999, market_cap_updated_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 40 * 24 * 60 * 60 * 1000, `1:${address({ n: 7 })}`)
      .run();
    await seedMarketCaps({ env });
    const [token] = await getTokens({
      db: env.DB,
      tokens: [{ chainId: 1, address: address({ n: 7 }) }],
    });
    // The provider cap is newer than the stored value, so it wins.
    expect(token?.market_cap_usd).toBe(42);
    expect(token?.symbol).toBe("");
    expect(token?.image_url).toBe("https://example.com/test.png");
    // A complete backfill is recorded, and repeat runs are idempotent.
    expect(await stateValue({ db: env.DB, key: "market_caps_seeded_at" })).not.toBeNull();
    const calls = upstream.mock.calls.length;
    expect(await seedMarketCaps({ env })).toMatchObject({ complete: true, remaining: 0 });
    expect(upstream.mock.calls.length).toBe(calls);
    // Staleness refreshes only touch caps older than the cutoff.
    expect(
      await refreshMarketCaps({ env, maxAgeMs: 60_000, deadline: Date.now() + 5_000 }),
    ).toEqual({ updated: 0, remaining: 0 });
    expect(upstream.mock.calls.length).toBe(calls);
  });

  it("does not let an unresolvable market cap block the rest of the backfill", async () => {
    // Two assets: one whose cap no source can resolve, and one that can be capped.
    const unresolved = `1:${address({ n: 41 })}`;
    const resolvable = `1:${address({ n: 42 })}`;
    await importChain({
      db: env.DB,
      chain: { id: 1, name: "Ethereum", platform: "ethereum" },
      now: Date.now(),
      tokens: [
        {
          chainId: 1,
          address: address({ n: 41 }),
          assetId: unresolved,
          name: "No Cap",
          symbol: "NC",
          decimals: 18,
          imageUrl: null,
        },
        {
          chainId: 1,
          address: address({ n: 42 }),
          assetId: resolvable,
          name: "Has Cap",
          symbol: "HC",
          decimals: 18,
          imageUrl: null,
        },
      ],
    });
    await setState({ db: env.DB, key: "catalog_synced_at", value: new Date().toISOString() });
    // Only the second asset resolves; the first is omitted from every source response.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.geckoterminal.com")
        return Response.json({
          data: [
            {
              attributes: {
                address: address({ n: 42 }),
                price_usd: "1",
                market_cap_usd: "500",
                image_url: null,
                total_reserve_in_usd: "1000000",
              },
            },
          ],
        });
      if (url.hostname === "api.dexscreener.com") return Response.json([]);
      throw new Error(`Unexpected request: ${url}`);
    });

    const first = await refreshMarketCaps({ env, maxAgeMs: 60_000, deadline: Date.now() + 5_000 });
    expect(first.updated).toBe(1);
    const capped = async (id: string) =>
      await env.DB.prepare("SELECT market_cap_usd, market_cap_checked_at FROM assets WHERE id = ?")
        .bind(id)
        .first<{ market_cap_usd: number | null; market_cap_checked_at: number | null }>();
    expect((await capped(resolvable))?.market_cap_usd).toBe(500);
    // The unresolved asset records the attempt, so it is not re-selected immediately.
    expect((await capped(unresolved))?.market_cap_checked_at).not.toBeNull();

    const second = await refreshMarketCaps({ env, maxAgeMs: 60_000, deadline: Date.now() + 5_000 });
    expect(second.updated).toBe(0);
    // Once the checked gate lapses it becomes due again.
    const third = await refreshMarketCaps({
      env,
      maxAgeMs: 60_000,
      checkedMs: 0,
      deadline: Date.now() + 5_000,
    });
    expect(third.updated).toBe(1);
  });

  it("gates a throttled GeckoTerminal off for the rest of a backfill run and keeps fallback caps", async () => {
    // 61 assets span two 60-asset refresh batches, so a second batch exists to be skipped.
    const tokens = Array.from({ length: 61 }, (_, index) => ({
      chainId: 1,
      address: address({ n: index + 100 }),
      assetId: `1:${address({ n: index + 100 })}`,
      name: `Token ${index}`,
      symbol: `TKN${index}`,
      decimals: 18,
      imageUrl: null,
    }));
    await importChain({
      db: env.DB,
      chain: { id: 1, name: "Ethereum", platform: "ethereum" },
      gtNetwork: "eth",
      tokens,
      now: Date.now(),
    });
    await setState({ db: env.DB, key: "catalog_synced_at", value: new Date().toISOString() });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "api.geckoterminal.com")
        return new Response("rate limited", { status: 429 });
      if (url.hostname === "api.dexscreener.com") {
        const addresses = decodeURIComponent(url.pathname.split("/tokens/v1/ethereum/")[1] ?? "")
          .split(",")
          .filter(Boolean);
        return Response.json(
          addresses.map((address) => ({
            chainId: "ethereum",
            priceUsd: "1",
            marketCap: 500,
            fdv: null,
            baseToken: { address },
            liquidity: { usd: 1_000_000 },
          })),
        );
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });
    expect(await seedMarketCaps({ env })).toMatchObject({ complete: true, remaining: 0 });
    // GeckoTerminal is attempted only once, in the first batch: the first 30-address chunk is
    // retried once by fetchJson (two requests) before the loader aborts and the source is gated
    // off. The second batch skips it entirely.
    const geckoCalls = upstream.mock.calls.filter(
      ([input]) => new URL(String(input)).hostname === "api.geckoterminal.com",
    ).length;
    expect(geckoCalls).toBe(2);
    // DexScreener still supplies the cap that GeckoTerminal could not.
    const [token] = await getTokens({
      db: env.DB,
      tokens: [{ chainId: 1, address: address({ n: 100 }) }],
    });
    expect(token?.market_cap_usd).toBe(500);
  });
});
