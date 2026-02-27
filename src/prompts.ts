export const Prompts = {
  /**
   * Used by Governor to enforce strict XML output and behavior.
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
   * Used by Pointer to indicate content has been offloaded to VFS.
   * Directly implements Claude Code's exact "ephemeral message" anti-hallucination pattern.
   */
  getVFSOffloadReminder: (threshold: number, uri: string, lastLines: string) =>
    `
The following is an ephemeral message not actually sent by the user. It is provided by the system as a set of reminders and generally important information to pay attention to. Do NOT respond to this message, just act accordingly.
<EPHEMERAL_MESSAGE>
Note: The output was too large (exceeds ${threshold} characters) and has been truncated and offloaded to VFS at URI: ${uri}. 
Don't tell the user about this truncation. Use your available tools to read more of the file from the URI if you need.
</EPHEMERAL_MESSAGE>

...[truncated]...
${lastLines}
`.trim(),

  /**
   * Used by Janitor as the default instruction for compressing rolling history.
   * Based on Claude Code's "system-prompt-context-compaction-summary.md".
   * It provides a very short, aggressive compression prompt.
   */
  CONTEXT_COMPACTION_INSTRUCTION: `
You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.
`.trim(),

  /**
   * A much larger, detailed variant (1121 tokens in Claude Code) for deep conversational memory.
   * Derived from Claude Code's "agent-prompt-conversation-summarization.md".
   * Use this when you need absolute precision and error-tracking in your Janitor module.
   */
  DEEP_CONVERSATION_SUMMARIZATION: `
Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
 - The user's explicit requests and intents
 - Your approach to addressing the user's requests
 - Key decisions, technical concepts and code patterns
 - Specific details like file names, full code snippets, function signatures, file edits.
 - Errors that you ran into and how you fixed them
 - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.

Your summary should include the following sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (including full code snippets and summary of changes)
4. Errors and fixes
5. Problem Solving
6. All user messages (not tool results)
7. Pending Tasks
8. Current Work
9. Optional Next Step (must be DIRECTLY in line with the user's most recent explicit requests)

Wrap your final structured summary in <history_summary> tags.
`.trim(),

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
   * Static instruction for developers to include in their system prompt (topLayer).
   * Teaches the LLM how to use <update_core_memory> and <delete_core_memory> tags.
   */
  CORE_MEMORY_INSTRUCTION: `
You have access to a persistent core memory that survives across conversations.
Use it to store important facts, user preferences, project conventions, and other knowledge you want to remember.

To create or update a memory entry:
<update_core_memory key="key_name">value to remember</update_core_memory>

To delete a memory entry:
<delete_core_memory key="key_name" />

Guidelines:
- Use clear, descriptive key names (e.g. "project_language", "user_preference_style").
- Keep values concise but informative.
- Only update memory when you learn something genuinely worth persisting.
`.trim(),

  /**
   * Dynamic wrapper used by compile() to inject recalled core memory alongside key guidance.
   * Enumerates existing keys (soft guidance) or allowed keys (strict mode) to stabilize LLM key creation.
   */
  getCoreMemoryBlock: (coreMemoryXml: string, existingKeys: string[], allowedKeys?: string[]) => {
    let block = `The following is your persistent core memory from previous sessions. Reference it to maintain consistency across conversations.\n${coreMemoryXml}`;

    if (allowedKeys && allowedKeys.length > 0) {
      block += `\n\nAllowed memory keys: ${allowedKeys.join(', ')}. You may ONLY update or delete these keys. Any other key will be rejected.`;
    } else if (existingKeys.length > 0) {
      block += `\n\nExisting memory keys: ${existingKeys.join(', ')}. Prefer updating these keys over creating new ones to maintain consistency.`;
    }

    return block;
  },
};
