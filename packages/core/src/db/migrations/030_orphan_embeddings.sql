-- 030: remove embeddings whose chunk is gone.
-- deleteSourceChunksForFile and deleteDocChunksForFile removed the chunk and its
-- FTS row and left the embedding. embeddings has no foreign key to chunks and
-- this database does not enable foreign_keys, so SQLite cascaded nothing. Every
-- ingest that changed or removed an indexed file therefore added dead vectors.
-- Retrieval stayed correct, because every vector search joins chunks, but the
-- file grew without bound and lore status counted the orphans as embeddings.
-- The code now deletes the vector with the chunk. This clears what earlier
-- versions left behind.

DELETE FROM embeddings
WHERE chunk_id NOT IN (SELECT id FROM chunks);
