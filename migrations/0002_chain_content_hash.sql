-- Skip re-importing token lists whose content has not changed between syncs.
ALTER TABLE chains ADD COLUMN content_hash TEXT;
