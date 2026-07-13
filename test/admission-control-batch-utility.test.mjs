import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");

function makeStore() {
  return {
    async vectorSearch() {
      return [];
    },
  };
}

function makeCandidate(n) {
  return {
    category: "events",
    abstract: `candidate ${n}`,
    overview: `## Event ${n}`,
    content: `the user did thing ${n}`,
  };
}

function makeBatchItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    candidate: makeCandidate(i + 1),
    candidateVector: [0.1, 0.2, 0.3],
    conversationText: "shared conversation excerpt",
    scopeFilter: ["global"],
  }));
}

describe("AdmissionController.evaluateBatch", () => {
  it("issues exactly one LLM call for a batch of 3 candidates, producing three distinct audits", async () => {
    let callCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        callCount++;
        assert.equal(label, "admission-utility-batch");
        return {
          results: [
            { index: 1, utility: 0.9, reason: "durable" },
            { index: 2, utility: 0.05, reason: "chatter" },
            { index: 3, utility: 0.5, reason: "middling" },
          ],
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(3));

    assert.equal(callCount, 1, "expected exactly one LLM call for the whole batch");
    assert.equal(results.length, 3);
    const reasons = results.map((r) => r.audit.utility_reason);
    assert.deepEqual(reasons, ["durable", "chatter", "middling"]);
    // Distinct scores prove each got its own audit, not one shared decision.
    const scores = results.map((r) => r.audit.feature_scores.utility);
    assert.deepEqual(scores, [0.9, 0.05, 0.5]);
  });

  it("falls back to standalone per-candidate calls when the batch response is malformed", async () => {
    let batchCallCount = 0;
    let standaloneCallCount = 0;
    const llm = {
      async completeJson(_prompt, label) {
        if (label === "admission-utility-batch") {
          batchCallCount++;
          // Malformed: missing an index entry (count mismatch)
          return { results: [{ index: 1, utility: 0.9, reason: "ok" }] };
        }
        standaloneCallCount++;
        return { utility: 0.5, reason: "standalone fallback" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(3));

    assert.equal(batchCallCount, 1, "expected one attempted batch call");
    assert.equal(standaloneCallCount, 3, "expected fallback to one standalone call per candidate");
    assert.equal(results.length, 3);
  });

  it("chunks batches larger than 10 candidates into multiple LLM calls", async () => {
    let batchCallCount = 0;
    const llm = {
      async completeJson(prompt, label) {
        if (label !== "admission-utility-batch") {
          throw new Error(`unexpected non-batch call in chunking test: ${label}`);
        }
        batchCallCount++;
        // Count how many "N. Category:" candidate lines this specific call's
        // prompt contains, so each chunk gets a correctly-sized response
        // (proving both chunks round-trip cleanly, with no fallback noise).
        const count = (prompt.match(/^\d+\. Category:/gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({ index: i + 1, utility: 0.5, reason: "r" })),
        };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    // 15 candidates should chunk into 10 + 5, i.e. two calls.
    const items = makeBatchItems(15);
    const results = await controller.evaluateBatch(items);

    assert.equal(results.length, 15);
    assert.equal(batchCallCount, 2, "expected 15 candidates to chunk into exactly 2 batch calls");
  });
});
