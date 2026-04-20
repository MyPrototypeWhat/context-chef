export const Prompts = {
  /**
   * Used by Guardrail to enforce strict XML output and behavior.
   * Uses Claude Code's <EPHEMERAL_MESSAGE> wrapper pattern to inject system rules
   * into the user/assistant flow without the model "replying" to it.
   * Uses Claude Code-style emphasis (CRITICAL, MUST, NEVER) for cognitive anchoring.
   */
  getXMLGuardrail: (outputTag: string) =>
    `
The following is an ephemeral message not actually sent by the user. It is provided by the system as a set of reminders and generally important information to pay attention to. Do NOT respond to this message, just act accordingly.
<EPHEMERAL_MESSAGE>
CRITICAL OUTPUT FORMAT INSTRUCTIONS:
You are acting as an automated system component. Your final output MUST be machine-parseable.

1. You MUST enclose your final answer strictly within exactly one set of <${outputTag}> and </${outputTag}> tags.
2. DO NOT output any text, explanation, or conversational filler outside of these tags.
3. ANY content outside of these designated XML tags will cause a system parsing failure.
</EPHEMERAL_MESSAGE>
`.trim(),

  /**
   * Used by Offloader to indicate content has been offloaded to VFS.
   * Shows head/tail content with truncation metadata and a retrieval URI.
   */
  getVFSOffloadReminder: (
    uri: string,
    totalLines: number,
    totalChars: number,
    headStr: string,
    tailStr: string,
  ) => {
    const parts: string[] = [];

    if (headStr) {
      parts.push(headStr);
    }

    parts.push(
      `\n--- output truncated (${totalLines} lines, ${totalChars} chars) ---\nFull output: ${uri}\n`,
    );

    if (tailStr) {
      parts.push(tailStr);
    }

    return parts.join('\n').trim();
  },

  /**
   * Used by Janitor as the default instruction for compressing rolling history.
   * Structured as a two-phase response: an <analysis> scratchpad (stripped from
   * the final output) followed by a <summary> block. The scratchpad pattern
   * measurably improves summary quality; formatCompactSummary() removes it
   * before the summary reaches the next context window.
   *
   * Domain-agnostic — applicable to coding agents, support agents, research
   * agents, and any other conversational use case.
   */
  CONTEXT_COMPACTION_INSTRUCTION: `
You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary.

Before providing your final summary, wrap your analysis in <analysis></analysis> tags to organize your thoughts and ensure you've covered all necessary points. This analysis scratchpad will be stripped from the final output — use it freely to reason through the conversation.

In your analysis:
- Chronologically review what happened in the conversation
- Identify the user's explicit requests, intents, and any clarifications
- Note key decisions, constraints, and information discovered
- Track errors or obstacles encountered and how they were addressed
- Pay attention to specific user feedback, especially corrections

Your final summary (inside <summary></summary> tags) should be structured, concise, and actionable. Include:

1. Task Overview
   The user's core request and success criteria. Any clarifications or constraints specified.

2. Current State
   What has been completed so far. Key outputs, artifacts, or findings produced. Any state or identifiers that need to persist (file paths, URLs, ticket IDs, etc.) — preserve these verbatim.

3. Important Discoveries
   Constraints or requirements uncovered. Decisions made and their rationale. Approaches that were tried and didn't work (and why). Errors encountered and how they were resolved.

4. Next Steps
   Specific actions needed to complete the task. Any blockers or open questions. Priority order if multiple steps remain.

5. Context to Preserve
   User preferences or style requirements. Domain-specific details that aren't obvious from the conversation. Any promises or commitments made to the user.

Here's an example of the expected format:

<example>
<analysis>
[Your thought process reviewing the conversation, identifying what matters]
</analysis>

<summary>
1. Task Overview:
   [User's core request and success criteria]

2. Current State:
   - [What has been completed]
   - [Key outputs or identifiers to preserve verbatim]

3. Important Discoveries:
   - [Key constraints, decisions, failed approaches, errors resolved]

4. Next Steps:
   - [Specific actions in priority order]

5. Context to Preserve:
   - [Preferences, commitments, domain details]
</summary>
</example>

Be concise but complete — err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
`.trim(),

  /**
   * Cleans the raw output of a compression model by stripping XML scaffolding.
   *
   * - Removes <analysis>...</analysis> scratchpad blocks (stripped from final output)
   * - Extracts content from <summary>...</summary> when present
   * - Falls back to the stripped text if no <summary> tag is found
   * - Collapses excessive blank lines and trims whitespace
   *
   * Called by Janitor on the compressionModel return value before wrapping
   * with getCompactSummaryWrapper.
   *
   * @example
   * formatCompactSummary('<analysis>thinking</analysis><summary>result</summary>')
   * // → 'result'
   */
  formatCompactSummary: (raw: string): string => {
    let out = raw;

    // Strip <analysis> scratchpad blocks (case-insensitive, all occurrences)
    out = out.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');

    // Extract <summary> content if present
    const match = out.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (match) {
      out = match[1];
    }

    // Collapse 3+ consecutive newlines into 2, then trim
    return out.replace(/\n{3,}/g, '\n\n').trim();
  },

  /**
   * Wraps a compression summary with context explanation.
   * Tells the model this is a continuation from a compacted conversation,
   * not a fresh start.
   */
  getCompactSummaryWrapper: (summary: string) =>
    `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary}

Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`.trim(),

  /**
   * Used by Janitor when compression fails or no model is provided.
   */
  getFallbackCompressionSummary: (truncatedCount: number) =>
    `
<history_summary>
<ephemeral_message type="history_truncated">
[System: ${truncatedCount} older messages were truncated and compressed to respect context limits.]
</ephemeral_message>
</history_summary>
`.trim(),

  /**
   * Used by Adapters (like OpenAI) that don't support native prefill.
   * Forces the model to start its response with specific text using a system instruction.
   */
  getPrefillEnforcement: (prefillContent: string) =>
    `
<ephemeral_message type="prefill_enforcement">
SYSTEM INSTRUCTION: Your response MUST start verbatim with the following text:
"${prefillContent}"

Do not output any introductory text or acknowledgement. Start directly with the text above.
</ephemeral_message>
`.trim(),

  /**
   * Static instruction injected into the system prompt when memory is enabled.
   * Guides the LLM to use memory tools for persistence.
   */
  MEMORY_INSTRUCTION: `
You have access to memory tools that let you remember and forget facts across conversations.
Use them to store important information like user preferences, project conventions, and key decisions.
Only remember things genuinely worth persisting.
`.trim(),

  /**
   * Dynamic wrapper used by compile() to inject recalled core memory alongside key guidance.
   * Enumerates existing keys (soft guidance) or allowed keys (strict mode) to stabilize LLM key creation.
   */
  getMemoryBlock: (coreMemoryXml: string, existingKeys: string[], allowedKeys?: string[]) => {
    let block = `You recall the following from previous conversations:\n${coreMemoryXml}`;

    if (allowedKeys && allowedKeys.length > 0) {
      block += `\n\nAllowed memory keys: ${allowedKeys.join(', ')}. You may ONLY update or delete these keys. Any other key will be rejected.`;
    } else if (existingKeys.length > 0) {
      block += `\n\nExisting memory keys: ${existingKeys.join(', ')}. Prefer updating these keys over creating new ones to maintain consistency.`;
    }

    return block;
  },

  /**
   * System-level instruction explaining cleared tool results.
   * Prevents the model from interpreting placeholders as errors.
   * Auto-injected by the middleware when tool-result compaction is active.
   * Core users can include this in their system prompt manually.
   */
  TOOL_RESULT_CLEARED_INSTRUCTION:
    'Some old tool results have been automatically cleared to manage context length. ' +
    'Messages showing "[Old tool result content cleared]" indicate the tool executed successfully — ' +
    'the output was removed to save space, not due to any error. ' +
    'Focus on the recent tool results which are preserved in full.',
};
