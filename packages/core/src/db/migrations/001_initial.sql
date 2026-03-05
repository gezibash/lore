CREATE TABLE manifest (
  version_id            TEXT PRIMARY KEY,
  concept_graph_version TEXT,
  fiedler_value         REAL,
  debt                  REAL,
  debt_trend            TEXT,
  chunk_count           INTEGER,
  concept_count         INTEGER,
  last_integrated       TEXT,
  last_embedded         TEXT,
  inserted_at           TEXT NOT NULL
);

CREATE TABLE concepts (
  version_id      TEXT PRIMARY KEY,
  id              TEXT NOT NULL,
  name            TEXT NOT NULL,
  active_chunk_id TEXT,
  residual        REAL,
  staleness       REAL,
  cluster         INTEGER,
  is_hub          INTEGER,
  inserted_at     TEXT NOT NULL
);

CREATE TABLE deltas (
  version_id            TEXT PRIMARY KEY,
  id                    TEXT NOT NULL,
  name                  TEXT NOT NULL,
  intent                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  theta                 REAL,
  magnitude             REAL,
  convergence           REAL,
  entry_count           INTEGER DEFAULT 0,
  merge_base_commit_id  TEXT,
  opened_at             TEXT NOT NULL,
  closed_at             TEXT,
  inserted_at           TEXT NOT NULL
);

CREATE TABLE chunks (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  fl_type       TEXT NOT NULL,
  concept_id    TEXT,
  delta_id      TEXT,
  supersedes_id TEXT,
  status        TEXT,
  topics        TEXT,
  convergence   REAL,
  theta         REAL,
  magnitude     REAL,
  created_at    TEXT NOT NULL
);

CREATE TABLE chunk_concept_map (
  version_id  TEXT PRIMARY KEY,
  chunk_id    TEXT NOT NULL,
  concept_id  TEXT NOT NULL,
  inserted_at TEXT NOT NULL
);

CREATE TABLE concept_edges (
  id              TEXT PRIMARY KEY,
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  alpha           REAL NOT NULL,
  graph_version   TEXT NOT NULL
);

CREATE TABLE embeddings (
  id              TEXT PRIMARY KEY,
  chunk_id        TEXT NOT NULL,
  embedding       BLOB NOT NULL,
  model           TEXT NOT NULL,
  embedded_at     TEXT NOT NULL
);

CREATE TABLE concept_snapshots (
  id              TEXT PRIMARY KEY,
  concept_id      TEXT NOT NULL,
  delta_id        TEXT NOT NULL,
  embedding_id    TEXT NOT NULL,
  captured_at     TEXT NOT NULL
);

CREATE TABLE residual_history (
  id              TEXT PRIMARY KEY,
  concept_id      TEXT NOT NULL,
  residual        REAL NOT NULL,
  debt_total      REAL NOT NULL,
  recorded_at     TEXT NOT NULL
);

CREATE TABLE laplacian_cache (
  version_id      TEXT PRIMARY KEY,
  graph_version   TEXT NOT NULL,
  fiedler_value   REAL NOT NULL,
  eigenvalues     BLOB NOT NULL,
  eigenvectors    BLOB NOT NULL,
  computed_at     TEXT NOT NULL
);

CREATE TABLE commits (
  id              TEXT PRIMARY KEY,
  delta_id        TEXT,
  parent_id       TEXT,
  merge_base_id   TEXT,
  message         TEXT NOT NULL,
  committed_at    TEXT NOT NULL
);

CREATE TABLE commit_tree (
  commit_id   TEXT NOT NULL,
  concept_id  TEXT NOT NULL,
  chunk_id    TEXT NOT NULL,
  PRIMARY KEY (commit_id, concept_id)
);

CREATE TABLE chunk_refs (
  id          TEXT PRIMARY KEY,
  chunk_id    TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  blob_hash   TEXT NOT NULL,
  line_start  INTEGER,
  line_end    INTEGER,
  created_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE content_fts USING fts5(
  content,
  chunk_id UNINDEXED
);

CREATE VIEW current_manifest AS
  SELECT m.* FROM manifest m
  INNER JOIN (SELECT MAX(rowid) AS rid FROM manifest) latest
  ON m.rowid = latest.rid;

CREATE VIEW current_concepts AS
  SELECT c.* FROM concepts c
  INNER JOIN (SELECT id, MAX(rowid) AS rid FROM concepts GROUP BY id) latest
  ON c.id = latest.id AND c.rowid = latest.rid;

CREATE VIEW current_deltas AS
  SELECT d.* FROM deltas d
  INNER JOIN (SELECT id, MAX(rowid) AS rid FROM deltas GROUP BY id) latest
  ON d.id = latest.id AND d.rowid = latest.rid;

CREATE VIEW current_chunk_concepts AS
  SELECT m.* FROM chunk_concept_map m
  INNER JOIN (SELECT chunk_id, MAX(rowid) AS rid FROM chunk_concept_map GROUP BY chunk_id) latest
  ON m.chunk_id = latest.chunk_id AND m.rowid = latest.rid;

CREATE INDEX idx_manifest_version ON manifest(version_id);
CREATE INDEX idx_concepts_identity ON concepts(id, version_id);
CREATE INDEX idx_deltas_identity ON deltas(id, version_id);
CREATE INDEX idx_ccmap_chunk ON chunk_concept_map(chunk_id, version_id);
CREATE INDEX idx_chunks_concept ON chunks(concept_id, created_at);
CREATE INDEX idx_chunks_delta ON chunks(delta_id, created_at);
CREATE INDEX idx_edges_version ON concept_edges(graph_version);
CREATE INDEX idx_embeddings_chunk ON embeddings(chunk_id);
CREATE INDEX idx_laplacian_version ON laplacian_cache(version_id);
CREATE INDEX idx_commits_id ON commits(id);
CREATE INDEX idx_commits_parent ON commits(parent_id);
CREATE INDEX idx_commit_tree_commit ON commit_tree(commit_id);
CREATE INDEX idx_chunk_refs_chunk ON chunk_refs(chunk_id);
CREATE INDEX idx_chunk_refs_blob ON chunk_refs(blob_hash);
