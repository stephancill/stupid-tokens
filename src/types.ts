import type { PriceCoordinator } from "./prices";

export interface Env {
  DB: D1Database;
  PRICES: DurableObjectNamespace<PriceCoordinator>;
  ASSETS: Fetcher;
  // Omit for CoinGecko's keyless public API, or set COINGECKO_PLAN=pro with a Pro key.
  COINGECKO_API_KEY?: string;
  COINGECKO_PLAN?: string;
  ADMIN_TOKEN: string;
  PRICE_REQUESTS_PER_MINUTE: string;
  PRICE_REQUESTS_PER_MONTH: string;
}

export type TokenId = { chainId: number; address: string };

export type TokenRow = {
  chain_id: number;
  address: string;
  asset_id: string | null;
  name: string;
  symbol: string;
  decimals: number;
  image_url: string | null;
  metadata_updated_at: number;
  market_cap_usd: number | null;
  market_cap_updated_at: number | null;
};

export type QuoteStatus =
  | "ok"
  | "price_unavailable"
  | "upstream_error"
  | "rate_limited"
  | "refreshing";

export type QuoteRow = {
  id: string;
  price_usd: string | null;
  price_updated_at: number | null;
  market_cap_usd: number | null;
  market_cap_updated_at: number | null;
  // Percent price changes (1.5 means 1.5%), not ratios. `changes_updated_at` records when the
  // primary source supplied them because the percentage endpoint has no source timestamp.
  change_1h: number | null;
  change_24h: number | null;
  change_7d: number | null;
  changes_updated_at: number | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  refresh_after: number;
  price_status: QuoteStatus;
};

export const REFRESH_MS = 300_000;

export function tokenKey({ chainId, address }: TokenId) {
  return `${chainId}:${address}`;
}

export function iso({ time }: { time: number | null }) {
  return time === null ? null : new Date(time).toISOString();
}

export function decimal({ value }: { value: number | null }): string | null {
  if (value === null) return null;
  const [coefficient = "0", exponent] = String(value).split("e");
  if (exponent === undefined) return coefficient;
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const position = whole.length + Number(exponent);
  if (position <= 0) return `0.${"0".repeat(-position)}${digits}`;
  if (position >= digits.length) return digits + "0".repeat(position - digits.length);
  return `${digits.slice(0, position)}.${digits.slice(position)}`;
}

export function tokenResponse({ row }: { row: TokenRow }) {
  return {
    chainId: row.chain_id,
    address: row.address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    imageUrl: row.image_url,
    marketCapUsd: decimal({ value: row.market_cap_usd }),
    marketCapUpdatedAt: iso({ time: row.market_cap_updated_at }),
    metadataUpdatedAt: iso({ time: row.metadata_updated_at }),
  };
}

export function priceResponse({
  token,
  metadata,
  quote,
  now,
}: {
  token: TokenId;
  metadata?: TokenRow;
  quote?: QuoteRow;
  now: number;
}) {
  const stale =
    quote?.price_status === "ok" &&
    (quote.price_updated_at === null || now - quote.price_updated_at > REFRESH_MS);
  const ok = !stale && quote?.price_status === "ok";
  return {
    ...token,
    // Metadata is included so a caller does not need a second request per token. It is null for
    // a token that is absent from the catalog.
    name: metadata?.name ?? null,
    symbol: metadata?.symbol ?? null,
    decimals: metadata?.decimals ?? null,
    imageUrl: metadata?.image_url ?? null,
    status: stale ? "stale" : (quote?.price_status ?? "price_unavailable"),
    priceUsd: ok ? quote!.price_usd : null,
    priceUpdatedAt: iso({ time: quote?.price_updated_at ?? null }),
    // Changes are derived from the same source data as the price, so they are withheld with it
    // whenever the price is stale or unavailable.
    priceChange: {
      h1: ok ? decimal({ value: quote?.change_1h ?? null }) : null,
      h24: ok ? decimal({ value: quote?.change_24h ?? null }) : null,
      d7: ok ? decimal({ value: quote?.change_7d ?? null }) : null,
    },
    marketCapUsd: decimal({ value: quote?.market_cap_usd ?? null }),
    marketCapUpdatedAt: iso({ time: quote?.market_cap_updated_at ?? null }),
    metadataUpdatedAt: iso({ time: metadata?.metadata_updated_at ?? null }),
    fetchedAt: iso({ time: quote?.fetched_at ?? null }),
    nextRefreshAt: quote ? iso({ time: quote.refresh_after }) : null,
  };
}
