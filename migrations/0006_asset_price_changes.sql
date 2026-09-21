-- DefiLlama exposes percent price changes over 1h, 24h, and 7d through its percentage
-- endpoint, which returns a percentage and carries no source timestamp. Store the change plus
-- the fetch time so writes can be guarded by that time, mirroring market caps. All three
-- columns are nullable: long-tail tokens with insufficient history have no change for a given
-- window.
ALTER TABLE assets ADD COLUMN change_1h REAL;
ALTER TABLE assets ADD COLUMN change_24h REAL;
ALTER TABLE assets ADD COLUMN change_7d REAL;
ALTER TABLE assets ADD COLUMN changes_updated_at INTEGER;
