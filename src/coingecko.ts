import { z } from "zod";
import type { Env } from "./types";

export function apiConfig({ env }: { env: Env }) {
  const plan = z.enum(["demo", "pro"]).parse(env.COINGECKO_PLAN ?? "demo");
  const key = z
    .string()
    .min(1)
    .optional()
    .parse(env.COINGECKO_API_KEY || undefined);
  return {
    base:
      plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3",
    headers: key ? { [plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: key } : {},
  };
}

// CoinGecko's keyless API rejects requests without a descriptive User-Agent (HTTP 403).
export const USER_AGENT = "stupid-tokens/1.0 (+https://tokens.stupidtech.net)";

export async function fetchJson({
  url,
  headers = {},
  timeoutMs = 15_000,
  attempts = 3,
}: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  attempts?: number;
}): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
    if (response.ok) return response.json();
    const retry = response.headers.get("retry-after");
    const retryAt = retry
      ? /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry)
      : NaN;
    await response.body?.cancel();
    // Keyless access is commonly throttled with 429 or 403, so retry those and 5xx briefly.
    const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
    if (retryable && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      continue;
    }
    throw Object.assign(new Error(`${new URL(url).hostname} returned HTTP ${response.status}`), {
      upstreamStatus: response.status,
      retryAt: Number.isFinite(retryAt) ? retryAt : Date.now() + 60_000,
    });
  }
}

export async function apiJson({
  env,
  path,
  query = {},
}: {
  env: Env;
  path: string;
  query?: Record<string, string>;
}) {
  const { base, headers } = apiConfig({ env });
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetchJson({ url: url.toString(), headers });
}

// Both the provider's ID cap and URL length matter for batches of long coin IDs.
export function priceBatch({ ids }: { ids: string[] }) {
  const batch: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    const size = encodeURIComponent(id).length + 3;
    if (batch.length >= 500 || bytes + size > 7_000) break;
    batch.push(id);
    bytes += size;
  }
  return batch;
}
