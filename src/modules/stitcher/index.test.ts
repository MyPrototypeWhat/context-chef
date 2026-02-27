import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { Stitcher } from '.';

describe('Stitcher', () => {
  it('should deterministically order keys', () => {
    const obj1 = { b: 2, a: 1, c: { e: 4, d: 3 } };
    const obj2 = { c: { d: 3, e: 4 }, a: 1, b: 2 };

    const sorted1 = Stitcher.orderKeysDeterministically(obj1);
    const sorted2 = Stitcher.orderKeysDeterministically(obj2);

    expect(JSON.stringify(sorted1)).toBe(JSON.stringify(sorted2));
    expect(JSON.stringify(sorted1)).toBe('{"a":1,"b":2,"c":{"d":3,"e":4}}');
  });

  it('should maintain static prefix hash across different histories', () => {
    const stitcher = new Stitcher();

    const topLayer: Message[] = [{ role: 'system', content: 'You are a helpful assistant' }];

    // Scenario 1: User asks a simple question
    const history1: Message[] = [{ role: 'user', content: 'What is 1+1?' }];

    // Scenario 2: User asks a different question but Top Layer is same
    const history2: Message[] = [{ role: 'user', content: 'What is the capital of France?' }];

    const payload1 = stitcher.compile([...topLayer, ...history1]);
    const payload2 = stitcher.compile([...topLayer, ...history2]);

    // Extract just the top layer from the compiled payloads to verify stability
    const topLayerResult1 = payload1.messages.slice(0, topLayer.length);
    const topLayerResult2 = payload2.messages.slice(0, topLayer.length);

    expect(JSON.stringify(topLayerResult1)).toBe(JSON.stringify(topLayerResult2));
  });

  it('should normalize payloads consistently', () => {
    const msg1: Message = { role: 'user', content: 'test', name: 'Alice' };
    const msg2: Message = { name: 'Alice', role: 'user', content: 'test' };

    const stitcher = new Stitcher();
    const payload1 = stitcher.compile([msg1]);
    const payload2 = stitcher.compile([msg2]);

    const str1 = Stitcher.stringifyPayload(payload1);
    const str2 = Stitcher.stringifyPayload(payload2);

    expect(str1).toBe(str2);
  });
});
