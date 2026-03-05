ALTER TABLE chunks ADD COLUMN concept_refs TEXT;  -- JSON array of concept IDs
ALTER TABLE chunks ADD COLUMN symbol_refs TEXT;    -- JSON array of symbol IDs
