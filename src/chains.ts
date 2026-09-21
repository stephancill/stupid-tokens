import type { z } from "zod";
import { normalizeImageUrl } from "./providers";
import type { chainRegistrySchema, platformsSchema } from "./validation";

export const CHAIN_REGISTRY_URL = "https://chainid.network/chains.json";

export function discoverChains({
  platforms,
  registry,
  nativeImages = new Map(),
}: {
  platforms: z.infer<typeof platformsSchema>;
  registry: z.infer<typeof chainRegistrySchema>;
  // Native coin id to coin image, resolved from the platform's `native_coin_id`.
  nativeImages?: Map<string, string>;
}) {
  const nativeCurrencies = new Map(registry.map((chain) => [chain.chainId, chain.nativeCurrency]));
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
      // The native currency's logo is its own coin image when it resolves. The platform image
      // is a chain logo, so it is only a fallback for coins the image lookup cannot resolve.
      const nativeImage =
        (platform.native_coin_id ? nativeImages.get(platform.native_coin_id) : undefined) ??
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
