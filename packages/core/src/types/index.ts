import type { ULID } from "ulid";

// ─── Identifiers ──────────────────────────────────────────
export type LoreId = ULID;

// ─── Chunk Types ──────────────────────────────────────────
export type ChunkType = "chunk" | "journal" | "source" | "doc";

export type JournalStatus = "finding" | "dead-end" | "confirmed" | "question";

export type NarrativeStatus = "open" | "closed" | "abandoned";

export type DebtTrend = "improving" | "stable" | "degrading";

export type HealthStatus = "good" | "degrading" | "critical";

export type ConceptLifecycleStatus = "active" | "archived" | "merged";

export type RelationType = "depends_on" | "constrains" | "implements" | "uses" | "related_to";

export type EmbeddingProvider =
  | "ollama"
  | "openai"
  | "openai-compatible"
  | "gateway"
  | "openrouter"
  | "voyage";

export type GenerationProvider =
  | "ollama"
  | "openai"
  | "groq"
  | "openai-compatible"
  | "gateway"
  | "openrouter"
  | "moonshotai"
  | "alibaba";

export type SharedProvider = EmbeddingProvider | GenerationProvider | "cohere";

export interface ProviderCredential {
  api_key?: string;
  base_url?: string;
}

export type ReasoningLevel = "none" | "low" | "default" | "high";

export type GenerationReasoningScope =
  | "name_cluster"
  | "segment_topics"
  | "propose_split"
  | "three_way_merge"
  | "generate_integration"
  | "executive_summary";

// ─── Frontmatter ──────────────────────────────────────────
export interface StateChunkFrontmatter {
  fl_id: string;
  fl_type: "chunk";
  fl_concept: string;
  fl_concept_id: string;
  fl_supersedes: string | null;
  fl_superseded_by: string | null;
  fl_narrative_origin: string;
  fl_version: number;
  fl_created_at: string;
  fl_residual: number | null;
  fl_staleness: number | null;
  fl_cluster: number | null;
  fl_embedding_model: string;
  fl_embedded_at: string | null;
  fl_lifecycle_status?: ConceptLifecycleStatus;
  fl_archived_at?: string | null;
  fl_lifecycle_reason?: string | null;
  fl_merged_into_concept_id?: string | null;
}

export interface JournalChunkFrontmatter {
  fl_id: string;
  fl_type: "journal";
  fl_narrative: string;
  fl_prev: string | null;
  fl_status: JournalStatus | null;
  fl_topics: string[];
  fl_convergence: number | null;
  fl_theta: number | null;
  fl_magnitude: number | null;
  fl_created_at: string;
  fl_embedding_model: string;
  fl_intent?: string;
  fl_concept_refs?: string[];
  fl_symbol_refs?: string[];
  fl_refs?: FileRef[];
}

export interface SourceChunkFrontmatter {
  fl_id: string;
  fl_type: "source";
  fl_source_file: string;
  fl_line_start: number;
  fl_line_end: number;
  fl_symbol: string;
  fl_kind: string;
  fl_language: string;
  fl_body_hash: string | null;
  fl_created_at: string;
}

export interface DocChunkFrontmatter {
  fl_id: string;
  fl_type: "doc";
  fl_doc_path: string; // relative path from codePath root
  fl_body_hash: string; // SHA256 of file content (for drift)
  fl_created_at: string;
}

export type ChunkFrontmatter =
  | StateChunkFrontmatter
  | JournalChunkFrontmatter
  | SourceChunkFrontmatter
  | DocChunkFrontmatter;

export interface ParsedChunk<T extends ChunkFrontmatter = ChunkFrontmatter> {
  frontmatter: T;
  content: string;
  filePath: string;
}

// ─── Registry ─────────────────────────────────────────────
export interface RegistryEntry {
  code_path: string;
  lore_path: string;
  registered_at: string;
}

export interface Registry {
  lore_minds: Record<string, RegistryEntry>;
  providers?: Partial<Record<SharedProvider, ProviderCredential>>;
}

// ─── Database Row Types ───────────────────────────────────
export interface ManifestRow {
  version_id: string;
  concept_graph_version: string;
  fiedler_value: number;
  debt: number;
  debt_trend: DebtTrend;
  chunk_count: number;
  concept_count: number;
  last_integrated: string | null;
  last_embedded: string | null;
  graph_stale: number;
  inserted_at: string;
}

export interface ConceptRow {
  version_id: string;
  id: string;
  name: string;
  active_chunk_id: string | null;
  residual: number | null; // deprecated: max(ground_residual, lore_residual) — kept for backward compat
  churn: number | null; // version-to-version cosine distance (informational only)
  ground_residual: number | null; // concept embedding vs mean(ref line_content embeddings)
  lore_residual: number | null; // 1 − mean similarity to cluster peers
  staleness: number | null;
  cluster: number | null;
  is_hub: number | null;
  lifecycle_status: ConceptLifecycleStatus | null;
  archived_at: string | null;
  lifecycle_reason: string | null;
  merged_into_concept_id: string | null;
  inserted_at: string;
}

export interface ChunkRow {
  id: string;
  file_path: string;
  fl_type: ChunkType;
  concept_id: string | null;
  narrative_id: string | null;
  supersedes_id: string | null;
  status: JournalStatus | null;
  topics: string | null;
  convergence: number | null;
  theta: number | null;
  magnitude: number | null;
  created_at: string;
  concept_refs: string | null;
  symbol_refs: string | null;
  file_refs: string | null;
}

export interface ConceptEdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  alpha: number;
  graph_version: string;
}

export interface ConceptRelationRow {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  relation_type: RelationType;
  weight: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ConceptTagRow {
  id: string;
  concept_id: string;
  tag: string;
  created_at: string;
}

export interface ConceptHealthSignalRow {
  id: string;
  run_id: string;
  concept_id: string;
  time_stale: number;
  ref_stale: number;
  local_graph_stale: number;
  global_shock: number;
  influence: number;
  critical_multiplier: number;
  final_stale: number;
  residual_after_adjust: number;
  debt_after_adjust: number;
  created_at: string;
}

export interface ConceptHealLeaseRow {
  lore_path: string;
  run_id: string;
  concept_id: string;
  status: "queued" | "leased" | "done" | "failed" | "skipped";
  owner: string | null;
  attempt: number;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkConceptMapRow {
  version_id: string;
  chunk_id: string;
  concept_id: string;
  inserted_at: string;
}

export interface EmbeddingRow {
  id: string;
  chunk_id: string;
  embedding: Uint8Array;
  model: string;
  embedded_at: string;
}

// ─── Narrative Targets ────────────────────────────────────────
export type NarrativeTarget =
  | { op: "create"; concept: string }
  | { op: "update"; concept: string }
  | { op: "archive"; concept: string; reason?: string }
  | { op: "restore"; concept: string }
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; source: string; into: string; reason?: string }
  | { op: "split"; concept: string; parts?: number };

export interface NarrativeRow {
  version_id: string;
  id: string;
  name: string;
  intent: string;
  status: NarrativeStatus;
  theta: number | null;
  magnitude: number | null;
  convergence: number | null;
  entry_count: number;
  merge_base_commit_id: string | null;
  targets: string | null;
  opened_at: string;
  closed_at: string | null;
  inserted_at: string;
}

// ─── Commit Types ─────────────────────────────────────────
export interface CommitRow {
  id: string;
  narrative_id: string | null;
  parent_id: string | null;
  merge_base_id: string | null;
  message: string;
  committed_at: string;
}

export interface CommitTreeRow {
  commit_id: string;
  concept_id: string;
  chunk_id: string;
  concept_name: string | null;
}

export interface MergeConflict {
  conceptId: string;
  conceptName: string;
  baseContent: string | null;
  headContent: string;
  narrativeContent: string;
  resolution: "auto-merged" | "flagged";
  resolvedContent: string;
}

export interface TreeDiff {
  added: Array<{
    conceptName: string;
    chunkId: string;
    contentPreview?: string;
    newContent?: string;
  }>;
  removed: Array<{ conceptName: string; chunkId: string }>;
  modified: Array<{
    conceptName: string;
    fromChunkId: string;
    toChunkId: string;
    contentPreview?: string;
    lengthDelta?: number;
    oldContent?: string;
    newContent?: string;
  }>;
  narrative?: {
    name: string;
    intent: string;
    entryCount: number;
  };
  lifecycleEvents?: Array<{
    type: "archive" | "restore" | "rename" | "merge" | "split" | "patch";
    description: string;
    committedAt: string;
  }>;
}

export type LifecycleEventType = "archive" | "restore" | "rename" | "merge" | "split" | "patch";

export interface CommitLogEntry {
  id: string;
  message: string;
  committedAt: string;
  parentId: string | null;
  narrative?: {
    name: string;
    intent: string;
    entryCount: number;
  };
  diff?: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  lifecycleType?: LifecycleEventType;
}

export interface ConceptSnapshotRow {
  id: string;
  concept_id: string;
  narrative_id: string;
  embedding_id: string;
  captured_at: string;
}

export interface ResidualHistoryRow {
  id: string;
  concept_id: string;
  residual: number;
  debt_total: number;
  recorded_at: string;
}

export interface LaplacianCacheRow {
  version_id: string;
  graph_version: string;
  fiedler_value: number;
  eigenvalues: Uint8Array;
  eigenvectors: Uint8Array;
  computed_at: string;
}

// ─── Engine Result Types ──────────────────────────────────
export interface SearchResult {
  chunkId: string;
  concept?: string;
  content: string;
  score: number;
  warning?: string;
}

export interface OpenResult {
  context: {
    read_now: Array<{
      file: string;
      summary: string;
      priority: "high" | "medium" | "low";
      warning?: string;
    }>;
    heads_up: string[];
  };
}

export interface LogResult {
  saved: boolean;
  note?: string;
}

export interface QueryOptions {
  codePath?: string;
  search?: boolean;
  brief?: boolean;
  onProgress?: (message: string) => void;
  /** "code" injects bound symbol bodies alongside concept prose. "arch" (default) returns prose only. */
  mode?: "arch" | "code";
}

export interface OrchestrationQueryOptions extends QueryOptions {
  disable_per_lore_mind_summary?: boolean;
  disable_web?: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "exa" | "context7";
}

export interface QueryRunMeta {
  query: string;
  generated_at: string;
  generated_in: string;
  brief: boolean;
  scanned: {
    local_candidates: number;
    returned_results: number;
    return_limit: number;
    vector_limit: number;
    text_vector_candidates: number;
    code_vector_candidates: number;
    bm25_source_candidates: number;
    bm25_chunk_candidates: number;
    doc_vector_candidates: number;
    bm25_doc_candidates: number;
    fused_candidates: number;
    staleness_checks: number;
    web_search_enabled: boolean;
    web_results: number;
    journal_candidates: number;
    journal_results: number;
  };
  rerank: {
    enabled: boolean;
    attempted: boolean;
    applied: boolean;
    model: string;
    candidates: number;
    reason: string;
    top_score?: number | null;
    min_score?: number | null;
  };
  executive_summary: {
    enabled: boolean;
    attempted: boolean;
    generated: boolean;
    model: string;
    model_id: string;
    reason: string;
    source_matches: number;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  grounding: {
    enabled: boolean;
    attempted: boolean;
    exactness_detected: boolean;
    hits_total: number;
    call_site_hits: number;
    files_considered: number;
    mode: "always-on";
    reason: string;
  };
  structural_boost: {
    enabled: boolean;
    symbols_matched: number;
    concepts_boosted: number;
    boost_map: Record<string, { boost: number; symbols: string[] }>;
  };
  ppr_expansion?: {
    fusion_alpha: number;
    deep_research_query: boolean;
    seeds: number;
    adjacency_nodes: number;
    expansion_candidates: number;
    injected: number;
    in_summary_input: number;
  };
  ask_debt?: {
    score: number;
    confidence: number;
    band: "healthy" | "caution" | "high" | "critical";
    retrieval_multiplier: number;
    staleness_penalty_multiplier: number;
  };
}

export interface QueryResultMeta {
  chunk_id: string;
  files: string[];
  score: number;
  residual: number | null;
  staleness: number | null;
  symbol_drift: "none" | "drifted";
  symbols_bound: number;
  symbols_drifted: number;
  last_updated: string;
  cluster?: number | null;
  cluster_peers?: string[];
  relations?: Array<{
    concept: string;
    direction: "outbound" | "inbound";
    type: RelationType;
    weight: number;
  }>;
  cluster_summary?: string;
  neighbors_2hop?: Array<{
    concept: string;
    path: string;
    weight?: number;
  }>;
  bindings?: Array<{
    symbol: string;
    kind: SymbolKind;
    file: string;
    line: number;
    type: BindingType;
    confidence: number;
  }>;
  last_narrative?: {
    name: string;
    intent: string;
    closed_at: string;
  };
}

export type RecallSection = "sources" | "journal" | "symbols" | "full";

export type QueryNextActionKind = "show" | "recall" | "trail" | "ingest";

export interface QueryNextAction {
  kind: QueryNextActionKind;
  primary: boolean;
  reason: string;
  concept?: string;
  narrative?: string;
  section?: RecallSection;
}

export interface JournalTrailEntry {
  content: string;
  topics: string[];
  status: JournalStatus | null;
  created_at: string;
  score: number;
  entry_index: number; // 1-based position in the full narrative trail
}

export interface JournalTrailGroup {
  narrative_name: string;
  narrative_intent: string;
  narrative_status: NarrativeStatus;
  total_entries: number;
  matched_entries: JournalTrailEntry[];
  other_topics: string[];
  opened_at: string;
  closed_at: string | null;
}

export interface NarrativeTrailEntry {
  content: string;
  topics: string[];
  status: JournalStatus | null;
  created_at: string;
  position: number; // 1-based position in trail
}

export interface NarrativeTrailResult {
  narrative: {
    name: string;
    intent: string;
    status: NarrativeStatus;
    entry_count: number;
    opened_at: string;
    closed_at: string | null;
  };
  entries: NarrativeTrailEntry[];
  topics_covered: string[];
}

export interface ExecutiveSummary {
  narrative: string;
  kind: "generated" | "fallback" | "uncertain";
  uncertainty_reason?: string;
  sources: Array<{
    concept: string;
    score: number;
    files: string[];
    staleness: number | null;
    last_updated: string;
  }>;
  citations: Array<{
    file: string;
    line: number;
    snippet: string;
    term: string;
  }>;
  counts: {
    concepts: number;
    files: number;
    symbols: number;
    journal_entries: number;
  };
  claims?: Array<{
    text: string;
    source_concepts: string[];
    confidence: number;
    max_staleness?: number;
  }>;
  /** Symbols whose source bodies were used as authoritative grounding but have no concept binding.
   *  Agent should bind these to improve future retrieval quality. */
  unbound_source_symbols?: string[];
}

export interface QueryResult {
  result_id?: string;
  meta: QueryRunMeta;
  executive_summary?: ExecutiveSummary;
  next_actions?: QueryNextAction[];
  results: Array<{
    concept: string;
    content: string;
    summary: string;
    warning?: string;
    excerpts?: string[];
    meta: QueryResultMeta;
  }>;
  web_results?: WebSearchResult[];
  symbol_results?: SymbolSearchResult[];
  journal_results?: JournalTrailGroup[];
}

export interface RecallResult {
  result_id: string;
  query_text: string;
  result: QueryResult;
  score: number | null;
  scored_by: string | null;
  created_at: string;
}

export type CloseMode = "merge" | "discard";

export type MergeStrategy = "replace" | "extend" | "patch" | "correct";

/** Semantic distance between incoming narrative content and existing concept. */
export interface PhaseTransitionWarning {
  concept_name: string;
  /** Cosine distance ∈ [0,1] between narrative centroid and existing concept embedding. */
  distance: number;
  /** moderate: 0.45-0.60 (normal evolution), strong: 0.60-0.75 (possible restructure), structural: >0.75 (likely contradiction) */
  magnitude: "moderate" | "strong" | "structural";
  narrative_entry_count: number;
}

export interface CloseResult {
  mode: CloseMode;
  integrated: boolean;
  commit_id: string | null;
  concepts_updated: string[];
  concepts_created: string[];
  conflicts: MergeConflict[];
  impact: {
    summary: string;
    debt_before: number;
    debt_after: number;
    concept_impacts?: Array<{
      concept: string;
      residual_before: number | null;
      residual_after: number | null;
      content_diff?: { adds: number; removes: number };
    }>;
  };
  follow_up?: string;
  coverage_change?: {
    before: { exported_covered: number; exported_total: number; ratio: number };
    after: { exported_covered: number; exported_total: number; ratio: number };
  };
  concept_overlaps?: Array<{ concept: string; overlaps_with: string; similarity: number }>;
  /** Semantic distance warnings: detected when incoming narrative entries differ strongly from existing concept. */
  phase_transitions?: PhaseTransitionWarning[];
}

export interface NorthStarRateMetric {
  value: number | null;
  numerator: number;
  denominator: number;
  target?: number;
}

export interface NorthStarTimeMetric {
  median_seconds: number | null;
  sample_size: number;
  target_seconds?: number;
  proxy: string;
}

export interface NorthStarTrustMetric {
  average_score: number | null;
  sample_size: number;
  target?: number;
}

export interface NorthStarScorecard {
  window_days: number;
  asks_observed: number;
  scored_answers: number;
  narratives_opened: number;
  narratives_closed: number;
  first_answer_actionability: NorthStarRateMetric;
  time_to_first_guided_action: NorthStarTimeMetric;
  investigation_reuse: NorthStarRateMetric;
  next_action_clarity: NorthStarRateMetric;
  stale_answer_follow_through: NorthStarRateMetric;
  provenance_trust: NorthStarTrustMetric;
  maintenance_loop_completion: NorthStarRateMetric;
  note?: string;
}

export interface StatusResult {
  lore_name: string;
  health: HealthStatus;
  summary: string;
  /** User-facing ask-quality debt score (0-100, lower is better). */
  debt?: number;
  /** User-facing ask-quality confidence score (0-100, higher is better). */
  confidence?: number;
  debt_band?: "healthy" | "caution" | "high" | "critical";
  /** Internal residual/graph debt for advanced diagnostics. */
  raw_debt?: number;
  raw_debt_breakdown?: {
    persisted: number;
    live: number;
    display: number;
  };
  /** @deprecated Use raw_debt_breakdown. Kept for backward compatibility. */
  debt_breakdown?: {
    persisted: number;
    live: number;
    display: number;
  };
  debt_components?: {
    staleness: number;
    symbol_drift: number;
    code_freshness: number;
    doc_freshness: number;
    coverage_gap: number;
    embedding_mismatch: number;
    active_narrative_hygiene: number;
    priority_pressure: number;
    ask_debt_base: number;
    write_activity_72h: {
      journal_entries: number;
      closed_narratives: number;
    };
    narrative_hygiene_72h: {
      open_narratives: number;
      empty_open_narratives: number;
      dangling_narratives: number;
    };
  };
  debt_previous?: number | null;
  debt_delta?: number | null;
  priorities: Array<{
    concept: string;
    action: string;
    reason: string;
    last_narrative?: { name: string; intent: string; closed_at: string };
    changed_at?: string;
  }>;
  active_narratives: Array<{
    name: string;
    entry_count: number;
    theta: number | null;
    note: string;
  }>;
  dangling_narratives: Array<{
    name: string;
    age_days: number;
    action: string;
  }>;
  maintenance: {
    status: string;
    min_delta_rate: number;
    current_rate: number;
  };
  embedding_status?: {
    total: number;
    current_model: number;
    stale: number;
    model: string;
  };
  suggestions: Array<{
    action: string;
    concepts: string[];
    reason: string;
  }>;
  concept_health?: {
    run_id: string;
    computed_at: string;
    top_stale: Array<{
      concept: string;
      final_stale: number;
      time_stale: number;
      ref_stale: number;
      local_graph_stale: number;
      global_shock: number;
      influence: number;
      critical: boolean;
    }>;
  };
  coverage?: {
    exported_covered: number;
    exported_total: number;
    ratio: number;
    total_bindings: number;
    by_type: { ref: number; mention: number };
    avg_confidence: number;
    drifted: number;
    concepts_with_bindings: number;
    concepts_total: number;
  };
  lake?: {
    source_chunks: number;
    source_files: number;
    doc_chunks: number;
    journal_entries: number;
    last_code_indexed_at: string | null;
    last_doc_indexed_at: string | null;
    stale_source_files: number;
    stale_doc_files: number;
  };
  /** Formal epistemological gap S_dist(lore, codebase) ∈ [0,1]. Distinct from debt. */
  state_distance?: number;
}

// ─── Suggest Types ────────────────────────────────────────
export type SuggestionKind =
  | "merge"
  | "relate"
  | "close-narrative"
  | "abandon-narrative"
  | "clean-relation"
  | "symbol-drift"
  | "coverage-gap"
  | "knowledge-pull"
  | "review"
  | "cluster-drift"
  | "archive";

export interface SuggestionStep {
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

export interface SuggestionImpact {
  /** @deprecated Use expected_debt_reduction_points. */
  expected_debt_reduction: number;
  expected_debt_reduction_points: number;
  expected_raw_debt_reduction?: number;
  percentage_of_total: number;
  rationale: string;
}

export interface Suggestion {
  kind: SuggestionKind;
  priority: number;
  confidence: number;
  title: string;
  rationale: string;
  steps: SuggestionStep[];
  concepts: string[];
  evidence: Record<string, unknown>;
  impact?: SuggestionImpact;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  meta: {
    computed_at: string;
    concept_count: number;
    /** User-facing ask-quality debt score (0-100). */
    total_debt: number | null;
    /** Internal residual/graph debt used for diagnostics. */
    total_raw_debt?: number | null;
    fiedler_value: number | null;
    pairwise_computed: boolean;
    projected_debt_after: number | null;
    projected_raw_debt_after?: number | null;
    top_debt_reducers?: Array<{
      kind: SuggestionKind;
      title: string;
      expected_debt_reduction: number;
      expected_debt_reduction_points?: number;
      expected_raw_debt_reduction?: number;
      percentage_of_total: number;
    }>;
    projected_debt_after_top_reducers?: number | null;
  };
}

export interface ConceptHealthTopRow {
  concept: string;
  final_stale: number;
  time_stale: number;
  ref_stale: number;
  local_graph_stale: number;
  global_shock: number;
  influence: number;
  critical: boolean;
}

export interface ConceptHealthComputeResult {
  run_id: string;
  computed_at: string;
  concepts_scanned: number;
  debt: number;
  debt_trend: string;
  top_stale: ConceptHealthTopRow[];
}

export interface ConceptHealthNeighbor {
  concept: string;
  relation_type: RelationType;
  direction: "inbound" | "outbound";
  weight: number;
  neighbor_final_stale: number | null;
}

export interface ConceptHealthExplainResult {
  concept: string;
  run_id: string;
  computed_at: string;
  signal: {
    final_stale: number;
    time_stale: number;
    ref_stale: number;
    local_graph_stale: number;
    global_shock: number;
    influence: number;
    critical: boolean;
    critical_multiplier: number;
    residual_after_adjust: number;
    debt_after_adjust: number;
  };
  neighbors: ConceptHealthNeighbor[];
}

export interface ConceptRelationSummary {
  from_concept: string;
  to_concept: string;
  relation_type: RelationType;
  weight: number;
  active: boolean;
  updated_at: string;
}

export interface ConceptTagSummary {
  concept: string;
  tag: string;
  created_at: string;
}

export interface HealConceptsResult {
  run_id: string;
  dry: boolean;
  considered: number;
  healed: Array<{
    concept: string;
    from_staleness: number;
    to_staleness: number;
    from_residual: number;
    to_residual: number;
  }>;
  partial?: boolean;
  halt_reason?: string;
  worker_stats?: {
    configured: number;
    completed: number;
    failed: number;
    retried: number;
  };
  batch_stats?: {
    processed: number;
    halted_at_batch?: number | null;
    pre_debt: number;
    post_debt: number;
  };
}

export interface RegisterResult {
  lore_path: string;
  ready: boolean;
  scan?: ScanResult;
}

// ─── Source Scanner Types ─────────────────────────────────
export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "rust" | "elixir";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl";

export interface SourceFileRow {
  id: string;
  file_path: string;
  language: SupportedLanguage;
  content_hash: string;
  size_bytes: number;
  symbol_count: number;
  scanned_at: string;
}

export interface SymbolRow {
  id: string;
  source_file_id: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  parent_id: string | null;
  line_start: number;
  line_end: number;
  signature: string | null;
  body_hash: string | null;
  export_status: "exported" | "default_export" | "local" | null;
  scanned_at: string;
}

export interface SymbolSearchResult {
  symbol_id: string;
  file_path: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  signature: string | null;
  line_start: number;
  line_end: number;
  bound_concepts?: string[];
  /** Call graph: callers (upstream) and callees (downstream) */
  call_graph?: {
    callers: Array<{ name: string; file: string; line: number; snippet: string | null }>;
    callees: Array<{ name: string; file: string; line: number; snippet: string | null }>;
  };
}

export interface SymbolConceptMatch {
  concept_id: string;
  concept_name: string;
  symbol_id: string;
  binding_type: BindingType;
  confidence: number;
}

export interface ScanResult {
  files_scanned: number;
  files_skipped: number;
  files_removed: number;
  files_failed?: number;
  symbols_found: number;
  call_sites_found?: number;
  source_chunks_found?: number;
  languages: Record<string, number>;
  duration_ms: number;
}

export interface IngestResult {
  files_ingested: number;
  files_skipped: number; // unchanged hash
  files_removed: number; // deleted from disk
  files_failed?: number;
  duration_ms: number;
}

export interface ScanStats {
  file_count: number;
  symbol_count: number;
  languages: Record<string, number>;
  last_scanned_at: string | null;
}

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  language: SupportedLanguage;
}

export interface ExtractedSymbol {
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  parent_name: string | null;
  line_start: number;
  line_end: number;
  signature: string | null;
  body_hash: string | null;
  export_status: "exported" | "default_export" | "local" | null;
}

export interface ExtractedCallSite {
  callee_name: string;
  caller_context: string;
  line: number;
  snippet: string;
}

export interface CallSiteRow {
  id: string;
  source_file_id: string;
  callee_name: string;
  caller_name: string | null;
  line: number;
  snippet: string | null;
  scanned_at: string;
}

// ─── Concept-Symbol Binding Types ─────────────────────────
export type BindingType = "ref" | "mention";

export interface ConceptSymbolRow {
  id: string;
  concept_id: string;
  symbol_id: string;
  binding_type: BindingType;
  bound_body_hash: string | null;
  /** Full body text of the symbol at binding time. NULL for rows predating migration 022. */
  bound_body: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface ConceptBindingSummary {
  symbol_name: string;
  symbol_qualified_name: string;
  symbol_kind: SymbolKind;
  file_path: string;
  line_start: number;
  binding_type: BindingType;
  confidence: number;
}

export interface SymbolDriftResult {
  concept_id: string;
  concept_name: string;
  symbol_id: string;
  symbol_name: string;
  symbol_qualified_name: string;
  symbol_kind: SymbolKind;
  file_path: string;
  line_start: number;
  line_end: number;
  bound_body_hash: string;
  current_body_hash: string;
  binding_type: BindingType;
  signature: string | null;
  /** Body text at binding time (NULL for pre-022 rows). */
  bound_body: string | null;
}

// ─── Coverage Types ──────────────────────────────────────
export interface UncoveredSymbol {
  symbol_id: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  file_path: string;
  language: SupportedLanguage;
  line_start: number;
  export_status: "exported" | "default_export" | "local" | null;
}

export interface FileCoverageRow {
  file_path: string;
  language: SupportedLanguage;
  symbol_count: number;
  bound_count: number;
  coverage_ratio: number;
}

export interface CoverageStats {
  total_symbols: number;
  total_exported: number;
  bound_symbols: number;
  bound_exported: number;
}

export interface CoverageReport {
  stats: CoverageStats;
  coverage_ratio: number;
  files: FileCoverageRow[];
  uncovered: UncoveredSymbol[];
}

// ─── Bootstrap Types ─────────────────────────────────────
export interface BootstrapPhase {
  name: string;
  directory: string;
  files: Array<{
    file_path: string;
    uncovered_count: number;
    total_exported: number;
    symbols: Array<{ name: string; kind: SymbolKind }>;
  }>;
  total_symbols: number;
  rationale: string;
}

export interface BootstrapPlan {
  phases: BootstrapPhase[];
  progress: {
    total_exported: number;
    covered_exported: number;
    coverage_ratio: number;
    phases_complete: number;
    phases_total: number;
  };
  computed_at: string;
}

// ─── Lore Health Snapshot ─────────────────────────────────
export interface LoreHealthSnapshot {
  health: HealthStatus;
  debt: number;
  debt_trend: DebtTrend;
  concept_count: number;
}

// ─── Errors ───────────────────────────────────────────────
export type LoreErrorCode =
  | "AI_UNAVAILABLE"
  | "CONFIG_INVALID"
  | "NARRATIVE_ALREADY_OPEN"
  | "NO_ACTIVE_NARRATIVE"
  | "DANGLING_NARRATIVE"
  | "LOW_INTEGRATION_CONFIDENCE"
  | "CONCEPT_GRAPH_DRIFT"
  | "DB_CORRUPT"
  | "BELOW_MAINTENANCE_FLOOR"
  | "LORE_NOT_FOUND"
  | "LORE_NOT_REGISTERED"
  | "MERGE_CONFLICT"
  | "COMMIT_NOT_FOUND"
  | "LOG_TOO_LONG"
  | "CONCEPT_NOT_FOUND"
  | "CONCEPT_NAME_CONFLICT"
  | "CONCEPT_INVALID_STATE"
  | "QUERY_CACHE_NOT_FOUND"
  // ask() pipeline stage failures
  | "ASK_EMBEDDING_FAILED"
  | "ASK_SEARCH_FAILED"
  | "ASK_RERANK_FAILED"
  | "ASK_EXEC_SUMMARY_FAILED"
  | "CODE_MODEL_NOT_CONFIGURED";

export class LoreError extends Error {
  constructor(
    public readonly code: LoreErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LoreError";
  }
}

// ─── Config ───────────────────────────────────────────────
export interface LoreConfig {
  lore_root: string;
  ai: {
    embedding: {
      provider: EmbeddingProvider;
      model: string;
      base_url?: string;
      api_key?: string;
      dim: number;
      code?: {
        provider?: EmbeddingProvider;
        model: string;
        base_url?: string;
        api_key?: string;
      };
    };
    generation: {
      provider: GenerationProvider;
      model: string;
      base_url?: string;
      api_key?: string;
      reasoning?: ReasoningLevel;
      reasoning_overrides?: Partial<Record<GenerationReasoningScope, ReasoningLevel>>;
      prompts: {
        name_cluster: {
          guidance: string;
        };
        segment_topics: {
          guidance: string;
        };
        propose_split: {
          guidance: string;
        };
        three_way_merge: {
          guidance: string;
        };
        generate_integration: {
          guidance: string;
        };
      };
    };
    search?: {
      exa_api_key?: string;
      context7_api_key?: string;
      retrieval?: {
        return_limit?: number;
        vector_limit?: number;
        journal_group_limit?: number;
        journal_entries_per_group?: number;
      };
      timeouts?: {
        embedding_ms?: number;
        rerank_ms?: number;
        executive_summary_ms?: number;
      };
      rerank?: {
        provider?: "cohere";
        enabled?: boolean;
        model?: string;
        candidates?: number;
        max_chars?: number;
        api_key?: string;
        base_url?: string;
        min_relevance?: number; // minimum reranker score to pass to executive summary (0-1)
      };
      executive_summary?: {
        enabled?: boolean;
        provider?: GenerationProvider;
        model?: string;
        api_key?: string;
        base_url?: string;
        reasoning?: ReasoningLevel;
        max_matches?: number;
        max_chars?: number;
      };
      retrieval_opts?: {
        max_grounding_hits?: number;
        freshness_decay_days?: number;
        ppr_fusion_alpha?: number;
      };
    };
  };
  chunking: {
    target_tokens: number;
    overlap: number;
  };
  thresholds: {
    convergence: number;
    magnitude_epsilon: number;
    staleness_days: number;
    dangling_days: number;
    conflict_warn: number;
    theta_mixed: number;
    theta_critical: number;
    fiedler_drop: number;
    max_log_n: number;
  };
  rrf: {
    k: number;
    lane_weights?: number[]; // per-lane weight for RRF [text, code, bm25]
  };
  debug?: {
    ask?: {
      trace?: boolean;
    };
  };
}

// ─── Chunker Types ────────────────────────────────────────
export interface TextChunk {
  content: string;
  headings: string[];
  tokenCount: number;
}

// ─── Vector Search Types ──────────────────────────────────
export interface VectorSearchResult {
  chunkId: string;
  distance: number;
}

export interface BM25SearchResult {
  chunkId: string;
  rank: number;
}

export interface RRFResult {
  chunkId: string;
  score: number;
}

// ─── File Refs ───────────────────────────────────────────
export interface FileRef {
  path: string;
  lines?: [number, number];
}

// ─── Resolve Dangling ─────────────────────────────────────
export type DanglingAction = "resume" | "abandon";

export interface ResolveDangling {
  narrative: string;
  action: DanglingAction;
}
