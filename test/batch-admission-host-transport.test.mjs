/**
 * Assembly-level composition test: batch admission utility scoring (D2,
 * feat/admission-batch-utility) must work identically over the host-managed
 * runtime LLM transport (feat/runtime-llm-completions), not just the direct
 * OpenAI-compatible client. Exercises the real createLlmClient() seam rather
 * than a hand-rolled mock LlmClient, so a regression in either transport's
 * completeJson() implementation, or in how AdmissionController builds/parses
 * the batch prompt, would surface here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");
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

describe("Batch admission utility scoring over the host transport", () => {
  it("routes a batch of 3 candidates through runtime.llm.complete with exactly one call, capturing the core-style model unmodified", async () => {
    const hostCalls = [];
    const runtimeLlmComplete = async (params) => {
      hostCalls.push(params);
      return {
        text: JSON.stringify({
          results: [
            { index: 1, utility: 0.9, reason: "durable" },
            { index: 2, utility: 0.05, reason: "chatter" },
            { index: 3, utility: 0.5, reason: "middling" },
          ],
        }),
      };
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/anthropic/claude-opus-4-8",
      runtimeLlmComplete,
    });

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(3));

    assert.equal(hostCalls.length, 1, "expected exactly one host-transport call for the whole batch");
    assert.equal(
      hostCalls[0].model,
      "openrouter/anthropic/claude-opus-4-8",
      "the core-style model reference must reach the host transport unmodified (no direct-path prefix-strip)",
    );
    assert.equal(hostCalls[0].purpose, "memory-lancedb-pro:admission-utility-batch");

    assert.equal(results.length, 3);
    assert.equal(results[0].audit.feature_scores.utility, 0.9);
    assert.equal(results[1].audit.feature_scores.utility, 0.05);
    assert.equal(results[2].audit.feature_scores.utility, 0.5);
  });

  it("degrades to standalone per-candidate fail-open scoring when the host transport call throws mid-batch", async () => {
    const runtimeLlmComplete = async () => {
      throw new Error("simulated host outage");
    };

    const llm = createLlmClient({
      transport: "host",
      model: "openrouter/anthropic/claude-opus-4-8",
      runtimeLlmComplete,
      warnLog: () => {},
    });

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    const results = await controller.evaluateBatch(makeBatchItems(2));

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.audit.utility_reason, "Utility scoring unavailable");
      assert.equal(result.audit.feature_scores.utility, 0.5);
    }
  });
});
