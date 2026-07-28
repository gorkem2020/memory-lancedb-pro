// Wiring pin for lane-affine admission at the index.ts call sites.
//
// The plugin builds TWO admission controllers: the extraction/global one and
// admissionControllerReflectionLane (bound to memoryReflection.model when
// admissionControl.modelAffinity === "lane"). The reflection mapped-row gate
// must route through the lane controller; the regex-fallback capture gate
// (extraction lane) must NOT. This contract lives in argument plumbing that
// no unit below index.ts can observe — a 2026-07-28 deploy-branch merge
// reconciliation dropped exactly this argument and every runtime suite stayed
// green while live admission calls silently fell back to the global model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import jitiFactory from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "index.ts"), "latin1");

function callBlock(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `call site not found: ${marker}`);
  const close = source.indexOf("});", at);
  assert.notEqual(close, -1, `unterminated call block: ${marker}`);
  return source.slice(at, close);
}

describe("reflection-lane admission wiring (index.ts call sites)", () => {
  it("routes mapped-row admission through the reflection-lane controller", () => {
    const block = callBlock(indexSource, "gateMappedReflectionEntries({");
    assert.match(
      block,
      /admissionController:\s*resolveMappedRowAdmissionController\(\s*admissionControllerReflectionLane,/,
      "mapped-row gate must resolve its controller from the reflection lane; " +
        "passing the extractor's global controller silently re-binds reflection " +
        "admission to the global model under modelAffinity=lane",
    );
  });

  it("keeps regex-fallback capture on the extraction-lane controller", () => {
    const block = callBlock(indexSource, "gateRegexFallbackCapture({");
    assert.doesNotMatch(
      block,
      /admissionControllerReflectionLane/,
      "fallback captures are extraction-lane work and must stay on the global controller",
    );
    assert.match(block, /admissionController:\s*smartExtractor\?\.getAdmissionController\(\) \?\? null,/);
  });
});

describe("resolveMappedRowAdmissionController", () => {
  const jiti = jitiFactory(import.meta.url, { interopDefault: true });
  const { resolveMappedRowAdmissionController } = jiti("../index.ts");

  it("prefers the reflection-lane controller when one exists", () => {
    const lane = { tag: "lane" };
    const global = { tag: "global" };
    assert.equal(resolveMappedRowAdmissionController(lane, global), lane);
  });

  it("falls back to the global controller when no lane controller was built", () => {
    const global = { tag: "global" };
    assert.equal(resolveMappedRowAdmissionController(null, global), global);
  });

  it("returns null when admission control is disabled everywhere", () => {
    assert.equal(resolveMappedRowAdmissionController(null, null), null);
  });
});
