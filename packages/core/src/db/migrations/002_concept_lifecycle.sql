ALTER TABLE concepts ADD COLUMN lifecycle_status TEXT;
ALTER TABLE concepts ADD COLUMN archived_at TEXT;
ALTER TABLE concepts ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE concepts ADD COLUMN merged_into_concept_id TEXT;

UPDATE concepts
SET lifecycle_status = 'active'
WHERE lifecycle_status IS NULL;

ALTER TABLE commit_tree ADD COLUMN concept_name TEXT;

UPDATE commit_tree
SET concept_name = (
  SELECT cc.name
  FROM current_concepts cc
  WHERE cc.id = commit_tree.concept_id
)
WHERE concept_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_concepts_name_nocase ON concepts(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_concepts_lifecycle ON concepts(lifecycle_status);
