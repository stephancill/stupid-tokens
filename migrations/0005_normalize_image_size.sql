-- CoinGecko token lists embed the 25x25 `/thumb/` logo variant, which is too small for
-- UI use. The identical asset is served at `/large/` (250x250) from the same URL with a
-- different size segment, so upgrade CoinGecko image URLs in place. Only CoinGecko image
-- hosts are rewritten; unrelated hosts are left untouched.
-- `instr` is used instead of `LIKE` because D1 rejects the multi-wildcard pattern as too
-- complex.
UPDATE tokens
SET image_url = replace(image_url, '/thumb/', '/large/')
WHERE instr(image_url, '/thumb/') > 0
  AND (
    instr(image_url, 'https://assets.coingecko.com/coins/images/') = 1
    OR instr(image_url, 'https://coin-images.coingecko.com/coins/images/') = 1
  );

UPDATE assets
SET image_url = replace(image_url, '/thumb/', '/large/')
WHERE instr(image_url, '/thumb/') > 0
  AND (
    instr(image_url, 'https://assets.coingecko.com/coins/images/') = 1
    OR instr(image_url, 'https://coin-images.coingecko.com/coins/images/') = 1
  );
