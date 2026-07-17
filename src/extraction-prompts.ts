/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 *
 * Each builder returns a {system, user} pair: instructions, criteria,
 * identity, and the output-format contract live in `system`; the per-call
 * conversation excerpt / candidate rows / neighbor rows live in `user`.
 *
 * Batched variants (one LLM call per pipeline stage):
 * - buildBatchDedupPrompt: one dedup decision per numbered candidate
 * - buildBatchMergePrompt: one merged record per numbered merge job
 */

import type { CandidateMemory } from "./memory-categories.js";

export interface SplitPrompt {
  system: string;
  user: string;
}

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): SplitPrompt {
  const system = `You are an extraction agent. Analyze session context and extract memories worth long-term preservation.

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to this user, not general domain knowledge
- Long-term validity: Information that will still be useful in future sessions
- Specific and clear: Has concrete details, not vague generalizations

## What is NOT worth remembering?
- General knowledge that anyone would know
- System/platform metadata: message IDs, sender IDs, timestamps, channel info, JSON envelopes (e.g. "System: [timestamp] Feishu...", "message_id", "sender_id", "ou_xxx") — these are infrastructure noise, NEVER extract them
- Temporary information: One-time questions or conversations
- Vague information: "User has questions about a feature" (no specific details)
- Tool output, error logs, or boilerplate
- Runtime scaffolding or orchestration wrappers such as "[Subagent Context]", "[Subagent Task]", bootstrap wrappers, task envelopes, or agent instructions — these are execution metadata, NEVER store them as memories
- Recall queries / meta-questions: "Do you remember X?", "你还记得X吗?", "你知道我喜欢什么吗" — these are retrieval requests, NOT new information to store
- Degraded or incomplete references: If the user mentions something vaguely ("that thing I said"), do NOT invent details or create a hollow memory
- Raw conversation carryover: quoted or attributed transcript blocks, especially 3+ lines of speaker text, are not memories by themselves. Distill a concrete fact/preference/decision/entity from them or skip.
- System/runtime artifacts: content containing "System:", compaction notices, model-switch/session-reset traces, tool-call transcripts, raw JSON blobs, or similar internal execution traces must be rejected unless a clean user fact can be extracted.
- Fragment blobs: mixed filename shards, code snippets, metadata fields, or partial sentences that look like unprocessed context fragments should be skipped rather than preserved.
- Assistant lines: in the Recent conversation turns transcript, "Assistant:" lines are provided only to help you understand what the user is referring to (e.g. "yes exactly, that one"). Do NOT create a candidate whose only support is an assistant line — every candidate must be grounded in a user-authored line.
- Atomic memory shape: each stored memory must read like one durable fact, preference, decision, entity state, event, case, or reusable pattern. If a candidate reads like an excerpt, log, or raw transcript, compress it into one atomic statement or skip it.
- Length/distillation gate: if a candidate is longer than about 200 characters and reads like raw conversation instead of a distilled insight, rewrite it as a single factual statement before storing; if that is not possible, skip it.

# Memory Classification

## Core Decision Logic

| Question | Answer | Category |
|----------|--------|----------|
| Who is the user? | Identity, attributes | profile |
| What does the user prefer? | Preferences, habits | preferences |
| What is this thing? | Person, project, organization | entities |
| What happened? | Decision, milestone | events |
| How was it solved? | Problem + solution | cases |
| What is the process? | Reusable steps | patterns |

## Precise Definition

**profile** - User identity (static attributes). Test: "User is..."
**preferences** - User preferences (tendencies). Test: "User prefers/likes..."
**entities** - Continuously existing nouns. Test: "XXX's state is..."
**events** - Things that happened. Test: "XXX did/completed..."
**cases** - Problem + solution pairs. Test: Contains "problem -> solution"
**patterns** - Reusable processes. Test: Can be used in "similar situations"

## Common Confusion
- "Plan to do X" -> events (action, not entity)
- "Project X status: Y" -> entities (describes entity)
- "User prefers X" -> preferences (not profile)
- "Encountered problem A, used solution B" -> cases (not events)
- "General process for handling certain problems" -> patterns (not cases)
- "Switched my commute to the M4" / "Spanish lesson before breakfast" -> preferences or patterns, not events: recurring or durable state and habit changes are the user's new normal, not a one-off occurrence. Reserve events for genuinely one-off happenings.

# Three-Level Structure

Each memory contains three levels:

**abstract (L0)**: One-liner index
- Merge types (preferences/entities/profile/patterns): \`[Merge key]: [Description]\`
- Independent types (events/cases): Specific description

**overview (L1)**: Structured Markdown summary with category-specific headings

**content (L2)**: Full narrative with background and details

# Few-shot Examples

## profile
\`\`\`json
{
  "category": "profile",
  "abstract": "User basic info: AI development engineer, 3 years LLM experience",
  "overview": "## Background\\n- Occupation: AI development engineer\\n- Experience: 3 years LLM development\\n- Tech stack: Python, LangChain",
  "content": "User is an AI development engineer with 3 years of LLM application development experience."
}
\`\`\`

## preferences
\`\`\`json
{
  "category": "preferences",
  "abstract": "Python code style: No type hints, concise and direct",
  "overview": "## Preference Domain\\n- Language: Python\\n- Topic: Code style\\n\\n## Details\\n- No type hints\\n- Concise function comments\\n- Direct implementation",
  "content": "User prefers Python code without type hints, with concise function comments."
}
\`\`\`

## cases
\`\`\`json
{
  "category": "cases",
  "abstract": "LanceDB BigInt numeric handling issue",
  "overview": "## Problem\\nLanceDB 0.26+ returns BigInt for numeric columns\\n\\n## Solution\\nCoerce values with Number(...) before arithmetic",
  "content": "When LanceDB returns BigInt values, wrap them with Number() before doing arithmetic operations."
}
\`\`\`

# Output Format

Return JSON:
{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "One-line index",
      "overview": "Structured Markdown summary",
      "content": "Full narrative"
    }
  ]
}

Notes:
- Output language should match the dominant language in the conversation
- Only extract truly valuable personalized information
- If nothing worth recording, return {"memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic`;

  const userMessage = `User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
Context for extraction. Extract memory candidates ONLY from user turns. Assistant turns are included so you can resolve references and understand what the user meant; never treat assistant statements as the user's facts, preferences, or decisions.
${conversationText}`;

  return { system, user: userMessage };
}

export function buildDedupPrompt(
  candidateAbstract: string,
  candidateOverview: string,
  candidateContent: string,
  existingMemories: string,
): SplitPrompt {
  const system = `You are a dedup decider. Determine how to handle a candidate memory relative to existing similar memories.

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON format:
{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;

  const userMessage = `**Candidate Memory**:
Abstract: ${candidateAbstract}

Overview:
${candidateOverview}

Content:
${candidateContent}

**Existing Similar Memories**:
${existingMemories}`;

  return { system, user: userMessage };
}

export function buildMergePrompt(
  existingAbstract: string,
  existingOverview: string,
  existingContent: string,
  newAbstract: string,
  newOverview: string,
  newContent: string,
  category: string,
): SplitPrompt {
  const system = `You are a merge writer. Merge two versions of the same memory into a single coherent record with all three levels.

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers, URIs, and model names unchanged when they are proper nouns

Return JSON:
{
  "abstract": "Merged one-line abstract",
  "overview": "Merged structured Markdown overview",
  "content": "Merged full content"
}`;

  const userMessage = `Category: ${category}

Existing Memory:
Abstract: ${existingAbstract}

Overview:
${existingOverview}

Content:
${existingContent}

New Information:
Abstract: ${newAbstract}

Overview:
${newOverview}

Content:
${newContent}`;

  return { system, user: userMessage };
}

/**
 * Formats one labelled field for a numbered prompt block: the field on its
 * own 3-space-indented line, multi-line values split per line with any
 * leading markdown list-marker run (`- ` / `* `, repeated) stripped while
 * the line's own inner indentation is kept, and every continuation line
 * indented under the block. Other content markdown (e.g. `##` headings) is
 * deliberately left as-is.
 */
function formatIndentedFieldLines(label: string, value: string): string[] {
  const valueLines = String(value ?? "")
    .split("\n")
    .map((line) => line.replace(/^(\s*)(?:[-*] )+/, "$1"));
  const lines = [`   ${label}: ${valueLines[0]}`];
  for (const continuation of valueLines.slice(1)) {
    lines.push(`   ${continuation}`);
  }
  return lines;
}

/**
 * Formats one candidate as a numbered block: `N. Category: <cat>` with the
 * number inline on the first line, then each remaining field on its own line
 * indented under the candidate. Multi-line field values (stored overviews
 * commonly carry bulleted markdown like "- Name: ...") are split per line,
 * any leading markdown list marker (`- ` / `* `) is stripped while the
 * line's own inner indentation is kept, and every continuation line is
 * indented under the candidate so the block stays visually grouped. Without
 * this, content-carried bullets land at column 0 inside the numbered list
 * and (in markdown renderers) break the list apart.
 *
 * Every prompt path that renders candidate memories (admission standalone,
 * admission batch and its few-shot example, batched dedup) must emit
 * candidate blocks through this one function so the shapes can never drift
 * apart.
 */
export function formatCandidateBlock(n: number, candidate: CandidateMemory): string {
  const lines = [`${n}. Category: ${candidate.category}`];
  const fields: Array<[string, string]> = [
    ["Abstract", candidate.abstract],
    ["Overview", candidate.overview],
    ["Content", candidate.content],
  ];
  for (const [label, value] of fields) {
    lines.push(...formatIndentedFieldLines(label, value));
  }
  return lines.join("\n");
}

export interface BatchDedupItem {
  candidate: CandidateMemory;
  /**
   * Pre-formatted numbered list of THIS candidate's own similar existing
   * memories (the same text the single-call dedup prompt embeds), so every
   * numbered block carries its own retrieved-neighbor context.
   */
  existingMemories: string;
}

/**
 * Batched variant of buildDedupPrompt: one LLM call decides every numbered
 * candidate independently. Verdict vocabulary, rules, and match_index
 * semantics are identical to the single-candidate prompt — only the call
 * topology changes. Returned as {system, user} so the eventual merge with
 * the system/user prompt-architecture split is mechanical; on this branch
 * the two are concatenated before the single-string completeJson() call.
 */
export function buildBatchDedupPrompt(items: BatchDedupItem[]): { system: string; user: string } {
  const system = `Determine how to handle each numbered candidate memory in this batch. Decide every candidate independently, using only that candidate's own "Existing similar memories" list — never another candidate's.

For each candidate, decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPERSEDE: Candidate states that the same mutable fact has changed over time. Keep the old memory as historical but no longer current, and create a new current memory.
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For "preferences" and "entities", use SUPERSEDE when the candidate replaces the current truth instead of adding detail or context. Example: existing "Preferred editor: VS Code", candidate "Preferred editor: Zed".
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.
- "match_index" always refers to the numbering of that candidate's OWN "Existing similar memories" list (1-based), never to another candidate's list and never to the candidate numbering itself.

Return JSON only, with exactly one entry per candidate, in this shape:
{
  "results": [
    { "index": 1, "decision": "skip|create|merge|supersede|support|contextualize|contradict", "match_index": 1, "reason": "Decision reason", "context_label": "evening" }
  ]
}

- "index" is the candidate's number in the batch below.
- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the matching existing memory (1-based) in that candidate's own list.
- Only include "context_label" for support/contextualize/contradict decisions.`;

  const blocks = items.map((item, i) => {
    const candidateBlock = formatCandidateBlock(i + 1, item.candidate);
    const existing = String(item.existingMemories ?? "")
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
    return `${candidateBlock}\n   Existing similar memories:\n${existing}`;
  });

  const user = `Candidates:

${blocks.join("\n\n")}`;

  return { system, user };
}

export interface BatchMergeJobPrompt {
  category: string;
  existing: { abstract: string; overview: string; content: string };
  /** One or more new-information records to fold into the existing memory. */
  additions: Array<{ abstract: string; overview: string; content: string }>;
}

/**
 * Batched variant of buildMergePrompt: one LLM call writes every numbered
 * merge job. Each job carries its target ("Existing memory") and every
 * candidate merging into it ("New information"); merge requirements are
 * identical to the single-job prompt — only the call topology changes.
 * Returned as {system, user}, concatenated at the call site on this branch.
 */
export function buildBatchMergePrompt(jobs: BatchMergeJobPrompt[]): { system: string; user: string } {
  const system = `Merge each numbered job below into a single coherent record with all three levels. For each job, merge every "New information" section into that job's "Existing memory"; never mix content across jobs.

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON only, with exactly one entry per job, in this shape:
{
  "results": [
    { "index": 1, "abstract": "Merged one-line abstract", "overview": "Merged structured Markdown overview", "content": "Merged full content" }
  ]
}

- "index" is the job's number in the batch below.`;

  const blocks = jobs.map((job, i) => {
    const lines = [`${i + 1}. Category: ${job.category}`, `   Existing memory:`];
    lines.push(...formatIndentedFieldLines("Abstract", job.existing.abstract));
    lines.push(...formatIndentedFieldLines("Overview", job.existing.overview));
    lines.push(...formatIndentedFieldLines("Content", job.existing.content));
    job.additions.forEach((addition, j) => {
      lines.push(job.additions.length > 1 ? `   New information ${j + 1}:` : `   New information:`);
      lines.push(...formatIndentedFieldLines("Abstract", addition.abstract));
      lines.push(...formatIndentedFieldLines("Overview", addition.overview));
      lines.push(...formatIndentedFieldLines("Content", addition.content));
    });
    return lines.join("\n");
  });

  const user = `Merge jobs:

${blocks.join("\n\n")}`;

  return { system, user };
}
