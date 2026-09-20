import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importChain, syncCatalog } from "../src/catalog";
import { getTokens, stateValue } from "../src/database";
import { discoverChains } from "../src/chains";
import worker from "../src/index";

const tokenAddress = "0x000000000000000000000000000000000000000a";
const address = ({ n }: { n: number }) => `0x${n.toString(16).padStart(40, "0")}`;
type Platform = {
  id: string;
  name: string;
  chain_identifier: number | null;
  native_coin_id: string | null;
};
const platform = ({
  id,
  chainId,
  nativeId = "native-asset",
}: {
  id: string;
  chainId: number | null;
  nativeId?: string | null;
}): Platform => ({
  id,
  name: `${id} network`,
  chain_identifier: chainId,
  native_coin_id: nativeId,
});

function list({ chainId }: { chainId: number }) {
  return {
    name: "CoinGecko",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [
      { chainId, address: tokenAddress, name: "Discovered Token", symbol: "FOUND", decimals: 6 },
    ],
  };
}

function upstream({
  platforms,
  nativeChainIds = [],
  responses = {},
}: {
  platforms: Platform[];
  nativeChainIds?: number[];
  responses?: Record<string, () => Response>;
}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/asset_platforms")) return Response.json(platforms);
    if (url.pathname.endsWith("/coins/list"))
      return Response.json([
        {
          id: "shared-token",
          platforms: Object.fromEntries(platforms.map((item) => [item.id, tokenAddress])),
        },
      ]);
    if (url.hostname === "chainid.network")
      return Response.json(
        nativeChainIds.map((chainId) => ({
          chainId,
          nativeCurrency: { name: "Registry Currency", symbol: "REG", decimals: 8 },
        })),
      );
    if (url.hostname === "tokens.coingecko.com") {
      const id = decodeURIComponent(url.pathname.split("/")[1]!);
      const response = responses[id];
      if (response) return response();
      const item = platforms.find((item) => item.id === id);
      if (item?.chain_identifier) return Response.json(list({ chainId: item.chain_identifier }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

async function request({ path, method = "GET" }: { path: string; method?: string }) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { authorization: "Bearer test-admin-token" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

it("discovers unconfigured EVM chains, encodes platform IDs, and excludes null-ID platforms", async () => {
  const mock = upstream({
    platforms: [
      platform({ id: "sonic", chainId: 146 }),
      platform({ id: "New EVM", chainId: 9876543 }),
      platform({ id: "no-native-asset", chainId: 173, nativeId: null }),
      platform({ id: "solana", chainId: null }),
      platform({ id: "", chainId: null }),
    ],
    nativeChainIds: [146, 173],
  });
  const report = await syncCatalog({ env });
  expect(report.status).toBe("complete");
  expect(report.discoveredChains).toBe(3);
  expect(report.chains).toBe(3);
  expect(report.tokens).toBe(5);
  expect(report.imported).toEqual([
    { chainId: 146, tokens: 2, discarded: 0 },
    { chainId: 173, tokens: 2, discarded: 0 },
    { chainId: 9876543, tokens: 1, discarded: 0 },
  ]);
  expect(report.missingNativeMetadata).toEqual([9876543]);
  expect(report.missingNativeAssetId).toEqual([173]);
  const native = await getTokens({
    db: env.DB,
    tokens: [
      { chainId: 146, address: "native" },
      { chainId: 173, address: "native" },
    ],
  });
  expect(native.map((token) => token.decimals)).toEqual([8, 8]);
  expect(native.find((token) => token.chain_id === 173)?.asset_id).toBeNull();
  expect(
    await getTokens({ db: env.DB, tokens: [{ chainId: 9876543, address: tokenAddress }] }),
  ).toHaveLength(1);
  const urls = mock.mock.calls.map(([url]) => String(url));
  expect(urls).toContain("https://tokens.coingecko.com/New%20EVM/all.json");
  expect(urls.some((url) => url.includes("/solana/"))).toBe(false);
  const response = await request({ path: "/v1/chains" });
  const data = await response.json<{ chains: { chainId: number }[] }>();
  expect(data.chains.map((chain) => chain.chainId)).toEqual([146, 173, 9876543]);
  for (const chain of data.chains)
    expect(Object.keys(chain).sort()).toEqual(["chainId", "name", "syncedAt", "tokenCount"]);
  const status = await request({ path: "/admin/status" });
  const statusBody = await status.text();
  expect(statusBody).not.toContain('"platform"');
  expect(statusBody).not.toContain("shared-token");
  expect(statusBody).not.toContain("native-asset");
});

it("reports unavailable and empty token lists explicitly", async () => {
  upstream({
    platforms: [
      platform({ id: "available", chainId: 146 }),
      platform({ id: "missing", chainId: 147 }),
      platform({ id: "gone", chainId: 148 }),
      platform({ id: "empty", chainId: 149 }),
    ],
    responses: {
      missing: () => new Response(null, { status: 404 }),
      gone: () => new Response(null, { status: 410 }),
      empty: () => Response.json({ ...list({ chainId: 149 }), tokens: [] }),
    },
  });
  const response = await request({ path: "/admin/sync", method: "POST" });
  expect(response.status).toBe(200);
  const report = await response.json<{ chains: number; skipped: { reason: string }[] }>();
  expect(report.chains).toBe(1);
  expect(report.skipped.map((item) => item.reason)).toEqual([
    "token_list_http_404",
    "token_list_http_410",
    "empty_token_list",
  ]);
});

it("preserves failed-chain data, discards malformed entries, and reports degraded health on partial sync", async () => {
  await importChain({
    db: env.DB,
    chain: { id: 147, name: "Existing", platform: "mismatch" },
    now: Date.now(),
    tokens: [
      {
        chainId: 147,
        address: tokenAddress,
        assetId: null,
        name: "Existing Token",
        symbol: "OLD",
        decimals: 18,
        imageUrl: null,
      },
    ],
  });
  const malformed = list({ chainId: 149 });
  upstream({
    platforms: [
      platform({ id: "healthy", chainId: 146 }),
      platform({ id: "mismatch", chainId: 147 }),
      platform({ id: "unavailable", chainId: 148 }),
      platform({ id: "invalid", chainId: 149 }),
    ],
    responses: {
      mismatch: () => Response.json(list({ chainId: 999 })),
      unavailable: () => new Response(null, { status: 500 }),
      // A wrong-chain entry and a non-EVM address are dropped, not fatal.
      invalid: () =>
        Response.json({
          ...malformed,
          tokens: [
            malformed.tokens[0],
            { ...malformed.tokens[0], address: "not-an-evm-address" },
            { ...malformed.tokens[0], chainId: 1, address: address({ n: 9 }) },
          ],
        }),
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await request({ path: "/admin/sync", method: "POST" });
  expect(response.status).toBe(503);
  const report = await response.json<{
    status: string;
    chains: number;
    imported: { chainId: number; discarded: number }[];
    failures: { chainId: number; message: string }[];
  }>();
  expect(report.status).toBe("partial");
  expect(report.chains).toBe(2);
  expect(report.failures.map((failure) => failure.chainId)).toEqual([148]);
  expect(report.imported.find((chain) => chain.chainId === 149)?.discarded).toBe(2);
  for (const failure of report.failures)
    expect(failure.message).toBe(
      `Token import failed for chain ${failure.chainId}; see Worker logs`,
    );
  expect(log).toHaveBeenCalledTimes(1);
  expect(
    (await getTokens({ db: env.DB, tokens: [{ chainId: 147, address: tokenAddress }] }))[0]?.name,
  ).toBe("Existing Token");
  const health = await request({ path: "/health" });
  expect(health.status).toBe(503);
  expect(await health.json()).toMatchObject({ ready: true });
  expect((await request({ path: "/v1/search?q=found" })).status).toBe(200);
  expect(JSON.parse((await stateValue({ db: env.DB, key: "catalog_sync_report" }))!).status).toBe(
    "partial",
  );
});

it("sends the provider key header only when a key is configured", async () => {
  const chains = [{ id: 1, name: "Ethereum", platform: "ethereum" }];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "chainid.network")
      return Response.json([
        { chainId: 1, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
      ]);
    if (url.pathname.endsWith("/coins/list"))
      return Response.json([{ id: "x", platforms: { ethereum: address({ n: 5 }) } }]);
    if (url.pathname.endsWith("/asset_platforms"))
      return Response.json(
        chains.map((chain) => ({
          id: chain.platform,
          name: chain.name,
          chain_identifier: chain.id,
          native_coin_id: "ethereum",
        })),
      );
    if (url.hostname === "tokens.coingecko.com")
      return Response.json({
        name: "CoinGecko",
        timestamp: new Date().toISOString(),
        version: { major: 1, minor: 0, patch: 0 },
        tokens: [
          { chainId: 1, address: address({ n: 5 }), name: "Test", symbol: "TEST", decimals: 18 },
        ],
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  await syncCatalog({ env: { ...env, COINGECKO_API_KEY: "configured-key" } });
  const calls = vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => new URL(String(input)).hostname === "api.coingecko.com");
  expect(calls.length).toBeGreaterThan(0);
  for (const [, init] of calls)
    expect(init?.headers).toMatchObject({ "x-cg-demo-api-key": "configured-key" });
});

it("skips unchanged lists on repeat sync and reports pending chains", async () => {
  upstream({
    platforms: [
      platform({ id: "stable", chainId: 146 }),
      platform({ id: "missing", chainId: 147 }),
    ],
    responses: { missing: () => new Response(null, { status: 404 }) },
  });
  const first = await syncCatalog({ env });
  expect(first.status).toBe("complete");
  expect(first.chains).toBe(1);
  expect(first.pendingChains).toBe(0);
  const second = await syncCatalog({ env });
  expect(second.chains).toBe(0);
  expect(second.tokens).toBe(0);
  expect(second.skipped).toEqual([
    { chainId: 146, reason: "unchanged" },
    { chainId: 147, reason: "token_list_http_404" },
  ]);
  expect(second.status).toBe("complete");
});

it("fails explicitly when no lists are available and rejects ambiguous chain IDs", async () => {
  const platforms = [platform({ id: "missing", chainId: 146 })];
  upstream({ platforms, responses: { missing: () => new Response(null, { status: 404 }) } });
  const response = await request({ path: "/admin/sync", method: "POST" });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: "failed", chains: 0 });
  expect(await stateValue({ db: env.DB, key: "catalog_synced_at" })).toBeNull();
  expect(() =>
    discoverChains({
      platforms: [...platforms, platform({ id: "duplicate", chainId: 146 })],
      registry: [],
    }),
  ).toThrow("Duplicate platform chain ID");
});
