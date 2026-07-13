import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveAdmissionModel, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");

describe("resolveAdmissionModel", () => {
  it("defaults to the global model for both lanes when modelAffinity is absent", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "global-model");
    assert.equal(reflection, "global-model");
  });

  it("routes the reflection lane to the memoryReflection model when modelAffinity is 'lane'", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "global-model", "extraction/fallback lane stays on the global model");
    assert.equal(reflection, "reflection-model", "reflection lane resolves to the memoryReflection model");
  });

  it("falls back to the global model on the reflection lane when no memoryReflection model is configured", () => {
    const admissionControl = normalizeAdmissionControlConfig({ enabled: true, modelAffinity: "lane" });

    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: undefined,
    });

    assert.equal(reflection, "global-model");
  });

  it("lets an explicit admissionControl.model override beat lane affinity on both lanes", () => {
    const admissionControl = normalizeAdmissionControlConfig({
      enabled: true,
      modelAffinity: "lane",
      model: "explicit-override-model",
    });

    const other = resolveAdmissionModel({
      admissionControl,
      lane: "other",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });
    const reflection = resolveAdmissionModel({
      admissionControl,
      lane: "reflection",
      globalModel: "global-model",
      reflectionModel: "reflection-model",
    });

    assert.equal(other, "explicit-override-model");
    assert.equal(reflection, "explicit-override-model");
  });
});
