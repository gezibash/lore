export { openDb, ensureCustomSqlite } from "./connection.ts";
export { runMigrations } from "./migrations.ts";
export {
  insertChunk,
  insertChunkBatch,
  getChunk,
  getActiveChunks,
  getChunksForConcept,
  getJournalChunksForNarrative,
  updateJournalChunkRouting,
  getJournalTopicsForNarrative,
  getChunkCount,
  assignChunkToConcept,
  getChunkConceptId,
  getLastNarrativeForConcept,
  getSourceChunkPathsForFile,
  deleteSourceChunksForFile,
  getDocChunkByPath,
  getDocChunkPaths,
  deleteDocChunksForFile,
  getSourceChunkCount,
  getDocChunkCount,
  getLastDocIndexedAt,
  getJournalEntryCount,
} from "./chunks.ts";
export type { InsertChunkOpts } from "./chunks.ts";
export {
  insertConcept,
  insertConceptRaw,
  insertConceptRawBatch,
  insertConceptVersion,
  insertConceptVersionBatch,
  getConcept,
  getConceptByName,
  getActiveConceptByName,
  getConceptsByNameCaseInsensitive,
  isConceptNameTaken,
  getConcepts,
  getActiveConcepts,
  getPreviousConceptMetrics,
  getConceptCount,
  getActiveConceptCount,
} from "./concepts.ts";
export { insertEdge, getEdges } from "./edges.ts";
export {
  insertEmbedding,
  insertEmbeddingBatch,
  getEmbeddingForChunk,
  vectorSearch,
  getAllEmbeddings,
  deleteAllEmbeddings,
  insertSymbolEmbedding,
  insertSymbolEmbeddingBatch,
  symbolVectorSearch,
  deleteAllSymbolEmbeddings,
} from "./embeddings.ts";
export { insertFtsContent, insertFtsContentBatch, bm25Search, deleteAllFts } from "./fts.ts";
export {
  queueCloseJob,
  getCloseJob,
  getLatestPendingCloseJobForNarrative,
  listCloseJobs,
  claimCloseJob,
  completeCloseJob,
  failCloseJob,
  getCloseJobCounts,
  hasPendingCloseJobs,
} from "./close-jobs.ts";
export type { CloseJobCounts } from "./close-jobs.ts";
export {
  insertNarrative,
  insertNarrativeRaw,
  getNarrative,
  getNarrativeByName,
  getNarrativeByNameWithStatuses,
  getOpenNarrativeByName,
  getWritableNarrativeByName,
  getOpenNarratives,
  getActiveNarratives,
  setNarrativeStatus,
  markNarrativeClosing,
  failNarrativeClose,
  reopenNarrative,
  closeNarrative,
  abandonNarrative,
  updateNarrativeMetrics,
  getDanglingNarratives,
  getAllNarratives,
  getMergeBaseCommitId,
} from "./narratives.ts";
export {
  insertCommit,
  insertCommitTree,
  getCommit,
  getHeadCommit,
  getCommitTree,
  getCommitTreeAsMap,
  walkHistory,
  diffCommitTrees,
  resolveRef,
  parseLifecycleMessage,
} from "./commits.ts";
export { insertSnapshot, getSnapshotsForNarrative } from "./snapshots.ts";
export { insertResidualHistory, getResidualHistory, getLatestDebt } from "./residuals.ts";
export { upsertLaplacianCache, getLaplacianCache } from "./laplacian.ts";
export { upsertManifest, getManifest, getPreviousManifest, markGraphStale } from "./manifest.ts";
export { rebuildFromDisk } from "./rebuild.ts";
export {
  upsertConceptRelation,
  deactivateConceptRelation,
  getConceptRelations,
  getActiveRelationNeighbors,
} from "./concept-relations.ts";
export {
  upsertConceptTag,
  removeConceptTag,
  getConceptTags,
  hasConceptTag,
} from "./concept-tags.ts";
export {
  insertConceptHealthSignal,
  getCurrentConceptHealthSignal,
  getCurrentConceptHealthSignals,
  getConceptHealthSignalsForRun,
  getLatestConceptHealthRun,
  getTopCurrentConceptHealthRows,
  getConceptHealthExplainRow,
} from "./concept-health-signals.ts";
export {
  queueConceptHealLeases,
  getConceptHealLease,
  listConceptHealLeasesForRun,
  claimConceptHealLease,
  completeConceptHealLease,
  skipConceptHealLease,
  failConceptHealLease,
  getConceptHealLeaseStatusCounts,
} from "./concept-heal-leases.ts";
export {
  queueCloseMaintenanceJob,
  getCloseMaintenanceJob,
  claimCloseMaintenanceJob,
  completeCloseMaintenanceJob,
  failCloseMaintenanceJob,
  getCloseMaintenanceJobCounts,
  hasPendingCloseMaintenanceJobs,
} from "./close-maintenance-jobs.ts";
export type { CloseMaintenanceJobCounts } from "./close-maintenance-jobs.ts";
export { auditSchema, repairSchema, describeSchemaIssue } from "./repair.ts";
export type { SchemaIssue, SchemaRepairOptions, SchemaRepairResult } from "./repair.ts";
export {
  insertSourceFile,
  upsertSourceFile,
  getSourceFileByPath,
  getSourceFile,
  getAllSourceFiles,
  deleteSourceFile,
  deleteSourceFileByPath,
  deleteSourceFilesNotIn,
  getSourceFileCount,
  getSourceFileLanguageCounts,
  getLastScannedAt,
} from "./source-files.ts";
export {
  insertSymbol,
  insertSymbolBatch,
  deleteSymbolsForSourceFile,
  getSymbolsForSourceFile,
  getSymbolsForFilePath,
  searchSymbols,
  getSymbolByQualifiedName,
  getSymbolCount,
  getSymbolKindCounts,
} from "./symbols.ts";
export {
  upsertConceptSymbol,
  getBindingsForConcept,
  getBindingsForSymbol,
  getDriftedBindings,
  deleteBindingsForConcept,
  pruneOrphanedBindings,
  getBindingCounts,
  getFilesForConcept,
  getSymbolLinesForConcept,
  getExportedFilePaths,
} from "./concept-symbols.ts";
export type { ConceptSymbolLineRange } from "./concept-symbols.ts";
export {
  insertQueryCache,
  getQueryCache,
  scoreQueryCache,
  getTopScoredQueries,
  pruneExpiredQueryCache,
} from "./query-cache.ts";
export type { QueryCacheRow } from "./query-cache.ts";
export {
  insertInteractionEvent,
  listInteractionEventsSince,
  computeNorthStarScorecard,
  getLatestScoreEvent,
} from "./interaction-events.ts";
export type { InteractionEventRow, InteractionEventType } from "./interaction-events.ts";
export {
  insertCallSiteBatch,
  deleteCallSitesForSourceFile,
  getCallSitesForCallee,
  getCallSitesByCaller,
  getCallSitesInFile,
  getCallSiteCount,
} from "./call-sites.ts";
export type { InsertCallSiteOpts } from "./call-sites.ts";
