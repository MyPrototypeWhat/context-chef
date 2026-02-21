import { ContextChef } from '../src/index';
import { z } from 'zod';
import { Message } from '../src/types';

describe('ContextChef API', () => {
  it('should compile a complete sandwich model payload deterministically and format XML', () => {
    const chef = new ContextChef();

    const topLayer: Message[] = [{ role: 'system', content: 'You are an expert.', _cache_breakpoint: true }];
    const history: Message[] = [{ role: 'user', content: 'Help me.' }];
    
    // Define a strongly-typed schema for our dynamic state
    const TaskSchema = z.object({
      activeFile: z.string(),
      todoList: z.array(z.string())
    });

    const payload = chef
      .setTopLayer(topLayer)
      .useRollingHistory(history)
      .setDynamicState(TaskSchema, {
        activeFile: 'index.ts',
        todoList: ['implement tests']
      })
      .withGovernance({ 
        enforceXML: { outputTag: 'final_code' },
        prefill: '<thinking>\n1. ' 
      })
      .compile({ target: 'openai' }); // Defaults to strip prefill for openai

    expect(payload.messages.length).toBe(3); // Assistant message was swallowed
    
    // 0: Top
    expect(payload.messages[0].content).toBe('You are an expert.');
    // 1: History
    expect(payload.messages[1].content).toBe('Help me.');
    
    // 2: System Message (Combined DynamicState and Governor Rules)
    const sysMsg = payload.messages[2];
    expect(sysMsg.role).toBe('system');
    
    // Check XML format was generated
    expect(sysMsg.content).toContain('<dynamic_state>');
    expect(sysMsg.content).toContain('<activeFile>index.ts</activeFile>');
    expect(sysMsg.content).toContain('<item>implement tests</item>');

    // Check degraded prefill constraint
    expect(sysMsg.content).toContain('CRITICAL OUTPUT FORMAT INSTRUCTIONS:');
    expect(sysMsg.content).toContain('You are acting as an automated system component.');
    expect(sysMsg.content).toContain('<final_code>');
    expect(sysMsg.content).toContain('</final_code>');
    // The new prompt uses an EPHEMERAL_MESSAGE wrapper (Claude Code pattern)
    expect(sysMsg.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(sysMsg.content).toContain('ALWAYS START your thought with recalling these instructions.');
    
    // Check if the prefill gracefully degraded into the final system note
    expect(sysMsg.content).toContain('[System Note: Please start your response directly with: <thinking>\n1. ]');
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

  it('should compile Anthropic with cache control successfully', () => {
    const chef = new ContextChef();
    const payload = chef
      .setTopLayer([{ role: 'system', content: 'You are an expert.', _cache_breakpoint: true }])
      .useRollingHistory([{ role: 'user', content: 'Help me.' }])
      .compile({ target: 'anthropic' });

    // Anthropic extracts systems into a separate array
    expect((payload as any).system).toBeDefined();
    expect((payload as any).system[0].cache_control).toBeDefined();
    expect((payload as any).system[0].cache_control.type).toBe('ephemeral');
  });
});
