-- Add bound_body snapshot to concept_symbols.
-- Stores the full symbol body text at binding time, enabling before/after diffs
-- when drift is detected (bound_body_hash != symbols.body_hash).
-- NULL for existing rows (degraded gracefully until re-bound).
ALTER TABLE concept_symbols ADD COLUMN bound_body TEXT;
