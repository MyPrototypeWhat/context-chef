import { createHash } from 'node:crypto';
import { Assembler } from '../modules/assembler';
import type { Message } from '../types';
import type { PrefixSent } from './types';

/** Key order and cache breakpoints don't change what the model saw. */
function canonical(value: unknown): string {
  return JSON.stringify(Assembler.orderKeysDeterministically(value), (key, v) =>
    key === 'cache_control' ? undefined : v,
  );
}

/** Whether two payloads, or parts of one, send the model the same thing. */
export function sameOnWire(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** A JSON copy of plain data: functions and `undefined` drop out, as on the wire. */
function jsonCopy(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/**
 * `sent` as the ledger compares and keeps it: a plain JSON copy, which
 * whatever edits the payload it was read from afterwards does not reach.
 * Take it once per compile and pass the same copy to `reconcileSent()` and
 * `commit()`.
 */
export function plainSent(sent: PrefixSent): PrefixSent {
  return { system: jsonCopy(sent.system), tools: jsonCopy(sent.tools) };
}

/**
 * Digest of the fields of a message that reach some provider's wire: two
 * messages with the same digest are the same message to the model. Anything
 * else — breakpoints, pinning, host metadata, the `_chef_event` mark — is not
 * an edit. `_anthropic_origin` counts by identity: dropping or replacing it
 * makes the Anthropic target rebuild the message from IR instead of
 * replaying it.
 *
 * The role's initial leads in clear: where an entry renders depends on which
 * host messages are replies, and `seen` is all a restored ledger knows of the
 * history it committed.
 */
export function wireDigest(message: Message): string {
  const origin = message._anthropic_origin;
  const wire = [
    message.role,
    message.content,
    message.name,
    message.tool_calls,
    message.tool_call_id,
    message.thinking,
    message.redacted_thinking,
    message.attachments,
    message._anthropic_compaction,
    origin && {
      hash: origin.hash,
      part: origin.part,
      parts: origin.parts,
      blocks: origin.blocks !== undefined,
    },
    message._gemini_thought_signature,
    message._openai_reasoning,
    message._positional,
    message._clear_at,
  ];
  const hash = createHash('sha256').update(canonical(wire)).digest('hex').substring(0, 16);
  return `${message.role.charAt(0)}:${hash}`;
}
