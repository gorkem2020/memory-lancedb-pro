/**
 * Regression test for reflection writer-1 (mapped rows) source
 * misclassification.
 *
 * parseSmartMetadata's missing-source fallback only mapped
 * "memory-reflection" / "memory-reflection-item" types to source
 * "reflection". Writer-1 mapped rows (buildReflectionMappedMetadata,
 * src/reflection-mapped-metadata.ts) carry type: "memory-reflection-mapped"
 * and write no source field at all, so every mapped row fell through to
 * "legacy" -- visible in the memory-consolidate source legend and anywhere
 * source is displayed or used.
 *
 * Fixtures are entirely synthetic -- no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { parseSmartMetadata } = jiti(path.join(testDir, "..", "src", "smart-metadata.ts"));
const { buildReflectionMappedMetadata } = jiti(path.join(testDir, "..", "src", "reflection-mapped-metadata.ts"));

describe("parseSmartMetadata: source classification for reflection writer-1 mapped rows", () => {
  it("classifies a memory-reflection-mapped row (no explicit source field) as source: reflection, not legacy", () => {
    const raw = JSON.stringify({
      type: "memory-reflection-mapped",
      l0_abstract: "Operator prefers streaming test reporters for long suites.",
    });

    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });

    assert.equal(meta.source, "reflection");
  });

  it("still classifies memory-reflection and memory-reflection-item types as source: reflection (unchanged)", () => {
    for (const type of ["memory-reflection", "memory-reflection-item"]) {
      const raw = JSON.stringify({ type, l0_abstract: "some fact" });
      const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
      assert.equal(meta.source, "reflection", `type=${type} should classify as reflection`);
    }
  });

  it("still classifies an unrecognized/absent type as source: legacy (unchanged)", () => {
    const raw = JSON.stringify({ l0_abstract: "some fact" });
    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
    assert.equal(meta.source, "legacy");
  });

  it("respects an explicit source field over type-based inference (unchanged)", () => {
    const raw = JSON.stringify({ type: "memory-reflection-mapped", source: "manual", l0_abstract: "some fact" });
    const meta = parseSmartMetadata(raw, { text: "fallback text", timestamp: 1_700_000_000_000 });
    assert.equal(meta.source, "manual");
  });

  it("knock-on: reclassifying a mapped row's source as reflection also changes its derived memory_layer to reflection instead of durable/working", () => {
    // deriveDefaultLayer(source, category, state) treats source: "reflection"
    // specially (memory_layer: "reflection"), which a source: "legacy" row
    // with the same category would never get. This pins the corrected,
    // intentional knock-on rather than leaving it as an untested side effect.
    const raw = JSON.stringify({
      type: "memory-reflection-mapped",
      l0_abstract: "Operator prefers streaming test reporters for long suites.",
    });

    const meta = parseSmartMetadata(raw, { text: "fallback text", category: "preference", timestamp: 1_700_000_000_000 });

    assert.equal(meta.memory_layer, "reflection");
  });
});

describe("buildReflectionMappedMetadata: stamps source at write time", () => {
  it("stamps source: reflection on newly-written mapped rows, complementing the read-path fallback for legacy rows", () => {
    const metadata = buildReflectionMappedMetadata({
      mappedItem: {
        text: "Operator prefers streaming test reporters for long suites.",
        category: "preference",
        heading: "User model deltas (about the human)",
        mappedKind: "user-model",
        ordinal: 1,
        groupSize: 1,
      },
      eventId: "event-1",
      agentId: "agent-1",
      sessionKey: "session-key-1",
      sessionId: "session-1",
      runAt: 1_700_000_000_000,
      usedFallback: false,
      toolErrorSignals: [],
    });

    assert.equal(metadata.source, "reflection");
  });
});
