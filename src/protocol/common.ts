import { z } from 'zod';
import { LIMITS } from './limits';

export const PROTOCOL_VERSION = 1 as const;

/** Opaque IDs are UUID-ish strings; we only require a bounded, printable shape. */
export const idSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const generationSchema = z.number().int().nonnegative().max(1_000_000);

export const selectorSchema = z
  .string()
  .min(1)
  .max(LIMITS.recipeMaxSelectorLength)
  // Reject anything that could not possibly be a CSS selector and that we would
  // not want to echo back into the UI unescaped.
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'control characters not allowed');

/**
 * Session status states. There is deliberately no generic
 * "synced" or "ok" state.
 */
export const sessionStatusSchema = z.enum([
  'notAttached',
  'attaching',
  'ready', // attached, root may or may not be selected; one-shot inspection allowed
  'observing',
  'pausedByUser',
  'pausedAtLimit',
  'staleDocument',
  'staleRoot',
  'permissionLost',
  'unsupportedPage',
  'failure',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const captureModeSchema = z.enum(['structureOnly', 'selectedFields']);
export type CaptureMode = z.infer<typeof captureModeSchema>;

/** A warning attached to any response. `code` is machine-readable. */
export const warningSchema = z.object({
  code: z.enum([
    'limitReached',
    'truncated',
    'ambiguousMatch',
    'identityUnreliable',
    'missingRequired',
    'unsupportedBoundary',
    'staleGeneration',
    'slowTraversal',
    'quotaPressure',
    'other',
  ]),
  message: z.string().max(500),
  /** Which limit, if any, and the value in effect. */
  limit: z.string().max(64).optional(),
  limitValue: z.number().optional(),
});
export type Warning = z.infer<typeof warningSchema>;

export const errorCodeSchema = z.enum([
  'invalidRequest',
  'protocolVersionMismatch',
  'unknownCommand',
  'noSession',
  'staleSession',
  'staleGeneration',
  'wrongDocument',
  'untrustedSender',
  'notAttached',
  'noRoot',
  'rootDetached',
  'unsupportedPage',
  'permissionLost',
  'agentUnavailable',
  'invalidSelector',
  'invalidRecipe',
  'limitExceeded',
  'payloadTooLarge',
  'storageQuota',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const structuredErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().max(1000),
  /** Never contains page content; only paths/keys of the offending input. */
  details: z.array(z.string().max(200)).max(20).optional(),
});
export type StructuredError = z.infer<typeof structuredErrorSchema>;

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly details: string[] | undefined;
  constructor(code: ErrorCode, message: string, details?: string[]) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
  toStructured(): StructuredError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof ProtocolError) return err.toStructured();
  if (err instanceof Error) {
    // Do not leak arbitrary error text that might contain page content:
    // only the error name and a bounded, generic message.
    return { code: 'internal', message: `${err.name}: ${err.message.slice(0, 200)}` };
  }
  return { code: 'internal', message: 'Unknown error' };
}

/** Generate an ID usable anywhere crypto.randomUUID exists (all our contexts). */
export function newId(): string {
  return crypto.randomUUID();
}
