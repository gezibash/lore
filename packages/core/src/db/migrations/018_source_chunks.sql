ALTER TABLE chunks ADD COLUMN source_file_path TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_source_file_path
  ON chunks(source_file_path) WHERE source_file_path IS NOT NULL;
