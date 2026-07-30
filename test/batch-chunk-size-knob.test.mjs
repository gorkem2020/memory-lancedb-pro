// batchChunkSize knob: one config value bounds the per-call chunk size of
// every batched pipeline stage (admission utility, dedup decider, merge
// writer, consolidate merge-content), replacing the four hardcoded 10s.
// Deferred-by-operator feature; default stays 10 and out-of-range values
// clamp, so existing behavior is unchanged when the knob is absent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { parsePluginConfig } = jiti("../index.ts");
const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { runConsolidate } = jiti("../src/consolidate.ts");

describe("batchChunkSize config parsing", () => {
  const baseConfig = { embedding: { apiKey: "test", dimensions: 4 } };
  it("defaults to 10 and clamps out-of-range values", () => {
    assert.equal(parsePluginConfig({ ...baseConfig }).batchChunkSize, 10);
    assert.equal(parsePluginConfig({ ...baseConfig, batchChunkSize: 4 }).batchChunkSize, 4);
    assert.equal(parsePluginConfig({ ...baseConfig, batchChunkSize: 0 }).batchChunkSize, 10);
    assert.equal(parsePluginConfig({ ...baseConfig, batchChunkSize: -3 }).batchChunkSize, 10);
    assert.equal(parsePluginConfig({ ...baseConfig, batchChunkSize: 500 }).batchChunkSize, 50);
    assert.equal(parsePluginConfig({ ...baseConfig, batchChunkSize: "nonsense" }).batchChunkSize, 10);
  });
});

describe("admission utility honors batchChunkSize", () => {
  function makeStore() {
    return {
      async vectorSearch() {
        return [];
      },
    };
  }
  function makeBatchItems(count) {
    return Array.from({ length: count }, (_, i) => ({
      candidate: {
        category: "events",
        abstract: `candidate ${i + 1}`,
        overview: `## Event ${i + 1}`,
        content: `the user did thing ${i + 1}`,
      },
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: "shared conversation excerpt",
      scopeFilter: ["global"],
    }));
  }

  it("splits 10 candidates into ceil(10/4) = 3 calls when batchChunkSize is 4", async () => {
    let calls = 0;
    const llm = {
      async completeJson(prompt, label) {
        assert.equal(label, "admission-utility-batch");
        calls++;
        const count = (prompt.match(/^### \d+\./gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({ index: i + 1, utility: 0.5, reason: "r" })),
        };
      },
    };
    const config = normalizeAdmissionControlConfig({
      enabled: true,
      utilityMode: "batch",
      batchChunkSize: 4,
    });
    const controller = new AdmissionController(makeStore(), llm, config);
    const results = await controller.evaluateBatch(makeBatchItems(10));
    assert.equal(results.length, 10);
    assert.equal(calls, 3);
  });
});

describe("dedup decider and merge writer honor batchChunkSize", () => {
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
  function neighborRow(id) {
    return {
      id,
      text: `existing fact ${id}`,
      category: "preference",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000_000,
      metadata: JSON.stringify({
        memory_category: "preferences",
        l0_abstract: `existing fact ${id}`,
        l1_overview: `## Existing ${id}`,
        l2_content: `full existing content for ${id}`,
      }),
    };
  }
  function makeNeighborStore() {
    const rows = new Map();
    let searchCalls = 0;
    return {
      async vectorSearch() {
        searchCalls += 1;
        const id = `row-${searchCalls}`;
        if (!rows.has(id)) rows.set(id, neighborRow(id));
        return [{ entry: rows.get(id), score: 0.85 }];
      },
      async getById(id) {
        if (!rows.has(id)) rows.set(id, neighborRow(id));
        return rows.get(id);
      },
      async update() {
        return {};
      },
      async store() {},
      async bulkStore(entries) {
        return entries.map((e, i) => ({ ...e, id: `new-${i + 1}`, timestamp: Date.now() }));
      },
    };
  }

  it("splits 5 dedup decisions into ceil(5/2) = 3 calls when batchChunkSize is 2", async () => {
    let dedupCalls = 0;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "extract-candidates") {
          return {
            memories: Array.from({ length: 5 }, (_, i) => ({
              category: "preferences",
              abstract: `pref number ${i + 1} about drink brand ${i + 1}`,
              overview: `## Preference ${i + 1}`,
              content: `user stated preference detail ${i + 1}`,
            })),
          };
        }
        if (label === "dedup-decision-batch") {
          dedupCalls++;
          const count = (prompt.match(/^### \d+\./gm) || []).length;
          return {
            results: Array.from({ length: count }, (_, i) => ({ index: i + 1, decision: "skip", reason: "dup" })),
          };
        }
        throw new Error(`unexpected llm call: ${label}`);
      },
    };
    const extractor = new SmartExtractor(makeNeighborStore(), makeEmbedder(), llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      batchChunkSize: 2,
      log() {},
      debugLog() {},
    });

    await extractor.extractAndPersist("text", "s1", { scope: "global" });
    assert.equal(dedupCalls, 3, "5 candidates at chunk size 2 must take 3 dedup calls");
  });
});

describe("consolidate merge-content honors the chunk size", () => {
  let nextId = 1;
  function makeRow(abstract) {
    const id = `row-${String(nextId++).padStart(6, "0")}`;
    return {
      id,
      text: abstract,
      vector: [1, 0],
      category: "preference",
      scope: "global",
      importance: 0.7,
      timestamp: 1_700_000_000_000 + nextId,
      metadata: JSON.stringify({
        l0_abstract: abstract,
        l1_overview: "",
        l2_content: abstract,
        memory_category: "preferences",
        fact_key: `preferences:${abstract.slice(0, 12)}`,
        source: "manual",
        valid_from: 1_700_000_000_000,
      }),
    };
  }

  it("splits 3 merge jobs into 3 calls when mergeChunkSize is 1", async () => {
    const pairs = [
      [makeRow("Coffee order: oat milk latte"), makeRow("Coffee order: oat milk latte, extra hot")],
      [makeRow("Tea order: green tea"), makeRow("Tea order: green tea with honey")],
      [makeRow("Juice order: fresh orange"), makeRow("Juice order: fresh orange no pulp")],
    ];
    // Give each pair a distinct orthogonal vector so clustering yields three
    // separate clusters instead of one merged blob.
    pairs[0].forEach((r) => (r.vector = [1, 0, 0]));
    pairs[1].forEach((r) => (r.vector = [0, 1, 0]));
    pairs[2].forEach((r) => (r.vector = [0, 0, 1]));
    const rows = pairs.flat();

    let mergeCalls = 0;
    const llm = async (_prompt, label) => {
      if (label === "consolidate-decide") {
        return {
          verdicts: [1, 2, 3].map((n) => ({
            cluster_index: n,
            verdict: "merge",
            survivor_index: 1,
            absorbed_indices: [2],
            reason: "same fact",
          })),
        };
      }
      if (label === "consolidate-merge-batch") {
        mergeCalls++;
        return { results: [{ index: 1, abstract: "merged", overview: "o", content: "c" }] };
      }
      throw new Error(`unexpected llm call: ${label}`);
    };

    const result = await runConsolidate(
      {
        fetchRows: async () => rows.map((r) => ({ ...r })),
        update: async () => ({}),
        getById: async (id) => rows.find((r) => r.id === id) ?? null,
        embed: async (text) => [text.length, 0, 0],
        completeJson: llm,
      },
      {
        scope: "global",
        apply: false,
        autoConfirm: true,
        now: 1_700_100_000_000,
        mergeChunkSize: 1,
      },
    );

    assert.equal(result.clusters.filter((c) => c.action === "merge").length, 3);
    assert.equal(mergeCalls, 3, "3 merge jobs at chunk size 1 must take 3 merge-content calls");
  });
});
