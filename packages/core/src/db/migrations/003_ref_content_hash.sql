CREATE TABLE chunk_refs_new (
  id               TEXT PRIMARY KEY,
  chunk_id         TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  git_commit_sha   TEXT,
  git_blob_hash    TEXT,
  line_start       INTEGER,
  line_end         INTEGER,
  created_at       TEXT NOT NULL
);

INSERT INTO chunk_refs_new (
  id,
  chunk_id,
  file_path,
  content_hash,
  git_commit_sha,
  git_blob_hash,
  line_start,
  line_end,
  created_at
)
SELECT
  id,
  chunk_id,
  file_path,
  blob_hash AS content_hash,
  commit_sha AS git_commit_sha,
  blob_hash AS git_blob_hash,
  line_start,
  line_end,
  created_at
FROM chunk_refs;

DROP TABLE chunk_refs;
ALTER TABLE chunk_refs_new RENAME TO chunk_refs;

CREATE INDEX IF NOT EXISTS idx_chunk_refs_chunk ON chunk_refs(chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_refs_content_hash ON chunk_refs(content_hash);
