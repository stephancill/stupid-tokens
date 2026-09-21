import type { z } from "zod";
import { normalizeImageUrl } from "./providers";
import type { chainRegistrySchema, platformsSchema } from "./validation";

export const CHAIN_REGISTRY_URL = "https://chainid.network/chains.json";

export function discoverChains({
  platforms,
  registry,
}: {
  platforms: z.infer<typeof platformsSchema>;
  registry: z.infer<typeof chainRegistrySchema>;
}) {
  const nativeCurrencies = new Map(registry.map((chain) => [chain.chainId, chain.nativeCurrency]));
  // CoinGecko platform IDs and coin IDs share a namespace, so a platform whose ID equals a
  // currency's `native_coin_id` carries that coin's own logo. CoinGecko does not need to be
  // asked anything extra: the platform list is already fetched, and the shared namespace makes
  // ETH-native L2s resolve to the Ethereum coin image rather than the L2's chain logo.
  const platformImages = new Map(
    platforms.flatMap((platform) =>
      platform.image?.large ? [[platform.id, platform.image.large] as const] : [],
    ),
  );
  const seen = new Set<number>();
  return platforms
    .flatMap((platform) => {
      // CoinGecko defines chain_identifier as the platform's Chainlist/EIP-155 ID.
      if (platform.chain_identifier === null) return [];
      if (!platform.id.trim())
        throw new Error(`Missing platform ID for chain ${platform.chain_identifier}`);
      if (seen.has(platform.chain_identifier))
        throw new Error(`Duplicate platform chain ID: ${platform.chain_identifier}`);
      seen.add(platform.chain_identifier);
      const currency = nativeCurrencies.get(platform.chain_identifier);
      // The currency's own coin image wins; the platform's chain image is the fallback for
      // coins that are not themselves a platform, so a logo is never guessed.
      const nativeImage =
        (platform.native_coin_id ? platformImages.get(platform.native_coin_id) : undefined) ??
        platform.image?.large ??
        null;
      return [
        {
          id: platform.chain_identifier,
          name: platform.name,
          platform: platform.id,
          native: currency
            ? { ...currency, imageUrl: normalizeImageUrl({ url: nativeImage }) }
            : null,
        },
      ];
    })
    .sort((a, b) => a.id - b.id);
}
