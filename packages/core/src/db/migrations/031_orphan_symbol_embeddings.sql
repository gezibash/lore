-- 031: remove symbol embeddings whose symbol is gone.
-- The code lane had the defect that migration 030 cleared for the text lane.
-- deleteSymbolsForSourceFile removed the symbol, its FTS row and its bindings,
-- and left the embedding. symbol_embeddings has no foreign key to symbols and
-- this database does not enable foreign_keys, so SQLite cascaded nothing. Every
-- scan gives a symbol a fresh id, so each changed file added dead vectors.
-- Retrieval stayed correct, because the readers reach an embedding through the
-- symbol or through its bindings, but auto-binding read every dead vector into
-- memory on each run. The code now deletes the vector with the symbol. This
-- clears what earlier versions left behind.

DELETE FROM symbol_embeddings
WHERE symbol_id NOT IN (SELECT id FROM symbols);
