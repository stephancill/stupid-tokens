-- Skipped or failed chains previously recorded no timestamp, so they were re-fetched on every
-- sync forever. Record when a chain was last checked and the outcome, so permanent
-- unavailability and transient failure can use different retry cadences.
ALTER TABLE chains ADD COLUMN checked_at INTEGER;
ALTER TABLE chains ADD COLUMN sync_status TEXT;
