-- CoinGecko token lists embed the 25x25 `/thumb/` logo variant, which is too small for
-- UI use. The identical asset is served at `/large/` (250x250) from the same URL with a
-- different size segment, so upgrade CoinGecko image URLs in place. Only CoinGecko image
-- hosts are rewritten; unrelated hosts are left untouched.
UPDATE tokens
SET image_url = replace(image_url, '/thumb/', '/large/')
WHERE image_url LIKE 'https://assets.coingecko.com/coins/images/%/thumb/%'
   OR image_url LIKE 'https://coin-images.coingecko.com/coins/images/%/thumb/%';

UPDATE assets
SET image_url = replace(image_url, '/thumb/', '/large/')
WHERE image_url LIKE 'https://assets.coingecko.com/coins/images/%/thumb/%'
   OR image_url LIKE 'https://coin-images.coingecko.com/coins/images/%/thumb/%';
