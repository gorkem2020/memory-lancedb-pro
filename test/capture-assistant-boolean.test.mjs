/**
 * captureAssistant boolean revert (2026-07-21): the knob is true/false again,
 * matching the upstream design ("Also auto-capture assistant messages,
 * default false to reduce memory pollution").
 *
 *   false (default)  -> assistant lines are fully excluded from the capture
 *                       transcript and the extraction gate; the prompt
 *                       carries no <assistant_message> language at all.
 *   true             -> assistant lines join the tagged transcript as
 *                       ELIGIBLE grounding sources and count toward the
 *                       gate; the prompt carries the attribution-aware
 *                       eligible rule in BOTH the system rule list and the
 *                       user-slot instruction (the 2026-07-21 contradiction
 *                       fix: the user-slot line used to stay user-only).
 *
 * The retired third value "context" coerces to false at config parse so
 * legacy fleet configs fail safe instead of failing validation.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildExtractionPrompt } = jiti("../src/extraction-prompts.ts");
const { parsePluginConfig } = jiti("../index.ts");

const BASE = { embedding: { apiKey: "test-key", model: "nomic-embed-text" } };

describe("config parse", () => {
  it("passes booleans through", () => {
    assert.equal(parsePluginConfig({ ...BASE, captureAssistant: true }).captureAssistant, true);
    assert.equal(parsePluginConfig({ ...BASE, captureAssistant: false }).captureAssistant, false);
  });

  it("defaults to false when absent", () => {
    assert.equal(parsePluginConfig({ ...BASE }).captureAssistant, false);
  });

  it("coerces the retired \"context\" value to false", () => {
    assert.equal(parsePluginConfig({ ...BASE, captureAssistant: "context" }).captureAssistant, false);
  });

  it("coerces other junk values to false", () => {
    assert.equal(parsePluginConfig({ ...BASE, captureAssistant: "true" }).captureAssistant, false);
    assert.equal(parsePluginConfig({ ...BASE, captureAssistant: 1 }).captureAssistant, false);
  });
});

describe("prompt under captureAssistant=false (default)", () => {
  const { system, user } = buildExtractionPrompt("<user_message>\nhello\n</user_message>", "User");

  it("carries no assistant-block language anywhere", () => {
    assert.ok(!system.includes("<assistant_message>"));
    assert.ok(!user.includes("<assistant_message> blocks are context"));
  });

  it("keeps the user-only grounding contract", () => {
    assert.ok(system.includes("Memories may only be grounded here."));
    assert.ok(user.includes("Extract memory candidates ONLY from <user_message> blocks."));
  });
});

describe("prompt under captureAssistant=true", () => {
  const { system, user } = buildExtractionPrompt(
    "<user_message>\nhello\n</user_message>\n<assistant_message>\nhi there\n</assistant_message>",
    "User",
    { assistantEligible: true },
  );

  it("documents assistant blocks in the transcript format, without the authorship over-explanation", () => {
    assert.ok(system.includes("wraps ONE message written by the AI assistant"));
    assert.ok(!system.includes("Every line inside it"));
  });

  it("carries the simplified source and attribution rules", () => {
    assert.ok(system.includes("also valid sources — but only for concrete facts the user did not correct"));
    assert.ok(system.includes("Attribute every memory to whoever actually said it"));
    assert.ok(system.includes("use the <user_message> version"));
  });

  it("switches the user-slot instruction too (the contradiction fix)", () => {
    assert.ok(user.includes("attributed to their true speaker"));
    assert.ok(!user.includes("Extract memory candidates ONLY from <user_message> blocks."));
  });

  it("drops the user-only grounding suffix", () => {
    assert.ok(!system.includes("Memories may only be grounded here."));
  });
});

describe("user-half layout (both modes)", () => {
  it("places the extraction instruction ABOVE the Recent Conversation header, not under it", () => {
    for (const opts of [{}, { assistantEligible: true }]) {
      const { user } = buildExtractionPrompt("<user_message>\nhi\n</user_message>", "User", opts);
      const instruction = user.indexOf("Extract memory candidates");
      const header = user.indexOf("## Recent Conversation");
      assert.ok(instruction >= 0 && header >= 0 && instruction < header,
        "instruction must precede the header so it cannot read as conversation content");
    }
  });

  it("never emits the generic 'User: User' line", () => {
    const { user } = buildExtractionPrompt("t", "User");
    assert.ok(!user.includes("User: User"));
  });

  it("emits a name line only when a real name is configured", () => {
    const { user } = buildExtractionPrompt("t", "Alex");
    assert.ok(user.startsWith("User: Alex"));
  });

  it("avoids the overloaded 'conversation in the user message' phrasing", () => {
    const { system } = buildExtractionPrompt("t", "User");
    assert.ok(!system.includes("conversation in the user message"));
    assert.ok(system.includes("The conversation is a sequence of tagged blocks"));
  });
});
