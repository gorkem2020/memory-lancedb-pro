import { parseSmartMetadata, buildSmartMetadata, stringifySmartMetadata, appendRelation, deriveFactKey, isMemoryActiveAt, } from "./smart-metadata.js";
import { APPEND_ONLY_CATEGORIES } from "./memory-categories.js";
import { buildMergePrompt, buildConsolidatePrompt } from "./extraction-prompts.js";
const REVERSAL_SIGNAL_PATTERN = /\b(no longer|not anymore|any ?more|stopped|quit|used to|former|discontinued|doesn'?t|don'?t|isn'?t|wasn'?t)\b/i;
const TOPIC_TOKEN_STOPWORDS = new Set([
    "user", "users", "prefer", "prefers", "preferred", "preference", "preferences",
    "favorite", "favourite", "likes", "liked", "like", "dislikes", "dislike",
    "drinking", "drinks", "drink", "drank", "still", "always", "anymore", "any",
    "more", "longer", "stopped", "quit", "used", "no", "not", "the", "a", "an",
    "of", "to", "and", "with", "their", "they", "was", "is", "are", "were",
    "has", "have", "had", "will", "would", "their", "for", "at", "in", "on",
    // Generic life-update narration: these appear across many unrelated life
    // events/decisions and would otherwise let a single multi-topic narrative
    // row bridge several unrelated topic clusters via incidental overlap.
    "decided", "decide", "redesign", "redesigning", "relocate",
    "relocating", "moved", "move", "moving", "changed", "change", "changing",
    "switched", "switch", "started", "start", "starting", "continuing",
    "continues", "testing", "tested", "experiment", "experimenting", "after",
    "before", "now", "previously", "recently", "incident", "productivity",
    "better", "correctly", "confirmed", "offered", "each", "record", "records",
    "distinct", "fact", "facts", "note", "notes", "update", "updates", "updated",
    "from", "into", "this", "that", "these", "those", "it", "its", "them",
]);
function looksLikeReversal(text) {
    return REVERSAL_SIGNAL_PATTERN.test(text);
}
function extractTopicTokens(text) {
    const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
    return new Set(words.filter((w) => !TOPIC_TOKEN_STOPWORDS.has(w)));
}
// Reversal statements are typically short ("User will no longer drink
// cola"); a long multi-fact narrative recap can mention almost every topic
// in a scope at once and would otherwise bridge unrelated clusters through
// incidental keyword overlap. Only short, single-topic-looking statements
// participate in the topic-overlap fallback.
const REVERSAL_TOPIC_LINK_MAX_LENGTH = 120;
function isEligibleForTopicLink(abstract) {
    return abstract.length <= REVERSAL_TOPIC_LINK_MAX_LENGTH;
}
// Tokens match on exact equality or containment (one is a substring of the
// other, e.g. "cola" inside "coca-cola"), since brand/product names are
// routinely abbreviated across lanes. The shorter token must still be long
// enough (>= 4 chars) to keep an accidental short-token containment match
// from firing.
function tokensMatch(a, b) {
    if (a === b)
        return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 4 && longer.includes(shorter);
}
function shareSignificantTopicToken(a, b) {
    const tokensA = extractTopicTokens(a);
    const tokensB = extractTopicTokens(b);
    for (const tokenA of tokensA) {
        for (const tokenB of tokensB) {
            if (tokensMatch(tokenA, tokenB))
                return true;
        }
    }
    return false;
}
function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
export function buildConsolidateCandidate(entry) {
    const meta = parseSmartMetadata(entry.metadata, entry);
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
function isDirectlyLinked(a, b, similarityThreshold) {
    const va = a.entry.vector;
    const vb = b.entry.vector;
    if (va.length > 0 && vb.length > 0 && cosineSimilarity(va, vb) >= similarityThreshold) {
        return true;
    }
    if (a.factKey && a.factKey === b.factKey) {
        return true;
    }
    // Reflection-mapped rows carry no stored fact_key, and a naturally phrased
    // reversal rarely follows the "[Merge key]: text" convention that
    // deriveFactKey needs to align across lanes, so its derived key is
    // effectively unique. Gate a topic-word-overlap fallback to rows that look
    // like a reversal, in the same category, and short enough to plausibly be
    // about one topic, so it only widens linking for the exact case cosine +
    // fact_key miss, not for arbitrary unrelated or multi-topic narrative rows.
    if ((looksLikeReversal(a.abstract) || looksLikeReversal(b.abstract)) &&
        a.memoryCategory &&
        a.memoryCategory === b.memoryCategory &&
        isEligibleForTopicLink(a.abstract) &&
        isEligibleForTopicLink(b.abstract) &&
        shareSignificantTopicToken(a.abstract, b.abstract)) {
        return true;
    }
    return false;
}
/**
 * Seed-based clustering: for each not-yet-assigned row (in order), it
 * becomes the seed of a new cluster, and every OTHER unassigned row joins
 * that cluster only if it is DIRECTLY linked to the seed itself (cosine,
 * fact_key, or the topic-overlap fallback) -- never transitively through
 * another cluster member. Plain union-find (transitive closure) chains
 * unrelated rows together whenever a series of only-moderately-similar
 * pairs bridges them (row A links to B, B links to C, so A and C end up in
 * one cluster even though A and C are never themselves similar); seed-based
 * grouping caps that at a single hop from the seed, which is what keeps a
 * handful of distinct topics from collapsing into one grab-bag cluster.
 */
export function clusterConsolidateCandidates(candidates, similarityThreshold) {
    const n = candidates.length;
    const assigned = new Array(n).fill(false);
    const clusters = [];
    for (let seedIdx = 0; seedIdx < n; seedIdx++) {
        if (assigned[seedIdx])
            continue;
        assigned[seedIdx] = true;
        const cluster = [seedIdx];
        for (let j = 0; j < n; j++) {
            if (assigned[j])
                continue;
            if (isDirectlyLinked(candidates[seedIdx], candidates[j], similarityThreshold)) {
                assigned[j] = true;
                cluster.push(j);
            }
        }
        if (cluster.length >= 2)
            clusters.push(cluster);
    }
    return clusters;
}
export function chunkCluster(indices, maxSize) {
    const chunks = [];
    for (let i = 0; i < indices.length; i += maxSize) {
        chunks.push(indices.slice(i, i + maxSize));
    }
    return chunks;
}
export function parseConsolidateVerdict(raw, memberCount) {
    if (!raw || typeof raw !== "object")
        return null;
    const obj = raw;
    const verdict = obj.verdict;
    if (verdict !== "skip" && verdict !== "merge" && verdict !== "supersede" && verdict !== "contradict") {
        return null;
    }
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    if (verdict === "skip" || verdict === "contradict") {
        return { verdict, reason };
    }
    const survivorIndex = Number(obj.survivor_index);
    if (!Number.isInteger(survivorIndex) || survivorIndex < 1 || survivorIndex > memberCount)
        return null;
    const absorbedRaw = obj.absorbed_indices;
    if (!Array.isArray(absorbedRaw) || absorbedRaw.length === 0)
        return null;
    const absorbedIndices = absorbedRaw.map((v) => Number(v));
    if (absorbedIndices.some((i) => !Number.isInteger(i) || i < 1 || i > memberCount || i === survivorIndex)) {
        return null;
    }
    return { verdict, reason, survivorIndex, absorbedIndices };
}
async function applyMergeVerdict(deps, members, verdict, scopeFilter, now) {
    const survivor = members[verdict.survivorIndex - 1];
    let abstract = survivor.abstract;
    let overview = survivor.overview;
    let content = survivor.content;
    const absorbedIds = [];
    for (const idx of verdict.absorbedIndices) {
        const absorbed = members[idx - 1];
        const prompt = buildMergePrompt(abstract, overview, content, absorbed.abstract, absorbed.overview, absorbed.content, survivor.memoryCategory || "preferences");
        const merged = await deps.completeJson(prompt, "consolidate-merge");
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
    await deps.update(survivor.entry.id, { text: abstract, vector: newVector, metadata: stringifySmartMetadata(auditedMeta) }, scopeFilter);
    for (const idx of verdict.absorbedIndices) {
        await deps.delete(members[idx - 1].entry.id, scopeFilter);
    }
    return { action: "merge", survivorId: survivor.entry.id, absorbedIds, reason: verdict.reason, scope: survivor.entry.scope };
}
async function applySupersedeVerdict(deps, members, verdict, scopeFilter, now) {
    const survivor = members[verdict.survivorIndex - 1];
    const factKey = survivor.factKey || members[verdict.absorbedIndices[0] - 1].factKey || "";
    const absorbedIds = [];
    for (const idx of verdict.absorbedIndices) {
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
const DEFAULT_SIMILARITY_THRESHOLD = 0.86;
const DEFAULT_CLUSTER_CAP = 8;
const DEFAULT_SCAN_LIMIT = 100_000;
export async function runConsolidate(deps, options) {
    const now = options.now ?? Date.now();
    const scopeFilter = options.scopeFilter ?? [options.scope];
    const rawEntries = await deps.fetchRows(scopeFilter, now, DEFAULT_SCAN_LIMIT);
    const filtered = rawEntries.filter((entry) => {
        if (entry.category === "reflection" && !options.includeReflectionSlices)
            return false;
        if (options.sinceMs !== undefined && entry.timestamp < options.sinceMs)
            return false;
        return true;
    });
    const candidates = filtered
        .map(buildConsolidateCandidate)
        .filter((candidate) => {
        const meta = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
        if (!isMemoryActiveAt(meta, now))
            return false;
        if (options.category && candidate.memoryCategory !== options.category)
            return false;
        return true;
    });
    const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const clusterCap = options.clusterCap ?? DEFAULT_CLUSTER_CAP;
    const clusterIndexGroups = clusterConsolidateCandidates(candidates, similarityThreshold);
    const clusters = [];
    const applied = [];
    let skippedMalformed = 0;
    for (const group of clusterIndexGroups) {
        const chunks = chunkCluster(group, clusterCap);
        for (const chunkIndices of chunks) {
            if (chunkIndices.length < 2)
                continue;
            const members = chunkIndices.map((i) => candidates[i]);
            const prompt = buildConsolidatePrompt(members.map((m, i) => ({
                index: i + 1,
                category: m.memoryCategory || "preferences",
                abstract: m.abstract,
                overview: m.overview,
                content: m.content,
                source: m.source,
            })));
            const combinedPrompt = `${prompt.system}\n\n${prompt.user}`;
            const raw = await deps.completeJson(combinedPrompt, "consolidate-decide");
            const verdict = raw ? parseConsolidateVerdict(raw, members.length) : null;
            if (!verdict) {
                skippedMalformed += 1;
                deps.log?.(`memory-consolidate: missing or malformed verdict for a cluster of ${members.length} rows, skipping`);
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
            if (!options.apply)
                continue;
            if (verdict.verdict === "skip" || verdict.verdict === "contradict")
                continue;
            const actedUponIndices = [verdict.survivorIndex, ...verdict.absorbedIndices];
            if (actedUponIndices.some((idx) => {
                const category = members[idx - 1].memoryCategory;
                return category && APPEND_ONLY_CATEGORIES.has(category);
            })) {
                deps.log?.(`memory-consolidate: refusing to ${verdict.verdict} an append-only row (events/cases); skipping this verdict`);
                continue;
            }
            try {
                const audit = verdict.verdict === "merge"
                    ? await applyMergeVerdict(deps, members, verdict, scopeFilter, now)
                    : await applySupersedeVerdict(deps, members, verdict, scopeFilter, now);
                applied.push(audit);
                await deps.onAudit?.(audit);
            }
            catch (err) {
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
