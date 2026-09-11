import type { ZodType } from 'zod';
import { LIMITS } from './limits';
import { ProtocolError } from './common';

/**
 * Cheap structural bounds applied *before* schema parsing so a hostile or
 * runaway payload cannot make the validator itself expensive.
 */
export function checkPayloadBounds(value: unknown, maxDepth = LIMITS.payloadMaxDepth): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (depth > maxDepth) throw new ProtocolError('payloadTooLarge', `payload nesting exceeds ${maxDepth}`);
    if (++nodes > 200_000) throw new ProtocolError('payloadTooLarge', 'payload has too many nodes');
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    for (const key of Object.keys(v as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ProtocolError('invalidRequest', `forbidden key "${key}"`);
      }
      visit((v as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
}

export function estimateBytes(value: unknown): number {
  // JSON stringification length in UTF-16 code units is a stable, cheap
  // over-approximation for ASCII-heavy payloads; we measure UTF-8 when needed.
  const s = JSON.stringify(value);
  return s === undefined ? 0 : new TextEncoder().encode(s).byteLength;
}

/**
 * Validate an untrusted message. Throws ProtocolError with paths only (no values).
 */
export function parseMessage<T>(schema: ZodType<T>, value: unknown, maxBytes = LIMITS.messageMaxBytes): T {
  checkPayloadBounds(value);
  if (estimateBytes(value) > maxBytes) {
    throw new ProtocolError('payloadTooLarge', `message exceeds ${maxBytes} bytes`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ProtocolError('invalidRequest', 'message failed validation', details);
  }
  return result.data;
}
