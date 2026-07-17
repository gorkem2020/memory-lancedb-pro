/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 * Batched variants (one LLM call per pipeline stage):
 * - buildBatchDedupPrompt: one dedup decision per numbered candidate
 * - buildBatchMergePrompt: one merged record per numbered merge job
 *
 * Static content shared across builders (category taxonomy, identity
 * openers, the candidate/job markdown formatter) is single-sourced in
 * ./prompt-blocks.ts and composed in below -- copied prompt text between
 * builders is a defect.
 */
import { CATEGORY_TAXONOMY, DEDUP_JUDGE_IDENTITY, EXTRACTION_AGENT_IDENTITY, MERGE_WRITER_IDENTITY, formatCandidateBlock, formatExistingMemoriesSection, formatMemoryFieldLines, jsonBlock, } from "./prompt-blocks.js";
export function buildExtractionPrompt(conversationText, user) {
    return `${EXTRACTION_AGENT_IDENTITY} Analyze the following session context and extract memories worth long-term preservation.

User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
${conversationText}

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
${jsonBlock(`{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "One-line index",
      "overview": "Structured Markdown summary",
      "content": "Full narrative"
    }
  ]
}`)}

Notes:
- Output language should match the dominant language in the conversation
- Only extract truly valuable personalized information
- If nothing worth recording, return {"memories": []}
- Maximum 5 memories per extraction
- Preferences should be aggregated by topic`;
}
export function buildDedupPrompt(candidate, existingMemories) {
    const existingSection = formatExistingMemoriesSection(String(existingMemories ?? "")
        .split("\n")
        .filter((line) => line.length > 0));
    return `${DEDUP_JUDGE_IDENTITY}

${CATEGORY_TAXONOMY}

## Candidate

${formatCandidateBlock(1, candidate)}

${existingSection}

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

Return JSON only:
${jsonBlock(`{
  "decision": "skip|create|merge|supersede|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}`)}

- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;
}
export function buildMergePrompt(existing, addition) {
    return `${MERGE_WRITER_IDENTITY}

${CATEGORY_TAXONOMY}

## Merge job

### Existing memory
${formatMemoryFieldLines(existing).join("\n")}

### New information
${formatMemoryFieldLines(addition).join("\n")}

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON only:
${jsonBlock(`{
  "abstract": "Merged one-line abstract",
  "overview": "Merged structured Markdown overview",
  "content": "Merged full content"
}`)}`;
}
/**
 * Batched variant of buildDedupPrompt: one LLM call decides every numbered
 * candidate independently. Verdict vocabulary, rules, and match_index
 * semantics are identical to the single-candidate prompt — only the call
 * topology changes. Returned as {system, user} so the eventual merge with
 * the system/user prompt-architecture split is mechanical; on this branch
 * the two are concatenated before the single-string completeJson() call.
 */
export function buildBatchDedupPrompt(items) {
    const system = `${DEDUP_JUDGE_IDENTITY} Decide every candidate independently, using only that candidate's own "Existing similar memories" list — never another candidate's.

${CATEGORY_TAXONOMY}

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
${jsonBlock(`{
  "results": [
    { "index": 1, "decision": "skip|create|merge|supersede|support|contextualize|contradict", "match_index": 1, "reason": "Decision reason", "context_label": "evening" }
  ]
}`)}

- "index" is the candidate's number in the batch below.
- If decision is "merge"/"supersede"/"support"/"contextualize"/"contradict", set "match_index" to the number of the matching existing memory (1-based) in that candidate's own list.
- Only include "context_label" for support/contextualize/contradict decisions.`;
    const blocks = items.map((item, i) => {
        const candidateBlock = formatCandidateBlock(i + 1, item.candidate);
        const existingSection = formatExistingMemoriesSection(String(item.existingMemories ?? "")
            .split("\n")
            .filter((line) => line.length > 0));
        return existingSection ? `${candidateBlock}\n\n${existingSection}` : candidateBlock;
    });
    const user = `## Candidates

${blocks.join("\n\n")}`;
    return { system, user };
}
/**
 * Batched variant of buildMergePrompt: one LLM call writes every numbered
 * merge job. Each job carries its target ("Existing memory") and every
 * candidate merging into it ("New information"); merge requirements are
 * identical to the single-job prompt — only the call topology changes.
 * Returned as {system, user}, concatenated at the call site on this branch.
 */
export function buildBatchMergePrompt(jobs) {
    const system = `${MERGE_WRITER_IDENTITY} For each job, merge every "New information" section into that job's "Existing memory"; never mix content across jobs.

${CATEGORY_TAXONOMY}

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON only, with exactly one entry per job, in this shape:
${jsonBlock(`{
  "results": [
    { "index": 1, "abstract": "Merged one-line abstract", "overview": "Merged structured Markdown overview", "content": "Merged full content" }
  ]
}`)}

- "index" is the job's number in the batch below.`;
    const blocks = jobs.map((job, i) => {
        const lines = [`### ${i + 1}. ${job.category}`, "", "#### Existing memory", ...formatMemoryFieldLines(job.existing)];
        job.additions.forEach((addition, j) => {
            const heading = job.additions.length > 1 ? `#### New information ${j + 1}` : "#### New information";
            lines.push("", heading, ...formatMemoryFieldLines(addition));
        });
        return lines.join("\n");
    });
    const user = `## Merge jobs

${blocks.join("\n\n")}`;
    return { system, user };
}
