import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

function buildRegisteredProgram() {
  const { createMemoryCLI } = jiti(path.join(testDir, "..", "cli.ts"));
  const program = new Command();
  const stubContext = {
    store: {},
    retriever: {},
    scopeManager: {},
    migrator: {},
  };
  createMemoryCLI(stubContext)({ program });
  return program;
}

describe("cli subcommand attachment", () => {
  it("only registers memory-pro on the root program; every other command lives under the group", () => {
    const program = buildRegisteredProgram();

    const rootNames = program.commands.map((c) => c.name());
    assert.deepEqual(
      rootNames,
      ["memory-pro"],
      `the root commander program must expose exactly one command (memory-pro); got: ${rootNames.join(", ")}`
    );
  });

  it("makes reindex-fts reachable as memory-pro reindex-fts", () => {
    const program = buildRegisteredProgram();
    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group must be registered");

    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("reindex-fts"),
      `expected "reindex-fts" under the memory-pro group, got: ${groupNames.join(", ")}`
    );
  });

  it("makes repair-summaries reachable as memory-pro repair-summaries", () => {
    const program = buildRegisteredProgram();
    const memoryPro = program.commands.find((c) => c.name() === "memory-pro");
    assert.ok(memoryPro, "memory-pro group must be registered");

    const groupNames = memoryPro.commands.map((c) => c.name());
    assert.ok(
      groupNames.includes("repair-summaries"),
      `expected "repair-summaries" under the memory-pro group, got: ${groupNames.join(", ")}`
    );
  });
});
