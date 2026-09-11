import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  checkPayloadBounds,
  parseMessage,
  parseRecipe,
  uiRequestSchema,
} from '../../src/protocol';

const ids = { requestId: 'req_00000001', sessionId: 'sess_0000001', generation: 0 };

describe('recipe schema', () => {
  const base = {
    schemaVersion: 1,
    name: 'Fixture records',
    recordSelector: '[data-example="message"]',
    fields: {
      recordId: { selector: ':scope', read: 'attribute', attribute: 'data-record-id' },
      body: { selector: '.body', read: 'text', required: true },
    },
    identityFields: ['recordId'],
  };

  it('accepts a well-formed recipe and applies defaults', () => {
    const r = parseRecipe(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.fields.body!.required).toBe(true);
  });

  it('rejects event-handler and srcdoc attributes', () => {
    for (const attribute of ['onclick', 'onLoad', 'srcdoc', 'value']) {
      const r = parseRecipe({ ...base, fields: { x: { selector: 'a', read: 'attribute', attribute } } });
      expect(r.ok, attribute).toBe(false);
    }
  });

  it('rejects unknown keys (no room for code)', () => {
    const r = parseRecipe({ ...base, transform: 'return 1' });
    expect(r.ok).toBe(false);
  });

  it('rejects identity fields that are not single-valued reads', () => {
    const r = parseRecipe({ ...base, fields: { ...base.fields, n: { selector: 'a', read: 'count' } }, identityFields: ['n'] });
    expect(r.ok).toBe(false);
    const r2 = parseRecipe({ ...base, fields: { ...base.fields, m: { selector: 'a', read: 'text', multiple: true } }, identityFields: ['m'] });
    expect(r2.ok).toBe(false);
  });

  it('limits field count', () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i <= LIMITS.recipeMaxFields; i++) fields[`f${i}`] = { selector: 'a', read: 'text' };
    expect(parseRecipe({ ...base, fields }).ok).toBe(false);
  });

  it('reports issue paths without echoing values', () => {
    const r = parseRecipe({ ...base, recordSelector: 'x'.repeat(LIMITS.recipeMaxSelectorLength + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).not.toContain('xxxxxxxx');
  });
});

describe('message validation', () => {
  it('accepts a valid ui request', () => {
    const msg = parseMessage(uiRequestSchema, { v: PROTOCOL_VERSION, kind: 'uiRequest', ...ids, payload: { command: 'getStatus' } });
    expect(msg.payload.command).toBe('getStatus');
  });

  it('rejects wrong protocol version', () => {
    expect(() => parseMessage(uiRequestSchema, { v: 99, kind: 'uiRequest', ...ids, payload: { command: 'getStatus' } })).toThrow(ProtocolError);
  });

  it('rejects unknown commands and generic execution shapes', () => {
    expect(() => parseMessage(uiRequestSchema, { v: 1, kind: 'uiRequest', ...ids, payload: { command: 'eval', code: '1' } })).toThrow(ProtocolError);
  });

  it('rejects deeply nested payloads before schema parsing', () => {
    let deep: unknown = 1;
    for (let i = 0; i < LIMITS.payloadMaxDepth + 2; i++) deep = [deep];
    expect(() => checkPayloadBounds(deep)).toThrow(/nesting/);
  });

  it('rejects prototype-polluting keys', () => {
    expect(() => checkPayloadBounds(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(/forbidden key/);
  });

  it('rejects oversized messages', () => {
    const big = { v: 1, kind: 'uiRequest', ...ids, payload: { command: 'setRoot', selector: 'a'.repeat(100) } };
    expect(() => parseMessage(uiRequestSchema, big, 50)).toThrow(/exceeds/);
  });
});
