/**
 * Manual memory_store lane: always-store supersede semantics.
 *
 * Design ruling: a manual store ALWAYS takes priority. It skips the admission
 * judge, and dedup treats it "in a different way": when a similar memory
 * exists, the OLD row is superseded/invalidated by the manual one, and the
 * manual text is ALWAYS stored verbatim, never mutated and never dropped.
 *
 * Supersede triggers with `manualStoreSupersede: true` (deterministic, no
 * LLM on this lane):
 *   1. near-identical neighbor (similarity > 0.98) — previously a reject;
 *   2. fact-key collision with an active neighbor at any similarity — the
 *      contradiction/update shape ("favorite drink: tea" vs the cola row);
 *   3. the existing 0.95-0.98 same-category versioned band (unchanged).
 * Anything else creates alongside: a wrong supersede destroys a real fact,
 * a duplicate is fixable noise, so the gray zone stays on the safe side.
 *
 * With the knob off (upstream default) the lane behaves exactly as before,
 * including the > 0.98 duplicate reject.
 *
 * Fixtures are entirely synthetic; no real fleet data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerAllMemoryTools } = jiti("../src/tools.ts");

function createToolSet(context) {
  const creators = new Map();
  const api = {
    registerTool(factory, meta) {
      creators.set(meta.name, factory);
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
  registerAllMemoryTools(api, context, { enableManagementTools: true });
  return {
    get(name) {
      const factory = creators.get(name);
      assert.ok(factory, `tool ${name} should be registered`);
      return factory({});
    },
  };
}

function neighborRow({ id = "old-1", text, category = "preference", score, factKey, memoryCategory = "preferences" }) {
  return {
    entry: {
      id,
      text,
      category,
      scope: "agent:main",
      importance: 0.7,
      timestamp: Date.now() - 60_000,
      metadata: JSON.stringify({
        memory_category: memoryCategory,
        l0_abstract: text,
        l1_overview: `- ${text}`,
        l2_content: text,
        source: "auto-capture",
        state: "confirmed",
        ...(factKey ? { fact_key: factKey } : {}),
      }),
    },
    score,
  };
}

function makeContext({ neighbors = [], rows, manualStoreSupersede } = {}) {
  const storedEntries = [];
  const patchCalls = [];
  // Production-shaped store double: vectorSearch honors the caller's limit and
  // minScore exactly like the real store, and list() pages over ALL rows the
  // store holds (`rows` defaults to the vector neighbors' entries).
  const allRows = rows ?? neighbors.map((neighbor) => neighbor.entry);
  const context = {
    agentId: "main",
    workspaceDir: "/tmp",
    mdMirror: null,
    ...(manualStoreSupersede === undefined ? {} : { manualStoreSupersede }),
    scopeManager: {
      getAccessibleScopes: (agentId) => ["global", `agent:${agentId}`],
      getScopeFilter: (agentId) => ["global", `agent:${agentId}`],
      isAccessible: (scope, agentId) => ["global", `agent:${agentId}`].includes(scope),
      getDefaultScope: (agentId) => `agent:${agentId}`,
    },
    retriever: {
      getConfig() {
        return { mode: "hybrid" };
      },
    },
    store: {
      async vectorSearch(vector, limit = 5, minScore = 0.3) {
        return neighbors
          .filter((neighbor) => neighbor.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      async list(scopeFilter, category, limit = 100, offset = 0) {
        return allRows.slice(offset, offset + limit);
      },
      async store(entry) {
        const stored = { ...entry, id: `new-${storedEntries.length + 1}`, timestamp: Date.now() };
        storedEntries.push(stored);
        return stored;
      },
      async patchMetadata(id, patch, scopeFilter) {
        patchCalls.push({ id, patch, scopeFilter });
        return null;
      },
    },
    embedder: {
      async embedPassage() {
        return [0.1, 0.2, 0.3];
      },
    },
  };
  return { context, storedEntries, patchCalls };
}

describe("manual memory_store always-store supersede semantics", () => {
  it("supersedes instead of rejecting when a near-identical memory exists (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Coca-Cola", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: Coca-Cola Zero";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "a near-identical manual store must land as a supersede, never a reject");
    assert.equal(storedEntries.length, 1, "the manual row must always be stored");
    assert.equal(storedEntries[0].text, input, "the manual text must be stored verbatim, never mutated");
    assert.equal(patchCalls.length, 1, "the old row must be invalidated");
    assert.equal(patchCalls[0].id, "old-1");
    assert.ok(patchCalls[0].patch.invalidated_at > 0);
    assert.equal(patchCalls[0].patch.superseded_by, storedEntries[0].id ?? "new-1");
  });

  it("supersedes on a fact-key collision even at low vector similarity (contradiction shape, knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Coca-Cola", score: 0.8, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded", "a same-fact-key update must supersede the old value");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input, "the manual text must be stored verbatim");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-1");
  });

  it("creates alongside when the neighbor is similar but a different fact (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite food: lahmacun", score: 0.85, factKey: "preferences:favorite food" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: tea";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "created", "a different fact must not be invalidated, however vector-close");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input);
    assert.equal(patchCalls.length, 0, "no supersede may fire for an unrelated fact");
  });

  it("force still bypasses the supersede path entirely (knob on)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink: Coca-Cola", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: Coca-Cola", category: "preference", force: true });

    assert.equal(res.details.action, "created", "force stores alongside without touching the old row");
    assert.equal(storedEntries.length, 1);
    assert.equal(patchCalls.length, 0);
  });

  it("keeps the upstream duplicate reject when the knob is off (compat default)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      neighbors: [neighborRow({ text: "favorite drink: Coca-Cola", score: 0.99, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: Coca-Cola", category: "preference" });

    assert.equal(res.details.action, "duplicate", "knob off must preserve the upstream duplicate check exactly");
    assert.equal(storedEntries.length, 0);
    assert.equal(patchCalls.length, 0);
  });

  it("supersedes a same-key row the vector top-K cannot see (ranked behind three closer unrelated neighbors)", async () => {
    const staleKeyRow = neighborRow({ id: "old-key", text: "favorite drink: Coca-Cola", score: 0.5, factKey: "preferences:favorite drink" });
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [
        neighborRow({ id: "near-1", text: "favorite snack: simit", score: 0.92, factKey: "preferences:favorite snack" }),
        neighborRow({ id: "near-2", text: "favorite dessert: baklava", score: 0.91, factKey: "preferences:favorite dessert" }),
        neighborRow({ id: "near-3", text: "favorite fruit: fig", score: 0.9, factKey: "preferences:favorite fruit" }),
        staleKeyRow,
      ],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded", "the stale same-key row must be found even when it ranks fourth");
    assert.equal(patchCalls.length, 1, "only the same-key row may be invalidated");
    assert.equal(patchCalls[0].id, "old-key");
    assert.equal(storedEntries.length, 1);
  });

  it("supersedes a same-key row that falls below the vector similarity floor", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ id: "old-faint", text: "favorite drink: Coca-Cola", score: 0.05, factKey: "preferences:favorite drink" })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded", "the similarity floor must not hide a same-key collision");
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].id, "old-faint");
    assert.equal(storedEntries.length, 1);
  });

  it("supersedes EVERY active same-key row, not just the first match", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [
        neighborRow({ id: "old-a", text: "favorite drink: Coca-Cola", score: 0.6, factKey: "preferences:favorite drink" }),
        neighborRow({ id: "old-b", text: "favorite drink: ayran", score: 0.55, factKey: "preferences:favorite drink" }),
      ],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.deepEqual([...res.details.supersededIds].sort(), ["old-a", "old-b"], "every active same-key row must be reconciled");
    assert.equal(patchCalls.length, 2, "both stale rows must be invalidated");
    assert.deepEqual(patchCalls.map((call) => call.id).sort(), ["old-a", "old-b"]);
    assert.equal(storedEntries.length, 1, "exactly one new row carries the manual value");
  });

  it("ignores already-invalidated same-key rows (history must not be re-superseded)", async () => {
    const invalidated = neighborRow({ id: "old-history", text: "favorite drink: salep", score: 0.6, factKey: "preferences:favorite drink" });
    const meta = JSON.parse(invalidated.entry.metadata);
    meta.invalidated_at = Date.now() - 1_000;
    invalidated.entry.metadata = JSON.stringify(meta);
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [invalidated],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const res = await store.execute(null, { text: "favorite drink: tea", category: "preference" });

    assert.equal(res.details.action, "created", "a historical superseded row is not an active collision");
    assert.equal(patchCalls.length, 0);
    assert.equal(storedEntries.length, 1);
  });

  it("keeps the existing 0.95-0.98 same-category band superseding with the knob on (no regression)", async () => {
    const { context, storedEntries, patchCalls } = makeContext({
      manualStoreSupersede: true,
      neighbors: [neighborRow({ text: "favorite drink is Coca-Cola for sure", score: 0.96 })],
    });
    const tools = createToolSet(context);
    const store = tools.get("memory_store");

    const input = "favorite drink: Coca-Cola Zero";
    const res = await store.execute(null, { text: input, category: "preference" });

    assert.equal(res.details.action, "superseded");
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].text, input);
    assert.equal(patchCalls.length, 1);
  });
});
