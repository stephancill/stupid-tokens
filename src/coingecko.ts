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

export async function fetchJson({
  url,
  headers = {},
  timeoutMs = 15_000,
}: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const retryAt = retry
      ? /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry)
      : NaN;
    await response.body?.cancel();
    throw Object.assign(new Error(`${new URL(url).hostname} returned HTTP ${response.status}`), {
      upstreamStatus: response.status,
      retryAt: Number.isFinite(retryAt) ? retryAt : Date.now() + 60_000,
    });
  }
  return response.json();
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
