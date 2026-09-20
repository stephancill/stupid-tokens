-- Address-keyed price sources need the GeckoTerminal network slug, which differs from the
-- CoinGecko platform id (for example `eth` vs `ethereum`). Populated during catalog sync.
ALTER TABLE chains ADD COLUMN gt_network TEXT;
