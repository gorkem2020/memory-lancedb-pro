import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { normalizeAdmissionControlConfig, createAdmissionController } = jiti("../src/admission-control.ts");

function makeStore() {
  return {
    async vectorSearch() {
      return [];
    },
    async store() {},
    async bulkStore() {},
  };
}

// Cryptographic per-dimension hash so texts differing by even one character
// (e.g. "candidate 1" vs "candidate 2") land far apart in cosine space. A
// naive rolling/modulo hash is locality-preserving for such tiny character
// deltas and produces near-identical vectors, which trips SmartExtractor's
// own batch-internal near-duplicate dedup before admission ever runs.
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
    async embed(text) {
      return vectorFor(text);
    },
    async embedBatch(texts) {
      return (texts || []).map(vectorFor);
    },
  };
}

function makeExtractionLlm(batchCalls, candidateCount) {
  return {
    async completeJson(prompt, label) {
      if (label === "extract-candidates") {
        return {
          memories: Array.from({ length: candidateCount }, (_, i) => ({
            category: "events",
            abstract: `candidate ${i + 1}`,
            overview: `## Event ${i + 1}`,
            content: `the user did thing ${i + 1}`,
          })),
        };
      }
      if (label === "admission-utility-batch") {
        batchCalls.push(prompt);
        const count = (prompt.match(/^\d+\. Category:/gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            utility: 0.9,
            reason: "batched",
          })),
        };
      }
      throw new Error(`unexpected mode: ${label}`);
    },
  };
}

describe("SmartExtractor batch admission integration", () => {
  it("scores admission utility for a whole extraction batch with exactly one LLM call", async () => {
    const batchCalls = [];
    const llm = makeExtractionLlm(batchCalls, 3);
    const store = makeStore();
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    // SmartExtractor no longer builds its own admission controller from
    // config (decoupled so admission gating works independently of smart
    // extraction) -- construct and inject one explicitly, matching how a
    // real caller (index.ts) wires it.
    const admissionController = createAdmissionController(store, llm, admissionControl, () => {});

    const extractor = new SmartExtractor(store, makeEmbedder(), llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      admissionControl,
      admissionController,
      log() {},
      debugLog() {},
    });

    const stats = await extractor.extractAndPersist(
      "the user did three notable things today",
      "session-batch-1",
      { scope: "global" },
    );

    assert.equal(batchCalls.length, 1, "expected exactly one batch-utility LLM call for 3 candidates");
    assert.equal(stats.created, 3);
  });
});
