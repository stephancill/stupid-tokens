-- Assets whose market cap cannot be resolved stayed NULL and were therefore re-selected first
-- on every backfill run, so the budget was spent on the same uncappable assets forever.
-- Record when an asset was last attempted, independent of whether a cap was found.
ALTER TABLE assets ADD COLUMN market_cap_checked_at INTEGER;
