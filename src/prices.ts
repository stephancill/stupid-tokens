import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { getChainSources, getQuotes, writeQuotes } from "./database";
import { defillamaQuotes, dexscreenerQuotes, geckoTerminalQuotes, mergeQuotes } from "./providers";
import { refreshIdsSchema } from "./validation";
import { REFRESH_MS, type Env, type QuoteRow } from "./types";

type Pending = {
  promise: Promise<QuoteRow>;
  resolve: (quote: QuoteRow) => void;
  reject: (error: unknown) => void;
};

export class PriceCoordinator extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private queue = new Set<string>();
  private flushing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS budgets (name TEXT PRIMARY KEY, window TEXT NOT NULL, used INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS backoff (id INTEGER PRIMARY KEY, until_ms INTEGER NOT NULL)`,
    );
  }

  async getPrices({ ids }: { ids: string[] }): Promise<QuoteRow[]> {
    const validated = [...new Set(refreshIdsSchema.parse(ids))];
    const promises = validated.map((id) => {
      const existing = this.pending.get(id);
      if (existing) return existing.promise;
      let resolve!: Pending["resolve"];
      let reject!: Pending["reject"];
      const promise = new Promise<QuoteRow>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.pending.set(id, { promise, resolve, reject });
      this.queue.add(id);
      return promise;
    });
    if (!this.flushing) {
      this.flushing = true;
      this.ctx.waitUntil(this.flush());
    }
    return Promise.all(promises);
  }

  private async flush() {
    // Merge independent wallet requests without putting cached reads through this object.
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      while (this.queue.size) {
        // Keep batches within the tightest per-request provider limit.
        const ids = [...this.queue].slice(0, 30);
        for (const id of ids) this.queue.delete(id);
        try {
          const rows = await this.refresh({ ids });
          const byId = new Map(rows.map((row) => [row.id, row]));
          for (const id of ids) {
            const row = byId.get(id);
            if (row) this.pending.get(id)?.resolve(row);
            else this.pending.get(id)?.reject(new Error(`Unknown asset: ${id}`));
          }
        } catch (error) {
          for (const id of ids) this.pending.get(id)?.reject(error);
        } finally {
          for (const id of ids) this.pending.delete(id);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private reserveBudget({ now }: { now: number }): number | null {
    const sql = this.ctx.storage.sql;
    const backoff = sql
      .exec<{ until_ms: number }>("SELECT until_ms FROM backoff WHERE id = 1")
      .toArray()[0];
    if (backoff && backoff.until_ms > now) return backoff.until_ms;
    const date = new Date(now);
    const windows = [
      {
        name: "minute",
        window: String(Math.floor(now / 60_000)),
        limit: z.coerce.number().int().positive().parse(this.env.PRICE_REQUESTS_PER_MINUTE),
        reset: (Math.floor(now / 60_000) + 1) * 60_000,
      },
      {
        name: "month",
        window: date.toISOString().slice(0, 7),
        limit: z.coerce.number().int().positive().parse(this.env.PRICE_REQUESTS_PER_MONTH),
        reset: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      },
    ];
    for (const entry of windows) {
      const budget = sql
        .exec<{ window: string; used: number }>(
          "SELECT window, used FROM budgets WHERE name = ?",
          entry.name,
        )
        .toArray()[0];
      if (budget?.window === entry.window && budget.used >= entry.limit) return entry.reset;
    }
    for (const entry of windows) {
      sql.exec(
        `INSERT INTO budgets(name, window, used) VALUES (?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET window = excluded.window,
        used = CASE WHEN budgets.window = excluded.window THEN budgets.used + 1 ELSE 1 END`,
        entry.name,
        entry.window,
      );
    }
    return null;
  }

  private async refresh({ ids }: { ids: string[] }) {
    const rows = await getQuotes({ db: this.env.DB, ids });
    const now = Date.now();
    const ready: QuoteRow[] = [];
    const eligible: QuoteRow[] = [];
    for (const row of rows) {
      if (row.refresh_after > now) {
        ready.push(
          row.price_status === "refreshing" ? { ...row, price_status: "upstream_error" } : row,
        );
        continue;
      }
      const reservation = this.ctx.storage.sql
        .exec<{ until_ms: number }>("SELECT until_ms FROM reservations WHERE id = ?", row.id)
        .toArray()[0];
      if (reservation && reservation.until_ms > now) {
        // Recover conservatively when an object was evicted after dispatch but before saving the result.
        ready.push({
          ...row,
          price_usd: null,
          price_status: "upstream_error",
          refresh_after: reservation.until_ms,
        });
      } else {
        eligible.push(row);
      }
    }
    if (!eligible.length) return ready;

    const blockedUntil = this.reserveBudget({ now });
    if (blockedUntil !== null) {
      const blocked = eligible.map((row): QuoteRow => ({
        ...row,
        price_usd: null,
        price_status: "rate_limited",
        refresh_after: Math.min(blockedUntil, now + 60_000),
      }));
      await writeQuotes({ db: this.env.DB, quotes: blocked, updateMarketCap: false });
      return [...ready, ...blocked];
    }

    const reserved = eligible.map((row): QuoteRow => ({
      ...row,
      price_usd: null,
      price_status: "refreshing",
      last_attempt_at: now,
      refresh_after: now + REFRESH_MS,
    }));
    for (const row of reserved) {
      this.ctx.storage.sql.exec(
        `INSERT INTO reservations(id, until_ms) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET until_ms = excluded.until_ms`,
        row.id,
        row.refresh_after,
      );
    }
    // Persist reservations before external I/O. D1 exposes the cooldown to all edge readers.
    await this.ctx.storage.sync();
    await writeQuotes({ db: this.env.DB, quotes: reserved, updateMarketCap: false });

    let quotes: QuoteRow[];
    let updateMarketCap = false;
    try {
      // Identity is chainId:address, so sources are queried by chain and address directly.
      const tokens = reserved.map((row) => {
        const [chainId, ...rest] = row.id.split(":");
        return { chainId: Number(chainId), address: rest.join(":") };
      });
      const chainSources = await getChainSources({
        db: this.env.DB,
        chainIds: [...new Set(tokens.map((token) => token.chainId))],
      });
      const fetchedAt = Date.now();
      const merged = mergeQuotes({
        sources: [
          await defillamaQuotes({ tokens, chains: chainSources }),
          await geckoTerminalQuotes({ tokens, chains: chainSources }),
          await dexscreenerQuotes({ tokens, chains: chainSources }),
        ],
      });
      quotes = reserved.map((row): QuoteRow => {
        const value = merged.get(row.id);
        const updatedAt = value?.priceUpdatedAt ?? null;
        const fresh = updatedAt === null || updatedAt <= fetchedAt + 60_000;
        const valid = Boolean(value?.priceUsd) && fresh;
        const newerCap =
          value?.marketCapUsd !== null &&
          value?.marketCapUsd !== undefined &&
          (value.marketCapUpdatedAt ?? 0) >= (row.market_cap_updated_at ?? 0);
        return {
          ...row,
          price_usd: valid ? value!.priceUsd : null,
          price_updated_at: updatedAt,
          price_status: valid ? "ok" : "price_unavailable",
          fetched_at: fetchedAt,
          market_cap_usd: newerCap ? value!.marketCapUsd : row.market_cap_usd,
          market_cap_updated_at: newerCap
            ? (value!.marketCapUpdatedAt ?? fetchedAt)
            : row.market_cap_updated_at,
        };
      });
      updateMarketCap = true;
    } catch (error) {
      console.error("price_refresh_failed", {
        assets: reserved.length,
        message: error instanceof Error ? error.message : "Unknown upstream failure",
      });
      const throttled =
        error instanceof Error &&
        "upstreamStatus" in error &&
        (error.upstreamStatus === 429 || error.upstreamStatus === 403);
      if (throttled) {
        const retryAt =
          "retryAt" in error && typeof error.retryAt === "number" ? error.retryAt : now + 60_000;
        this.ctx.storage.sql.exec(
          `INSERT INTO backoff(id, until_ms) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET until_ms = excluded.until_ms`,
          retryAt,
        );
      }
      quotes = reserved.map((row): QuoteRow => ({
        ...row,
        price_status: throttled ? "rate_limited" : "upstream_error",
      }));
    }
    await writeQuotes({ db: this.env.DB, quotes, updateMarketCap });
    return [...ready, ...quotes];
  }
}
