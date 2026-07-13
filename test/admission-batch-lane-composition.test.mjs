import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createAdmissionController, normalizeAdmissionControlConfig, resolveAdmissionModel } =
  jiti("../src/admission-control.ts");

// Exercises the composed feature the W2 brief called out explicitly: batch
// utility scoring (D2) combined with lane model affinity (D3). Production
// wiring resolves each lane's model in index.ts (see
// admission-lane-model-affinity.test.mjs for that layer) and hands the
// resulting client to createAdmissionController; this test picks up from
// there and proves that a reflection-lane controller, evaluated in batch
// mode, issues exactly one LLM call for a whole reset's worth of mapped
// rows, using the reflection-sourced excerpt heading -- i.e. "one batch
// judgment on the reflection model per reset".

function makeStore() {
  return {
    async vectorSearch() {
      return [];
    },
  };
}

function makeMappedRowCandidate(n) {
  return {
    category: "cases",
    abstract: `lesson ${n}`,
    overview: `## Lesson\n- distilled point ${n}`,
    content: `the agent learned lesson ${n} from this session`,
  };
}

function makeCapturingLlm(boundModel) {
  const calls = [];
  return {
    boundModel,
    calls,
    async completeJson(user, label, system) {
      calls.push({ user, label, system, model: boundModel });
      if (label === "admission-utility-batch") {
        const count = (user.match(/^\d+\. Category:/gm) || []).length;
        return {
          results: Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            utility: 0.75,
            reason: `reflection-lane batch reason ${i + 1}`,
          })),
        };
      }
      return null;
    },
  };
}

describe("batch utility + lane model affinity composition", () => {
  it("resolves the reflection lane to the memoryReflection model, then batches a whole reset's mapped rows in one call on that model", async () => {
    const admissionControl = normalizeAdmissionControlConfig({
      enabled: true,
      utilityMode: "batch",
      modelAffinity: "lane",
    });

    // Step 1: lane model resolution (what index.ts does before constructing
    // each lane's client -- see admission-lane-model-affinity.test.mjs for
    // the full index.ts-level wiring test).
    const reflectionModel = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-distiller-model",
    });
    assert.equal(reflectionModel, "reflection-distiller-model");

    // Step 2: the reflection-lane controller is bound to that model's client.
    const reflectionLaneLlm = makeCapturingLlm(reflectionModel);
    const admissionControllerReflectionLane = createAdmissionController(
      makeStore(),
      reflectionLaneLlm,
      admissionControl,
    );

    // Step 3: one reset's worth of mapped reflection rows, batched together.
    const items = [1, 2, 3].map((n) => ({
      candidate: makeMappedRowCandidate(n),
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: "shared reflection distillate text for this reset",
      scopeFilter: ["global"],
      sourceKind: "reflection",
    }));

    const evaluations = await admissionControllerReflectionLane.evaluateBatch(items);

    assert.equal(evaluations.length, 3);
    assert.equal(reflectionLaneLlm.calls.length, 1, "expected exactly one batch call for the whole reset");
    const [call] = reflectionLaneLlm.calls;
    assert.equal(call.model, "reflection-distiller-model");
    assert.match(call.user, /Source document \(agent reflection\):/);

    const utilities = evaluations.map((e) => e.audit.feature_scores.utility);
    assert.deepEqual(utilities, [0.75, 0.75, 0.75]);
    const reasons = evaluations.map((e) => e.audit.utility_reason);
    assert.deepEqual(reasons, [
      "reflection-lane batch reason 1",
      "reflection-lane batch reason 2",
      "reflection-lane batch reason 3",
    ]);
  });

  it("keeps the extraction/fallback lane on the global model and the conversation heading, independent of the reflection lane's batch call", async () => {
    const admissionControl = normalizeAdmissionControlConfig({
      enabled: true,
      utilityMode: "batch",
      modelAffinity: "lane",
    });

    const otherModel = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-distiller-model",
    });
    assert.equal(otherModel, "global-model");

    const otherLaneLlm = makeCapturingLlm(otherModel);
    const admissionController = createAdmissionController(makeStore(), otherLaneLlm, admissionControl);

    const items = [1, 2].map((n) => ({
      candidate: makeMappedRowCandidate(n),
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: "shared extraction conversation text",
      scopeFilter: ["global"],
      // sourceKind omitted -- extraction/fallback lane defaults to "conversation"
    }));

    const evaluations = await admissionController.evaluateBatch(items);

    assert.equal(evaluations.length, 2);
    assert.equal(otherLaneLlm.calls.length, 1);
    const [call] = otherLaneLlm.calls;
    assert.equal(call.model, "global-model");
    assert.match(call.user, /Conversation excerpt:/);
    assert.doesNotMatch(call.user, /Source document \(agent reflection\)/);
  });
});
