import { z } from "zod";

export const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());
export const tokenIdSchema = z.strictObject({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  address: z.union([evmAddress, z.literal("native")]),
});
export const priceRequestSchema = z.strictObject({
  tokens: z.array(tokenIdSchema).min(1).max(50),
});
export const searchSchema = z.strictObject({
  q: z.string().trim().min(2).max(100),
  chainId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const assetIdsSchema = z.array(z.string().min(1).max(250)).min(1).max(100);
// Quote identity is `chainId:address`, matching the address-keyed providers. The
// coordinator accepts a full bulk request and chunks internally for each provider.
export const refreshIdsSchema = z
  .array(z.string().regex(/^\d+:(?:native|0x[0-9a-f]{40})$/))
  .min(1)
  .max(100);

const chainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const catalogReportSchema = z.object({
  status: z.enum(["complete", "partial", "failed"]),
  discoveredChains: z.number().int().nonnegative(),
  chains: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  pendingChains: z.number().int().nonnegative().default(0),
  pending: z.array(chainIdSchema).default([]),
  budgetExhausted: z.boolean().default(false),
  freshChains: z.number().int().nonnegative().default(0),
  syncedAt: z.iso.datetime(),
  imported: z.array(
    z.object({
      chainId: chainIdSchema,
      tokens: z.number().int().nonnegative(),
      discarded: z.number().int().nonnegative().default(0),
    }),
  ),
  skipped: z.array(
    z.object({
      chainId: chainIdSchema,
      reason: z.enum([
        "empty_token_list",
        "token_list_http_404",
        "token_list_http_410",
        "unchanged",
      ]),
    }),
  ),
  // Upstream validation/database error strings can contain provider IDs. Details stay in logs.
  failures: z.array(
    z.object({ chainId: chainIdSchema }).transform(({ chainId }) => ({
      chainId,
      message: `Token import failed for chain ${chainId}; see Worker logs`,
    })),
  ),
  missingNativeMetadata: z.array(chainIdSchema),
});

export const tokenListSchema = z.object({
  name: z.string().optional(),
  timestamp: z.iso.datetime({ offset: true }).nullish(),
  version: z
    .object({
      major: z.number().nullish(),
      minor: z.number().nullish(),
      patch: z.number().nullish(),
    })
    .nullish(),
  tokens: z.array(
    z.object({
      chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
      address: z.string().max(100),
      name: z.string().max(500).nullish(),
      symbol: z.string().max(100).nullish(),
      decimals: z.number().int().min(0).max(255).nullish(),
      logoURI: z.string().url().nullish(),
    }),
  ),
});
export type TokenListToken = z.infer<typeof tokenListSchema>["tokens"][number];

export const coinsSchema = z.array(
  z.object({
    id: z.string().min(1).max(250),
    platforms: z.record(z.string(), z.string().nullable()).optional(),
  }),
);
export const geckoTerminalNetworksSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({ coingecko_asset_platform_id: z.string().nullish() }).nullish(),
    }),
  ),
});
export const platformsSchema = z.array(
  z.object({
    id: z.string().max(250),
    name: z.string().min(1).max(500),
    chain_identifier: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    // The native coin id lets the native currency's own logo be resolved without the large
    // `/coins/list` mapping. The platform image is a chain logo, used only as a fallback.
    native_coin_id: z.string().nullable(),
    image: z.object({ large: z.string().url().nullish() }).nullish(),
  }),
);
export const chainRegistrySchema = z.array(
  z.object({
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nativeCurrency: z.object({
      name: z.string().min(1).max(500),
      symbol: z.string().min(1).max(100),
      decimals: z.number().int().min(0).max(255),
    }),
  }),
);
export const priceDataSchema = z.record(
  z.string(),
  z.object({
    usd: z.number().finite().nonnegative().nullish(),
    usd_market_cap: z.number().finite().nonnegative().nullish(),
    last_updated_at: z.number().int().nonnegative().nullish(),
  }),
);
export const marketsSchema = z.array(
  z.object({
    id: z.string(),
    image: z.string().url().nullish(),
    market_cap: z.number().finite().nonnegative().nullish(),
    last_updated: z.iso.datetime({ offset: true }).nullish(),
  }),
);
