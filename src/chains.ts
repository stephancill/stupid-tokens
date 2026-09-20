import type { z } from "zod";
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
      return [
        {
          id: platform.chain_identifier,
          name: platform.name,
          platform: platform.id,
          nativeAssetId: platform.native_coin_id,
          native: nativeCurrencies.get(platform.chain_identifier) ?? null,
        },
      ];
    })
    .sort((a, b) => a.id - b.id);
}
