// Uniform pipeline for reflection mapped rows: after the reflection-lane
// admission gate, mapped rows take exactly the extraction candidates' path —
// batched dedup decider, verdict handling, batched merge writer, bulk create —
// via SmartExtractor.persistGatedCandidates. Operator ruling (2026-07-17):
// "The path must be same everywhere: extraction or reflection -> judge ->
// dedup -> merge-writer"; a duplicate mapped row MERGES into its target
// instead of landing beside it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");

function vectorFor(text) {
  const vec = [];
  for (let d = 0; d < 16; d++) {
    const digest = createHash("sha256").update(`${text}:${d}`).digest();
    vec.push(((digest.readUInt32BE(0) % 2000) - 1000) / 1000);
  }
  return vec;
}

function makeEmbedder() {
  return {
    embed: async (text) => vectorFor(text),
    embedBatch: async (texts) => texts.map((t) => vectorFor(t)),
  };
}

function makeStore({ neighbors = [] } = {}) {
  const rows = new Map();
  for (const n of neighbors) rows.set(n.id, n);
  const updates = [];
  const bulkStored = [];
  return {
    rows,
    updates,
    bulkStored,
    async vectorSearch() {
      return [...rows.values()].map((entry) => ({ entry, score: 0.85 }));
    },
    async getById(id) {
      return rows.get(id) ?? null;
    },
    async update(id, patch) {
      updates.push({ id, patch });
      return rows.get(id) ?? null;
    },
    async store() {},
    async bulkStore(entries) {
      bulkStored.push(...entries);
      return entries.map((e, i) => ({ ...e, id: `new-${i + 1}`, timestamp: 1_700_000_500_000 }));
    },
  };
}

function neighborRow(id, text) {
  return {
    id,
    text,
    category: "patterns",
    scope: "agent:probe",
    importance: 0.8,
    timestamp: 1_700_000_000_000,
    metadata: JSON.stringify({
      memory_category: "patterns",
      l0_abstract: text,
      l1_overview: `## Existing\n${text}`,
      l2_content: text,
    }),
  };
}

function makeLlm({ onDedupBatch, onMergeBatch }) {
  const calls = [];
  return {
    calls,
    async completeJson(prompt, label) {
      calls.push(label);
      if (label === "dedup-decision-batch") {
        if (!onDedupBatch) throw new Error("unexpected dedup-decision-batch call");
        return onDedupBatch(prompt);
      }
      if (label === "merge-memory-batch") {
        if (!onMergeBatch) throw new Error("unexpected merge-memory-batch call");
        return onMergeBatch(prompt);
      }
      throw new Error(`unexpected llm call: ${label}`);
    },
  };
}

function makeExtractor(store, llm) {
  return new SmartExtractor(store, makeEmbedder(), llm, {
    user: "User",
    extractMinMessages: 1,
    extractMaxChars: 8000,
    defaultScope: "agent:probe",
    log() {},
    debugLog() {},
  });
}

function reflectionItem(text, { category = "patterns", heading = "Agent model deltas (about the assistant/system)" } = {}) {
  const metadata = JSON.stringify({
    type: "memory-reflection-mapped",
    memory_category: category,
    _reflectionHeading: heading,
    marker: "reflection-metadata-preserved",
  });
  return {
    candidate: { category, abstract: text, overview: `## ${heading}`, content: text },
    vector: vectorFor(text),
    buildEntry: (v) => ({
      text,
      vector: v,
      importance: 0.8,
      category,
      scope: "agent:probe",
      metadata,
    }),
  };
}

describe("reflection mapped rows: uniform dedup -> merge pipeline", () => {
  it("merges a duplicate mapped row into its existing target instead of storing it beside it", async () => {
    const store = makeStore({ neighbors: [neighborRow("row-1", "Prefer short answers when the user asks for brevity.")] });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [{ index: 1, decision: "merge", match_index: 1, reason: "adds detail" }],
      }),
      onMergeBatch: () => ({
        results: [{ index: 1, abstract: "merged abstract", overview: "o", content: "merged content" }],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Prefer short answers whenever the user explicitly requests brevity in chat.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.merged, 1, "the duplicate mapped row must merge");
    assert.equal(createdEntries.length, 0, "nothing new lands beside the target");
    assert.equal(store.bulkStored.length, 0);
    const contentUpdate = store.updates.find((u) => u.patch && u.patch.text);
    assert.ok(contentUpdate, "the merge target must be updated");
    assert.equal(contentUpdate.id, "row-1");
    assert.deepEqual(
      llm.calls.filter((c) => c === "dedup-decision-batch"),
      ["dedup-decision-batch"],
      "exactly one batched dedup call",
    );
    assert.deepEqual(
      llm.calls.filter((c) => c === "merge-memory-batch"),
      ["merge-memory-batch"],
      "exactly one batched merge-writer call",
    );
  });

  it("stores a novel mapped row through the caller's entry builder, reflection metadata intact", async () => {
    const store = makeStore({ neighbors: [] });
    const llm = makeLlm({});
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [reflectionItem("Never assert a preference value that has been marked reversed.")],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(stats.created, 1);
    assert.equal(createdEntries.length, 1);
    assert.equal(store.bulkStored.length, 1);
    const meta = JSON.parse(store.bulkStored[0].metadata);
    assert.equal(meta.marker, "reflection-metadata-preserved", "CREATE writes must keep the reflection metadata");
    assert.equal(meta.type, "memory-reflection-mapped");
    assert.equal(store.bulkStored[0].category, "patterns");
    assert.equal(llm.calls.length, 0, "no similar rows -> no dedup or merge LLM calls");
  });

  it("decides a whole burst with exactly one batched dedup call and drops skip verdicts", async () => {
    const store = makeStore({
      neighbors: [
        neighborRow("row-1", "Prefer short answers when the user asks for brevity."),
        neighborRow("row-2", "Always honor a session-scoped no-tools constraint."),
      ],
    });
    const llm = makeLlm({
      onDedupBatch: () => ({
        results: [
          { index: 1, decision: "skip", match_index: 1, reason: "duplicate" },
          { index: 2, decision: "skip", match_index: 2, reason: "duplicate" },
          { index: 3, decision: "create", reason: "new" },
        ],
      }),
    });
    const extractor = makeExtractor(store, llm);

    const { stats, createdEntries } = await extractor.persistGatedCandidates(
      [
        reflectionItem("Prefer short answers when the user requests brevity."),
        reflectionItem("Honor the session-scoped no-tools constraint always."),
        reflectionItem("Route fork-codebase questions to the standing fork agent."),
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], sessionKey: "refl-test" },
    );

    assert.equal(llm.calls.filter((c) => c === "dedup-decision-batch").length, 1, "one dedup call for the burst");
    assert.equal(stats.skipped, 2);
    assert.equal(stats.created, 1);
    assert.equal(createdEntries.length, 1);
  });
});

describe("lane-affinity llm override", () => {
  it("routes the dedup decider and merge writer through options.llmOverride, never the extractor's base llm", async () => {
    const neighbor = neighborRow("row-000001", "Existing pattern about tea");
    const store = makeStore({ neighbors: [neighbor] });
    const baseCalls = [];
    const laneCalls = [];
    const baseLlm = {
      async completeJson(_p, label) {
        baseCalls.push(label);
        return null;
      },
    };
    const laneLlm = {
      async completeJson(_p, label) {
        laneCalls.push(label);
        if (label === "dedup-decision-batch") {
          return { results: [{ index: 1, decision: "merge", match_index: 1, reason: "same fact" }] };
        }
        if (label === "merge-memory-batch") {
          return { results: [{ index: 1, abstract: "merged", overview: "o", content: "c" }] };
        }
        return null;
      },
    };
    const extractor = new SmartExtractor(store, makeEmbedder(), baseLlm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "agent:probe",
      log() {},
      debugLog() {},
    });
    const candidate = {
      category: "patterns",
      abstract: "Existing pattern about tea, restated with the same meaning",
      overview: "## Pattern",
      content: "restated tea pattern",
    };
    const result = await extractor.persistGatedCandidates(
      [
        {
          candidate,
          vector: vectorFor(candidate.abstract),
          buildEntry: (vector) => ({
            text: candidate.abstract,
            vector,
            category: "reflection",
            scope: "agent:probe",
            importance: 0.8,
            timestamp: 1_700_000_400_000,
            metadata: JSON.stringify({
              memory_category: "patterns",
              l0_abstract: candidate.abstract,
              l1_overview: candidate.overview,
              l2_content: candidate.content,
            }),
          }),
        },
      ],
      { targetScope: "agent:probe", scopeFilter: ["agent:probe"], llmOverride: laneLlm },
    );
    assert.equal(result.stats.merged, 1, "the merge verdict must apply through the override client");
    assert.ok(laneCalls.includes("dedup-decision-batch"));
    assert.ok(laneCalls.includes("merge-memory-batch"));
    assert.deepEqual(baseCalls, [], "base llm must stay untouched when a lane override is provided");
  });
});
