import { z } from "zod";
import { fetchJson } from "./coingecko";
import { geckoTerminalNetworksSchema } from "./validation";

// Address-keyed sources, so identity stays chainId + address and no provider coin-ID
// mapping is needed. DefiLlama is aggregated and robust for majors; GeckoTerminal
// supplies market caps and images; DexScreener is the long-tail fallback.
export type ProviderName = "defillama" | "geckoterminal" | "dexscreener";

export type ProviderQuote = {
  priceUsd: string | null;
  priceUpdatedAt: number | null;
  marketCapUsd: number | null;
  marketCapUpdatedAt: number | null;
  imageUrl: string | null;
  source: ProviderName;
};

export type ChainSource = {
  chainId: number;
  platformId: string;
  geckoTerminalNetwork: string | null;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE = "native";
// A DEX price from a thin pool is trivially manipulated, so require real liquidity.
export const MIN_LIQUIDITY_USD = 10_000;

const DEFILLAMA_ALIASES: Record<string, string> = {
  "binance-smart-chain": "bsc",
  "polygon-pos": "polygon",
  "arbitrum-one": "arbitrum",
  "optimistic-ethereum": "optimism",
  avalanche: "avax",
  xdai: "gnosis",
};
const DEXSCREENER_ALIASES: Record<string, string> = {
  "binance-smart-chain": "bsc",
  "polygon-pos": "polygon",
  "arbitrum-one": "arbitrum",
  "optimistic-ethereum": "optimism",
  xdai: "gnosis",
};

export function defillamaSlug({ platformId }: { platformId: string }) {
  return DEFILLAMA_ALIASES[platformId] ?? platformId;
}
export function dexscreenerSlug({ platformId }: { platformId: string }) {
  return DEXSCREENER_ALIASES[platformId] ?? platformId;
}
export function geckoTerminalNetwork({
  platformId,
  network,
}: {
  platformId: string;
  network: string | null;
}) {
  return network ?? platformId;
}

function toDecimal({ value }: { value: number }): string | null {
  if (!Number.isFinite(value)) return null;
  const [coefficient = "0", exponent] = String(value).split("e");
  if (exponent === undefined) return coefficient;
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const position = whole.length + Number(exponent);
  if (position <= 0) return `0.${"0".repeat(-position)}${digits}`;
  if (position >= digits.length) return digits + "0".repeat(position - digits.length);
  return `${digits.slice(0, position)}.${digits.slice(position)}`;
}

const defillamaSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      price: z.number().finite().nonnegative().nullish(),
      decimals: z.number().int().nullish(),
      symbol: z.string().nullish(),
      timestamp: z.number().int().nonnegative().nullish(),
      confidence: z.number().min(0).max(1).nullish(),
    }),
  ),
});

const geckoTerminalSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        address: z.string(),
        price_usd: z.string().nullish(),
        market_cap_usd: z.string().nullish(),
        image_url: z.string().nullish(),
        total_reserve_in_usd: z.string().nullish(),
      }),
    }),
  ),
});

const dexscreenerSchema = z.array(
  z.object({
    chainId: z.string(),
    priceUsd: z.string().nullish(),
    marketCap: z.number().finite().nonnegative().nullish(),
    fdv: z.number().finite().nonnegative().nullish(),
    baseToken: z.object({ address: z.string() }).nullish(),
    liquidity: z.object({ usd: z.number().finite().nonnegative().nullish() }).nullish(),
  }),
);

function key({ chainId, address }: { chainId: number; address: string }) {
  return `${chainId}:${address}`;
}

function chunk<T>({ items, size }: { items: T[]; size: number }) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

export async function defillamaQuotes({
  tokens,
  chains,
}: {
  tokens: { chainId: number; address: string }[];
  chains: Map<number, ChainSource>;
}): Promise<Map<string, ProviderQuote>> {
  const results = new Map<string, ProviderQuote>();
  // DefiLlama accepts large batches; keep the URL comfortably short.
  for (const batch of chunk({ items: tokens, size: 100 })) {
    const ids = batch.map((token) => {
      const chain = chains.get(token.chainId);
      if (!chain) return null;
      const slug = defillamaSlug({ platformId: chain.platformId });
      return `${slug}:${token.address === NATIVE ? ZERO_ADDRESS : token.address}`;
    });
    const usable = ids.filter((id): id is string => id !== null);
    if (!usable.length) continue;
    const data = defillamaSchema.parse(
      await fetchJson({
        url: `https://coins.llama.fi/prices/current/${usable.join(",")}`,
        timeoutMs: 10_000,
        attempts: 2,
      }),
    );
    for (const [index, token] of batch.entries()) {
      const id = ids[index];
      const coin = id ? data.coins[id] : undefined;
      if (!coin || coin.price === null || coin.price === undefined) continue;
      if (coin.confidence !== null && coin.confidence !== undefined && coin.confidence < 0.5)
        continue;
      results.set(key(token), {
        priceUsd: toDecimal({ value: coin.price }),
        priceUpdatedAt: coin.timestamp ? coin.timestamp * 1000 : null,
        marketCapUsd: null,
        marketCapUpdatedAt: null,
        imageUrl: null,
        source: "defillama",
      });
    }
  }
  return results;
}

export async function geckoTerminalQuotes({
  tokens,
  chains,
}: {
  tokens: { chainId: number; address: string }[];
  chains: Map<number, ChainSource>;
}): Promise<Map<string, ProviderQuote>> {
  const results = new Map<string, ProviderQuote>();
  const byChain = new Map<number, string[]>();
  for (const token of tokens) {
    // Native currencies have no contract address; DefiLlama covers them.
    if (token.address === NATIVE || !chains.has(token.chainId)) continue;
    byChain.set(token.chainId, [...(byChain.get(token.chainId) ?? []), token.address]);
  }
  for (const [chainId, addresses] of byChain) {
    const chain = chains.get(chainId)!;
    const network = geckoTerminalNetwork({
      platformId: chain.platformId,
      network: chain.geckoTerminalNetwork,
    });
    for (const batch of chunk({ items: addresses, size: 30 })) {
      const data = geckoTerminalSchema.parse(
        await fetchJson({
          url: `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/tokens/multi/${batch.join(",")}`,
          timeoutMs: 10_000,
          attempts: 2,
        }),
      );
      for (const item of data.data) {
        const attributes = item.attributes;
        const address = attributes.address.toLowerCase();
        const liquidity = attributes.total_reserve_in_usd
          ? Number(attributes.total_reserve_in_usd)
          : null;
        const price = attributes.price_usd ? Number(attributes.price_usd) : null;
        const usable = price !== null && (liquidity === null || liquidity >= MIN_LIQUIDITY_USD);
        const marketCap = attributes.market_cap_usd ? Number(attributes.market_cap_usd) : null;
        results.set(key({ chainId, address }), {
          priceUsd: usable ? toDecimal({ value: price }) : null,
          priceUpdatedAt: Date.now(),
          marketCapUsd: marketCap,
          marketCapUpdatedAt: Date.now(),
          imageUrl: attributes.image_url ?? null,
          source: "geckoterminal",
        });
      }
    }
  }
  return results;
}

export async function dexscreenerQuotes({
  tokens,
  chains,
}: {
  tokens: { chainId: number; address: string }[];
  chains: Map<number, ChainSource>;
}): Promise<Map<string, ProviderQuote>> {
  const results = new Map<string, ProviderQuote>();
  const byChain = new Map<number, string[]>();
  for (const token of tokens) {
    if (token.address === NATIVE || !chains.has(token.chainId)) continue;
    byChain.set(token.chainId, [...(byChain.get(token.chainId) ?? []), token.address]);
  }
  for (const [chainId, addresses] of byChain) {
    const chain = chains.get(chainId)!;
    const slug = dexscreenerSlug({ platformId: chain.platformId });
    for (const batch of chunk({ items: addresses, size: 30 })) {
      const data = dexscreenerSchema.parse(
        await fetchJson({
          url: `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(slug)}/${batch.join(",")}`,
          timeoutMs: 10_000,
          attempts: 2,
        }),
      );
      // A token can have many pairs; only the deepest-liquidity one is meaningful.
      const best = new Map<string, (typeof data)[number]>();
      for (const pair of data) {
        const address = pair.baseToken?.address?.toLowerCase();
        if (!address || !batch.includes(address)) continue;
        const existing = best.get(address);
        const liquidity = pair.liquidity?.usd ?? 0;
        const existingLiquidity = existing?.liquidity?.usd ?? 0;
        if (!existing || liquidity > existingLiquidity) best.set(address, pair);
      }
      for (const address of batch) {
        const pair = best.get(address);
        if (!pair) continue;
        const liquidity = pair.liquidity?.usd ?? 0;
        const price = pair.priceUsd ? Number(pair.priceUsd) : null;
        results.set(key({ chainId, address }), {
          priceUsd:
            price !== null && liquidity >= MIN_LIQUIDITY_USD ? toDecimal({ value: price }) : null,
          priceUpdatedAt: Date.now(),
          marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
          marketCapUpdatedAt: Date.now(),
          imageUrl: null,
          source: "dexscreener",
        });
      }
    }
  }
  return results;
}

export async function geckoTerminalNetworks() {
  // GeckoTerminal network slugs differ from CoinGecko platform ids (eth vs ethereum),
  // so map by the platform id it reports rather than guessing.
  const mapping = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const data = geckoTerminalNetworksSchema.parse(
      await fetchJson({
        url: `https://api.geckoterminal.com/api/v2/networks?page=${page}`,
        timeoutMs: 10_000,
        attempts: 2,
      }),
    );
    for (const item of data.data) {
      const platformId = item.attributes?.coingecko_asset_platform_id;
      if (platformId) mapping.set(platformId, item.id);
    }
    if (data.data.length < 100) break;
  }
  return mapping;
}

// A source that is throttled or broken must not discard results from the others, so each
// is isolated. Only if every source fails does the refresh count as an upstream failure.
export async function trySources({
  loaders,
}: {
  loaders: { name: ProviderName; load: () => Promise<Map<string, ProviderQuote>> }[];
}) {
  const sources: Map<string, ProviderQuote>[] = [];
  let lastError: unknown = null;
  let failures = 0;
  for (const loader of loaders) {
    try {
      sources.push(await loader.load());
    } catch (error) {
      failures++;
      lastError = error;
      console.error("price_source_failed", {
        source: loader.name,
        message: error instanceof Error ? error.message : "Unknown upstream failure",
      });
      sources.push(new Map());
    }
  }
  if (failures === loaders.length && lastError) throw lastError;
  return mergeQuotes({ sources });
}

// Merge sources in priority order: the first provider with a usable value wins per field.
export function mergeQuotes({ sources }: { sources: Map<string, ProviderQuote>[] }) {
  const merged = new Map<string, ProviderQuote>();
  for (const source of sources) {
    for (const [id, quote] of source) {
      const current = merged.get(id);
      if (!current) {
        merged.set(id, quote);
        continue;
      }
      merged.set(id, {
        priceUsd: current.priceUsd ?? quote.priceUsd,
        priceUpdatedAt: current.priceUsd ? current.priceUpdatedAt : quote.priceUpdatedAt,
        marketCapUsd: current.marketCapUsd ?? quote.marketCapUsd,
        marketCapUpdatedAt: current.marketCapUsd
          ? current.marketCapUpdatedAt
          : quote.marketCapUpdatedAt,
        imageUrl: current.imageUrl ?? quote.imageUrl,
        source: current.priceUsd ? current.source : quote.source,
      });
    }
  }
  return merged;
}
