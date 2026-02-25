import { z } from 'zod';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

describe('ContextChef API', () => {
  it('should compile with placement=system (legacy behavior)', async () => {
    const chef = new ContextChef();

    const topLayer: Message[] = [
      { role: 'system', content: 'You are an expert.', _cache_breakpoint: true },
    ];
    const history: Message[] = [{ role: 'user', content: 'Help me.' }];

    const TaskSchema = z.object({
      activeFile: z.string(),
      todoList: z.array(z.string()),
    });

    const payload = await chef
      .setTopLayer(topLayer)
      .useRollingHistory(history)
      .setDynamicState(
        TaskSchema,
        {
          activeFile: 'index.ts',
          todoList: ['implement tests'],
        },
        { placement: 'system' },
      )
      .withGovernance({
        enforceXML: { outputTag: 'final_code' },
        prefill: '<thinking>\n1. ',
      })
      .compile({ target: 'openai' });

    expect(payload.messages.length).toBe(3);

    // 0: Top
    expect(payload.messages[0].content).toBe('You are an expert.');
    // 1: History
    expect(payload.messages[1].content).toBe('Help me.');

    // 2: System Message (Combined DynamicState and Governor Rules)
    const sysMsg = payload.messages[2];
    expect(sysMsg.role).toBe('system');

    expect(sysMsg.content).toContain('<dynamic_state>');
    expect(sysMsg.content).toContain('<activeFile>index.ts</activeFile>');
    expect(sysMsg.content).toContain('<item>implement tests</item>');

    expect(sysMsg.content).toContain('CRITICAL OUTPUT FORMAT INSTRUCTIONS:');
    expect(sysMsg.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(sysMsg.content).toContain(
      'SYSTEM INSTRUCTION: Your response MUST start verbatim with the following text:',
    );
  });

  it('should inject dynamic state into last user message by default (placement=last_user)', async () => {
    const chef = new ContextChef();

    const topLayer: Message[] = [{ role: 'system', content: 'You are an expert.' }];
    const history: Message[] = [
      { role: 'user', content: 'Read auth.ts' },
      { role: 'assistant', content: 'Here is the file content...' },
      { role: 'user', content: 'Now fix the login bug.' },
    ];

    const TaskSchema = z.object({
      activeFile: z.string(),
      todo: z.array(z.string()),
    });

    const payload = await chef
      .setTopLayer(topLayer)
      .useRollingHistory(history)
      .setDynamicState(TaskSchema, {
        activeFile: 'auth.ts',
        todo: ['Fix login bug'],
      })
      .compile({ target: 'openai' });

    // Top(1) + History(3) = 4 messages. No extra system message for dynamic state.
    expect(payload.messages.length).toBe(4);

    // The last user message should now contain the dynamic state
    const lastUserMsg = payload.messages[3];
    expect(lastUserMsg.role).toBe('user');
    expect(lastUserMsg.content).toContain('Now fix the login bug.');
    expect(lastUserMsg.content).toContain('<dynamic_state>');
    expect(lastUserMsg.content).toContain('<activeFile>auth.ts</activeFile>');
    expect(lastUserMsg.content).toContain('<item>Fix login bug</item>');
    expect(lastUserMsg.content).toContain('Use it to guide your next action.');
  });

  it('should create a new user message if no user message exists in history (last_user fallback)', async () => {
    const chef = new ContextChef();

    const TaskSchema = z.object({ task: z.string() });

    const payload = await chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.' }])
      .setDynamicState(TaskSchema, { task: 'Initialize project' })
      .compile({ target: 'openai' });

    // Top(1) + new user message(1) = 2
    expect(payload.messages.length).toBe(2);
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content).toContain('<dynamic_state>');
    expect(payload.messages[1].content).toContain('<task>Initialize project</task>');
  });

  it('should throw an error if dynamic state does not match schema', () => {
    const chef = new ContextChef();
    const TaskSchema = z.object({ activeFile: z.string() });

    expect(() => {
      // @ts-expect-error Intentionally invalid data
      chef.setDynamicState(TaskSchema, { activeFile: 123 });
    }).toThrow();
  });

  it('should utilize VFS for large outputs seamlessly with per-call config', () => {
    const chef = new ContextChef({ vfs: { threshold: 5000 } });

    const log = Array(100).fill('Error log line.').join('\n');

    // Won't trigger default
    const processed1 = chef.processLargeOutput(log);
    expect(processed1).not.toContain('context://vfs/');

    // Trigger explicit threshold override
    const processed2 = chef.processLargeOutput(log, 'log', { threshold: 50 });
    expect(processed2).toContain('<EPHEMERAL_MESSAGE>');
    expect(processed2).toContain('context://vfs/log_');
  });

  it('should compile Anthropic with cache control successfully', async () => {
    const chef = new ContextChef();
    const TaskSchema = z.object({ task: z.string() });

    const payload = await chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.', _cache_breakpoint: true }])
      .useRollingHistory([{ role: 'user', content: 'Help me.' }])
      .setDynamicState(TaskSchema, { task: 'Fix bug' })
      .compile({ target: 'anthropic' });

    // Anthropic extracts systems into a separate array
    const anthropicPayload = payload as { system?: Array<{ cache_control?: { type: string } }> };
    expect(anthropicPayload.system).toBeDefined();
    expect(anthropicPayload.system?.[0].cache_control).toBeDefined();
    expect(anthropicPayload.system?.[0].cache_control?.type).toBe('ephemeral');

    // Dynamic state should be injected into the user message, not as a system message
    const userMsg = payload.messages[0] as {
      content: string | Array<{ type: string; text?: string }>;
    };
    expect(userMsg.content).toBeDefined();
    // The user message content should contain both the original text and the dynamic state
    const textContent = Array.isArray(userMsg.content)
      ? (userMsg.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
          ?.text
      : userMsg.content;
    expect(textContent).toContain('Help me.');
    expect(textContent).toContain('<dynamic_state>');
    expect(textContent).toContain('<task>Fix bug</task>');
  });
});
