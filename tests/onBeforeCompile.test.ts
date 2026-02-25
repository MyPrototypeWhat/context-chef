import { z } from 'zod';
import type { BeforeCompileContext } from '../src/index';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

describe('onBeforeCompile lifecycle hook (E8)', () => {
  const TaskSchema = z.object({ activeFile: z.string() });

  it('should inject implicit_context into last_user message (default placement)', async () => {
    const chef = new ContextChef({
      onBeforeCompile: async () => {
        return '<related_code>function verify() {}</related_code>';
      },
    });

    chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.' }])
      .useRollingHistory([{ role: 'user', content: 'Fix the bug.' }])
      .setDynamicState(TaskSchema, { activeFile: 'auth.ts' });

    const payload = await chef.compile({ target: 'openai' });

    const lastMsg = payload.messages[1]; // user message
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('<dynamic_state>');
    expect(lastMsg.content).toContain('<activeFile>auth.ts</activeFile>');
    expect(lastMsg.content).toContain('<implicit_context>');
    expect(lastMsg.content).toContain('<related_code>function verify() {}</related_code>');
  });

  it('should inject implicit_context into system message with placement=system', async () => {
    const chef = new ContextChef({
      onBeforeCompile: async () => 'AST dependency graph here',
    });

    chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.' }])
      .useRollingHistory([{ role: 'user', content: 'Help me.' }])
      .setDynamicState(TaskSchema, { activeFile: 'index.ts' }, { placement: 'system' });

    const payload = await chef.compile({ target: 'openai' });

    // Find the dynamic state system message (not the top layer one)
    const dynamicSysMsg = payload.messages.find(
      (m) => m.role === 'system' && m.content?.toString().includes('CURRENT TASK STATE'),
    );
    expect(dynamicSysMsg).toBeDefined();
    // implicit_context is appended directly to the dynamic state system message
    expect(dynamicSysMsg!.content?.toString()).toContain('<implicit_context>');
    expect(dynamicSysMsg!.content?.toString()).toContain('AST dependency graph here');
  });

  it('should skip injection when hook returns null', async () => {
    const chef = new ContextChef({
      onBeforeCompile: async () => null,
    });

    chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.' }])
      .useRollingHistory([{ role: 'user', content: 'Help me.' }])
      .setDynamicState(TaskSchema, { activeFile: 'app.ts' });

    const payload = await chef.compile({ target: 'openai' });

    const lastMsg = payload.messages[1];
    expect(lastMsg.content).toContain('<dynamic_state>');
    expect(lastMsg.content).not.toContain('<implicit_context>');
  });

  it('should work without onBeforeCompile configured', async () => {
    const chef = new ContextChef();

    chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.' }])
      .useRollingHistory([{ role: 'user', content: 'Help.' }]);

    const payload = await chef.compile({ target: 'openai' });

    expect(payload.messages.length).toBe(2);
    expect(payload.messages[1].content).toBe('Help.');
  });

  it('should receive correct context in the hook', async () => {
    let receivedCtx: BeforeCompileContext | null = null;

    const chef = new ContextChef({
      onBeforeCompile: async (ctx) => {
        receivedCtx = ctx;
        return null;
      },
    });

    const topLayer: Message[] = [{ role: 'system', content: 'Top' }];
    const history: Message[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ];

    chef
      .setTopLayer(topLayer)
      .useRollingHistory(history)
      .setDynamicState(TaskSchema, { activeFile: 'test.ts' });

    await chef.compile({ target: 'openai' });

    expect(receivedCtx).not.toBeNull();
    expect(receivedCtx!.topLayer).toHaveLength(1);
    expect(receivedCtx!.topLayer[0].content).toBe('Top');
    expect(receivedCtx!.rollingHistory).toHaveLength(2);
    expect(receivedCtx!.dynamicState).toHaveLength(0); // last_user placement → empty array
    expect(receivedCtx!.rawDynamicXml).toContain('<activeFile>test.ts</activeFile>');
  });

  it('should support synchronous hook', async () => {
    const chef = new ContextChef({
      onBeforeCompile: () => '<sync_data>hello</sync_data>',
    });

    chef
      .setTopLayer([{ role: 'system', content: 'Top' }])
      .useRollingHistory([{ role: 'user', content: 'Hi' }]);

    const payload = await chef.compile({ target: 'openai' });

    expect(payload.messages[1].content).toContain('<implicit_context>');
    expect(payload.messages[1].content).toContain('<sync_data>hello</sync_data>');
  });

  it('should work with implicit_context only (no dynamic state set)', async () => {
    const chef = new ContextChef({
      onBeforeCompile: async () => '<rag_result>relevant snippet</rag_result>',
    });

    chef
      .setTopLayer([{ role: 'system', content: 'Top' }])
      .useRollingHistory([{ role: 'user', content: 'Find the bug.' }]);

    const payload = await chef.compile({ target: 'openai' });

    const userMsg = payload.messages[1];
    expect(userMsg.content).toContain('<implicit_context>');
    expect(userMsg.content).toContain('<rag_result>relevant snippet</rag_result>');
    // Stitcher wraps all injected XML in <dynamic_state>, even if setDynamicState was never called
    expect(userMsg.content).toContain('<dynamic_state>');
  });
});
