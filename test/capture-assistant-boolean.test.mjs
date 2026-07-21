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

  it("documents assistant blocks in the transcript format", () => {
    assert.ok(system.includes("wraps ONE reply written by the AI assistant"));
  });

  it("carries the attribution-aware eligible rule", () => {
    assert.ok(system.includes("eligible sources in this configuration"));
    assert.ok(system.includes("always attribute assistant-authored statements to the assistant, never to the user"));
  });

  it("switches the user-slot instruction too (the contradiction fix)", () => {
    assert.ok(user.includes("per the assistant-message rule"));
    assert.ok(!user.includes("Extract memory candidates ONLY from <user_message> blocks."));
  });

  it("drops the user-only grounding suffix", () => {
    assert.ok(!system.includes("Memories may only be grounded here."));
  });
});
