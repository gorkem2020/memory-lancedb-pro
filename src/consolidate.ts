import type { MemoryEntry } from "./store.js";
import {
  parseSmartMetadata,
  buildSmartMetadata,
  stringifySmartMetadata,
  appendRelation,
  deriveFactKey,
  isMemoryActiveAt,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { APPEND_ONLY_CATEGORIES, type MemoryCategory } from "./memory-categories.js";
import { buildMergePrompt, buildConsolidatePrompt } from "./extraction-prompts.js";

export type ConsolidateVerdict = "skip" | "merge" | "supersede" | "contradict";

export interface ConsolidateVerdictResult {
  verdict: ConsolidateVerdict;
  reason: string;
  survivorIndex?: number;
  absorbedIndices?: number[];
}

export interface ConsolidateCandidate {
  entry: MemoryEntry;
  memoryCategory?: MemoryCategory;
  abstract: string;
  overview: string;
  content: string;
  factKey?: string;
  source?: string;
}

const REVERSAL_SIGNAL_PATTERN =
  /\b(no longer|not anymore|any ?more|stopped|quit|used to|former|discontinued|doesn'?t|don'?t|isn'?t|wasn'?t)\b/i;

const TOPIC_TOKEN_STOPWORDS = new Set([
  "user", "users", "prefer", "prefers", "preferred", "preference", "preferences",
  "favorite", "favourite", "likes", "liked", "like", "dislikes", "dislike",
  "drinking", "drinks", "drink", "drank", "still", "always", "anymore", "any",
  "more", "longer", "stopped", "quit", "used", "no", "not", "the", "a", "an",
  "of", "to", "and", "with", "their", "they", "was", "is", "are", "were",
  "has", "have", "had", "will", "would", "their", "for", "at", "in", "on",
]);

function looksLikeReversal(text: string): boolean {
  return REVERSAL_SIGNAL_PATTERN.test(text);
}

function extractTopicTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  return new Set(words.filter((w) => !TOPIC_TOKEN_STOPWORDS.has(w)));
}

function shareSignificantTopicToken(a: string, b: string): boolean {
  const tokensA = extractTopicTokens(a);
  const tokensB = extractTopicTokens(b);
  for (const token of tokensA) {
    if (tokensB.has(token)) return true;
  }
  return false;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function buildConsolidateCandidate(entry: MemoryEntry): ConsolidateCandidate {
  const meta: SmartMemoryMetadata = parseSmartMetadata(entry.metadata, entry);
  const abstract = meta.l0_abstract || entry.text;
  const factKey = meta.fact_key || deriveFactKey(meta.memory_category, abstract);
  return {
    entry,
    memoryCategory: meta.memory_category,
    abstract,
    overview: meta.l1_overview || "",
    content: meta.l2_content || entry.text,
    factKey,
    source: meta.source,
  };
}

/**
 * Union-find clustering: two rows join the same cluster if they are similar
 * enough by embedding cosine, OR if they share a non-empty fact_key. The
 * fact_key link lets a low-cosine reversal row (e.g. "quit X") land in the
 * same cluster as the rows it contradicts, which plain vector similarity
 * would place too far apart.
 */
export function clusterConsolidateCandidates(
  candidates: ConsolidateCandidate[],
  similarityThreshold: number
): number[][] {
  const n = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let linked = false;
      const vi = candidates[i].entry.vector;
      const vj = candidates[j].entry.vector;
      if (vi.length > 0 && vj.length > 0 && cosineSimilarity(vi, vj) >= similarityThreshold) {
        linked = true;
      }
      if (!linked && candidates[i].factKey && candidates[i].factKey === candidates[j].factKey) {
        linked = true;
      }
      // Reflection-mapped rows carry no stored fact_key, and a naturally
      // phrased reversal rarely follows the "[Merge key]: text" convention
      // that deriveFactKey needs to align across lanes, so its derived key
      // is effectively unique. Gate a topic-word-overlap fallback to rows
      // that look like a reversal, so it only widens linking for the exact
      // case cosine + fact_key miss, not for arbitrary unrelated rows.
      if (
        !linked &&
        (looksLikeReversal(candidates[i].abstract) || looksLikeReversal(candidates[j].abstract)) &&
        shareSignificantTopicToken(candidates[i].abstract, candidates[j].abstract)
      ) {
        linked = true;
      }
      if (linked) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  return [...groups.values()].filter((g) => g.length >= 2);
}

export function chunkCluster(indices: number[], maxSize: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < indices.length; i += maxSize) {
    chunks.push(indices.slice(i, i + maxSize));
  }
  return chunks;
}

export function parseConsolidateVerdict(raw: unknown, memberCount: number): ConsolidateVerdictResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "skip" && verdict !== "merge" && verdict !== "supersede" && verdict !== "contradict") {
    return null;
  }
  const reason = typeof obj.reason === "string" ? obj.reason : "";

  if (verdict === "skip" || verdict === "contradict") {
    return { verdict, reason };
  }

  const survivorIndex = Number(obj.survivor_index);
  if (!Number.isInteger(survivorIndex) || survivorIndex < 1 || survivorIndex > memberCount) return null;

  const absorbedRaw = obj.absorbed_indices;
  if (!Array.isArray(absorbedRaw) || absorbedRaw.length === 0) return null;
  const absorbedIndices = absorbedRaw.map((v) => Number(v));
  if (
    absorbedIndices.some(
      (i) => !Number.isInteger(i) || i < 1 || i > memberCount || i === survivorIndex
    )
  ) {
    return null;
  }

  return { verdict, reason, survivorIndex, absorbedIndices };
}

export interface ConsolidateAuditEntry {
  action: "merge" | "supersede";
  survivorId: string;
  absorbedIds: string[];
  reason: string;
  scope: string;
}

export interface ConsolidateWriteDeps {
  update: (
    id: string,
    patch: { text?: string; vector?: number[]; metadata: string },
    scopeFilter?: string[]
  ) => Promise<unknown>;
  delete: (id: string, scopeFilter?: string[]) => Promise<unknown>;
  embed: (text: string) => Promise<number[]>;
  completeJson: <T>(prompt: string, label?: string, systemPrompt?: string) => Promise<T | null>;
}

async function applyMergeVerdict(
  deps: ConsolidateWriteDeps,
  members: ConsolidateCandidate[],
  verdict: ConsolidateVerdictResult,
  scopeFilter: string[] | undefined,
  now: number
): Promise<ConsolidateAuditEntry> {
  const survivor = members[verdict.survivorIndex! - 1];
  let abstract = survivor.abstract;
  let overview = survivor.overview;
  let content = survivor.content;

  const absorbedIds: string[] = [];
  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    const prompt = buildMergePrompt(
      abstract,
      overview,
      content,
      absorbed.abstract,
      absorbed.overview,
      absorbed.content,
      survivor.memoryCategory || "preferences"
    );
    const merged = await deps.completeJson<{ abstract: string; overview: string; content: string }>(
      prompt.user,
      "consolidate-merge",
      prompt.system
    );
    if (merged) {
      abstract = merged.abstract;
      overview = merged.overview;
      content = merged.content;
    }
    absorbedIds.push(absorbed.entry.id);
  }

  const newVector = await deps.embed(`${abstract} ${content}`);
  const patchedMeta = buildSmartMetadata(survivor.entry, {
    l0_abstract: abstract,
    l1_overview: overview,
    l2_content: content,
  });
  const auditedMeta = {
    ...patchedMeta,
    consolidation_audit: { action: "merge", absorbedIds, reason: verdict.reason, at: now },
  };
  await deps.update(
    survivor.entry.id,
    { text: abstract, vector: newVector, metadata: stringifySmartMetadata(auditedMeta) },
    scopeFilter
  );

  for (const idx of verdict.absorbedIndices!) {
    await deps.delete(members[idx - 1].entry.id, scopeFilter);
  }

  return { action: "merge", survivorId: survivor.entry.id, absorbedIds, reason: verdict.reason, scope: survivor.entry.scope };
}

async function applySupersedeVerdict(
  deps: ConsolidateWriteDeps,
  members: ConsolidateCandidate[],
  verdict: ConsolidateVerdictResult,
  scopeFilter: string[] | undefined,
  now: number
): Promise<ConsolidateAuditEntry> {
  const survivor = members[verdict.survivorIndex! - 1];
  const factKey = survivor.factKey || members[verdict.absorbedIndices![0] - 1].factKey || "";
  const absorbedIds: string[] = [];

  for (const idx of verdict.absorbedIndices!) {
    const absorbed = members[idx - 1];
    const existingMeta = parseSmartMetadata(absorbed.entry.metadata, absorbed.entry);
    const invalidatedMetadata = buildSmartMetadata(absorbed.entry, {
      fact_key: factKey || existingMeta.fact_key,
      invalidated_at: now,
      superseded_by: survivor.entry.id,
      relations: appendRelation(existingMeta.relations, { type: "superseded_by", targetId: survivor.entry.id }),
    });
    await deps.update(absorbed.entry.id, { metadata: stringifySmartMetadata(invalidatedMetadata) }, scopeFilter);
    absorbedIds.push(absorbed.entry.id);
  }

  const survivorMeta = parseSmartMetadata(survivor.entry.metadata, survivor.entry);
  const patchedSurvivorMeta = buildSmartMetadata(survivor.entry, {
    fact_key: factKey || survivorMeta.fact_key,
  });
  const auditedMeta = {
    ...patchedSurvivorMeta,
    consolidation_audit: { action: "supersede", absorbedIds, reason: verdict.reason, at: now },
  };
  await deps.update(survivor.entry.id, { metadata: stringifySmartMetadata(auditedMeta) }, scopeFilter);

  return { action: "supersede", survivorId: survivor.entry.id, absorbedIds, reason: verdict.reason, scope: survivor.entry.scope };
}

export interface ClusterPlanReport {
  memberIds: string[];
  memberTexts: string[];
  verdict: ConsolidateVerdictResult | null;
  malformed: boolean;
}

export interface RunConsolidateOptions {
  scope: string;
  scopeFilter?: string[];
  category?: MemoryCategory;
  sinceMs?: number;
  includeReflectionSlices?: boolean;
  similarityThreshold?: number;
  clusterCap?: number;
  apply: boolean;
  now?: number;
}

export interface RunConsolidateDeps extends ConsolidateWriteDeps {
  fetchRows: (scopeFilter: string[] | undefined, maxTimestamp: number, limit: number) => Promise<MemoryEntry[]>;
  onAudit?: (audit: ConsolidateAuditEntry) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface RunConsolidateResult {
  scanned: number;
  eligible: number;
  clusters: ClusterPlanReport[];
  applied: ConsolidateAuditEntry[];
  skippedMalformed: number;
  apply: boolean;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.86;
const DEFAULT_CLUSTER_CAP = 8;
const DEFAULT_SCAN_LIMIT = 100_000;

export async function runConsolidate(
  deps: RunConsolidateDeps,
  options: RunConsolidateOptions
): Promise<RunConsolidateResult> {
  const now = options.now ?? Date.now();
  const scopeFilter = options.scopeFilter ?? [options.scope];

  const rawEntries = await deps.fetchRows(scopeFilter, now, DEFAULT_SCAN_LIMIT);

  const filtered = rawEntries.filter((entry) => {
    if (entry.category === "reflection" && !options.includeReflectionSlices) return false;
    if (options.sinceMs !== undefined && entry.timestamp < options.sinceMs) return false;
    return true;
  });

  const candidates = filtered
    .map(buildConsolidateCandidate)
    .filter((candidate) => {
      const meta = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
      if (!isMemoryActiveAt(meta, now)) return false;
      if (options.category && candidate.memoryCategory !== options.category) return false;
      return true;
    });

  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const clusterCap = options.clusterCap ?? DEFAULT_CLUSTER_CAP;
  const clusterIndexGroups = clusterConsolidateCandidates(candidates, similarityThreshold);

  const clusters: ClusterPlanReport[] = [];
  const applied: ConsolidateAuditEntry[] = [];
  let skippedMalformed = 0;

  for (const group of clusterIndexGroups) {
    const chunks = chunkCluster(group, clusterCap);
    for (const chunkIndices of chunks) {
      if (chunkIndices.length < 2) continue;

      const members = chunkIndices.map((i) => candidates[i]);
      const prompt = buildConsolidatePrompt(
        members.map((m, i) => ({
          index: i + 1,
          category: m.memoryCategory || "preferences",
          abstract: m.abstract,
          overview: m.overview,
          content: m.content,
          source: m.source,
        }))
      );
      const raw = await deps.completeJson<Record<string, unknown>>(prompt.user, "consolidate-decide", prompt.system);
      const verdict = raw ? parseConsolidateVerdict(raw, members.length) : null;

      if (!verdict) {
        skippedMalformed += 1;
        deps.log?.(
          `memory-consolidate: missing or malformed verdict for a cluster of ${members.length} rows, skipping`
        );
        clusters.push({
          memberIds: members.map((m) => m.entry.id),
          memberTexts: members.map((m) => m.abstract),
          verdict: null,
          malformed: true,
        });
        continue;
      }

      clusters.push({
        memberIds: members.map((m) => m.entry.id),
        memberTexts: members.map((m) => m.abstract),
        verdict,
        malformed: false,
      });

      if (!options.apply) continue;
      if (verdict.verdict === "skip" || verdict.verdict === "contradict") continue;

      if (members.some((m) => m.memoryCategory && APPEND_ONLY_CATEGORIES.has(m.memoryCategory))) {
        deps.log?.(
          `memory-consolidate: refusing to ${verdict.verdict} a cluster containing an append-only category (events/cases); skipping`
        );
        continue;
      }

      try {
        const audit =
          verdict.verdict === "merge"
            ? await applyMergeVerdict(deps, members, verdict, scopeFilter, now)
            : await applySupersedeVerdict(deps, members, verdict, scopeFilter, now);
        applied.push(audit);
        await deps.onAudit?.(audit);
      } catch (err) {
        deps.log?.(`memory-consolidate: failed to apply ${verdict.verdict} verdict: ${String(err)}`);
      }
    }
  }

  return {
    scanned: rawEntries.length,
    eligible: candidates.length,
    clusters,
    applied,
    skippedMalformed,
    apply: options.apply,
  };
}
