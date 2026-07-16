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

// A conversation excerpt containing a marker that must never reach the
// admission judge: the operator decision is that admission scores candidates
// solely on what extraction provided, never on raw transcript text.
const TRANSCRIPT_MARKER = "TRANSCRIPT_MARKER_ZZZ_do_not_leak_into_admission_prompt";
const TRANSCRIPT_TEXT = `user: hey can you remember that I like ${TRANSCRIPT_MARKER}\nassistant: sure thing`;

describe("AdmissionController prompt shape: transcript-free", () => {
  it("standalone (evaluate): the utility prompt never contains the conversation excerpt", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") {
          capturedPrompt = prompt;
        }
        return { utility: 0.5, reason: "r" };
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluate({
      candidate: makeCandidate(1),
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: TRANSCRIPT_TEXT,
      scopeFilter: ["global"],
    });

    assert.ok(capturedPrompt, "expected a standalone admission-utility call");
    assert.doesNotMatch(capturedPrompt, new RegExp(TRANSCRIPT_MARKER));
    assert.doesNotMatch(capturedPrompt, /Conversation excerpt/i);
  });

  it("batch (evaluateBatch): the utility prompt never contains the conversation excerpt", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      {
        candidate: makeCandidate(1),
        candidateVector: [0.1, 0.2, 0.3],
        conversationText: TRANSCRIPT_TEXT,
        scopeFilter: ["global"],
      },
    ]);

    assert.ok(capturedPrompt, "expected a batch admission-utility call");
    assert.doesNotMatch(capturedPrompt, new RegExp(TRANSCRIPT_MARKER));
    assert.doesNotMatch(capturedPrompt, /Conversation excerpt/i);
  });

  it("standalone and batch prompts carry only the candidate's own three-level content plus category, nothing else source-related", async () => {
    // Guards against a *different* leak channel (a "source context" or
    // "session excerpt" field added later, not the conversationText param).
    const candidate = makeCandidate(7);
    let standalonePrompt;
    let batchPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility") standalonePrompt = prompt;
        if (label === "admission-utility-batch") {
          batchPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return { utility: 0.5, reason: "r" };
      },
    };

    const standaloneController = new AdmissionController(
      makeStore(),
      llm,
      normalizeAdmissionControlConfig({ enabled: true, utilityMode: "standalone" }),
    );
    await standaloneController.evaluate({
      candidate,
      candidateVector: [0.1, 0.2, 0.3],
      conversationText: TRANSCRIPT_TEXT,
      scopeFilter: ["global"],
    });

    const batchController = new AdmissionController(
      makeStore(),
      llm,
      normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" }),
    );
    await batchController.evaluateBatch([
      { candidate, candidateVector: [0.1, 0.2, 0.3], conversationText: TRANSCRIPT_TEXT, scopeFilter: ["global"] },
    ]);

    for (const prompt of [standalonePrompt, batchPrompt]) {
      assert.ok(prompt);
      assert.match(prompt, /candidate 7/);
      assert.match(prompt, /## Event 7/);
      assert.match(prompt, /the user did thing 7/);
      assert.doesNotMatch(prompt, /user:|assistant:/);
    }
  });
});

describe("AdmissionController prompt shape: batch formatting standard", () => {
  it("separates candidates in the live batch with a blank line, not a bare newline", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return {
            results: [
              { index: 1, utility: 0.5, reason: "r1" },
              { index: 2, utility: 0.5, reason: "r2" },
            ],
          };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(1), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
      { candidate: makeCandidate(2), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    // Candidate 1's last field (Content) must be followed by a blank line
    // before candidate 2's numbered line, not run together with a single \n.
    assert.match(capturedPrompt, /the user did thing 1\n\n2\. Category:/);
  });

  it("indents each candidate's multi-line fields consistently under its numbered line", async () => {
    let capturedPrompt;
    const llm = {
      async completeJson(prompt, label) {
        if (label === "admission-utility-batch") {
          capturedPrompt = prompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(9), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedPrompt);
    assert.match(capturedPrompt, /^1\. Category: events$/m);
    assert.match(capturedPrompt, /^ {3}Abstract: candidate 9$/m);
    assert.match(capturedPrompt, /^ {3}Overview: ## Event 9$/m);
    assert.match(capturedPrompt, /^ {3}Content: the user did thing 9$/m);
  });

  it("separates the few-shot example's own logical blocks (header, each candidate, response, closing note) with blank lines", async () => {
    let capturedSystemPrompt;
    const llm = {
      async completeJson(prompt, label, systemPrompt) {
        if (label === "admission-utility-batch") {
          capturedSystemPrompt = systemPrompt;
          return { results: [{ index: 1, utility: 0.5, reason: "r" }] };
        }
        return null;
      },
    };

    const config = normalizeAdmissionControlConfig({ enabled: true, utilityMode: "batch" });
    const controller = new AdmissionController(makeStore(), llm, config);

    await controller.evaluateBatch([
      { candidate: makeCandidate(1), candidateVector: [0.1], conversationText: "x", scopeFilter: ["global"] },
    ]);

    assert.ok(capturedSystemPrompt);
    // "Candidates:" header separated by a blank line from the first example candidate.
    assert.match(capturedSystemPrompt, /Candidates:\n\n1\. Category: preferences/);
    // Blank line between each example candidate.
    assert.match(capturedSystemPrompt, /Alex"\n\n2\. Category: events/);
    assert.match(capturedSystemPrompt, /hello"\n\n3\. Category: entities/);
    // Blank line between the last example candidate and the "Example response:" label.
    assert.match(capturedSystemPrompt, /datastore"\n\nExample response:/);
    // Blank line between the example response JSON and the closing explanatory note.
    assert.match(capturedSystemPrompt, /durable project\/entity fact"\}\]\}\n\nCandidate 2 scores low/);
  });
});
