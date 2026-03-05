ALTER TABLE chunks ADD COLUMN file_refs TEXT;  -- JSON array of {path, lines?} for non-indexed files
