import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createAdmissionController, normalizeAdmissionControlConfig, AdmissionController } =
  jiti("../src/admission-control.ts");

describe("createAdmissionController", () => {
  it("returns null when admission control is disabled", () => {
    const config = normalizeAdmissionControlConfig({ enabled: false });
    const controller = createAdmissionController({}, {}, config);
    assert.equal(controller, null);
  });

  it("returns a usable AdmissionController instance when enabled, without any extractor involved", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "off" });
    const store = {
      async vectorSearch() {
        return [];
      },
    };
    const llm = {};

    const controller = createAdmissionController(store, llm, config);

    assert.ok(controller instanceof AdmissionController);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "events",
        abstract: "user mentioned a fact",
        overview: "## Event",
        content: "the user mentioned a fact",
      },
      candidateVector: [],
      conversationText: "the user mentioned a fact today",
      scopeFilter: ["global"],
    });

    assert.ok(evaluation.decision === "reject" || evaluation.decision === "pass_to_dedup");
    assert.equal(evaluation.audit.version, "amac-v1");
  });

  // Live-fleet trace: llm-client.ts's completeJson() never throws on an HTTP
  // failure (e.g. a 400 from a bad model id) -- it catches internally and
  // resolves null. This pins the intended behavior for that contract: a null
  // utility response must not abort or throw the evaluation; it degrades to
  // a neutral utility score with an explicit, non-genuine reason string, and
  // the overall decision still comes from the other (non-LLM) features.
  it("degrades to a neutral utility score, not a thrown error, when the LLM client resolves null (e.g. an upstream request failure)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const store = {
      async vectorSearch() {
        return [];
      },
    };
    const llm = {
      async completeJson() {
        return null;
      },
    };

    const controller = createAdmissionController(store, llm, config);

    const evaluation = await controller.evaluate({
      candidate: {
        category: "profile",
        abstract: "User is a backend engineer",
        overview: "## Profile",
        content: "The user is a backend engineer.",
      },
      candidateVector: [],
      conversationText: "I've been doing backend engineering for years",
      scopeFilter: ["global"],
    });

    assert.equal(evaluation.audit.feature_scores.utility, 0.5, "utility score neutrally degrades, not zero/thrown");
    assert.equal(evaluation.audit.utility_reason, "Utility scoring unavailable");
    assert.ok(
      evaluation.audit.reason.includes("Utility scoring unavailable"),
      `expected the overall reason to surface the degraded utility call, got: ${evaluation.audit.reason}`,
    );
  });
});

// Live-fleet trace (terry, 2026-07-18): a session-scoped candidate the judge
// scored 0.2 ("not a durable fact") still passed the gate at composite 0.596
// because the preferences type prior (0.9 x 0.6 weight = 0.54) alone clears
// the 0.45 reject bar. The veto gives the judge a floor of authority.
describe("utility veto floor", () => {
  const store = {
    async vectorSearch() {
      return [];
    },
  };
  function llmScoring(utilityScore) {
    return {
      async completeJson() {
        return { utility: utilityScore, reason: "Session-specific; not a durable fact" };
      },
    };
  }
  const candidate = {
    category: "preferences",
    abstract: "User prefers no tool usage in this session",
    overview: "## Preference",
    content: "User asked for no tools during this session only",
  };
  const evaluateParams = {
    candidate,
    candidateVector: [0.1, 0.2, 0.3],
    conversationText: "please do not use any tools for the rest of this session",
    scopeFilter: ["global"],
  };

  it("rejects outright when the judge's utility is at or below the floor, even though the type prior carries the composite past reject", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    assert.equal(config.utilityVetoThreshold, 0.25, "presets default the veto floor to 0.25");
    const controller = createAdmissionController(store, llmScoring(0.2), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(evaluation.decision, "reject");
    assert.match(evaluation.audit.reason, /utility veto/i);
    assert.equal(evaluation.audit.thresholds.utilityVeto, 0.25);
  });

  it("leaves scores above the floor to the composite (which passes on the type prior)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = createAdmissionController(store, llmScoring(0.6), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(evaluation.decision, "pass_to_dedup");
    assert.doesNotMatch(evaluation.audit.reason, /utility veto/i);
  });

  it("utilityVetoThreshold: 0 disables the veto and restores composite-only gating", async () => {
    const config = normalizeAdmissionControlConfig({
      enabled: true,
      utilityMode: "standalone",
      utilityVetoThreshold: 0,
    });
    const controller = createAdmissionController(store, llmScoring(0.2), config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.equal(
      evaluation.decision,
      "pass_to_dedup",
      "with the veto off, the preferences type prior carries the composite past the reject bar",
    );
  });

  it("does not veto degraded utility calls (failure default 0.5 stays above the floor)", async () => {
    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const llm = {
      async completeJson() {
        return null;
      },
    };
    const controller = createAdmissionController(store, llm, config);
    const evaluation = await controller.evaluate(evaluateParams);
    assert.doesNotMatch(evaluation.audit.reason, /utility veto/i);
  });

  it("clamps config values into [0,1] and falls back to the preset default on junk", () => {
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: 5 }).utilityVetoThreshold, 1);
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: -2 }).utilityVetoThreshold, 0);
    assert.equal(normalizeAdmissionControlConfig({ utilityVetoThreshold: "junk" }).utilityVetoThreshold, 0.25);
  });
});
