import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  captureModeSchema,
  generationSchema,
  idSchema,
  selectorSchema,
  sessionStatusSchema,
  structuredErrorSchema,
  warningSchema,
} from './common';
import { recipeSchema } from './recipe';
import {
  comparisonResultSchema,
  rootDescriptionSchema,
  snapshotSchema,
  structureSummarySchema,
  suggestedSelectorSchema,
} from './results';

/* ---------------------------------------------------------------------------
 * Envelope
 * ------------------------------------------------------------------------- */

const envelopeBase = {
  v: z.literal(PROTOCOL_VERSION),
  requestId: idSchema,
  sessionId: idSchema,
  generation: generationSchema,
};

/* ---------------------------------------------------------------------------
 * UI -> Background commands
 * Every command is a discriminated union member with bounded args.
 * ------------------------------------------------------------------------- */

export const uiCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('getStatus') }),
  /** Inject the agent into the source tab using the activeTab grant. */
  z.object({ command: z.literal('attach') }),
  z.object({ command: z.literal('detach') }),
  /** Detach (if attached) and erase all retained session content. */
  z.object({ command: z.literal('clearSession') }),
  z.object({ command: z.literal('pickRoot') }),
  z.object({ command: z.literal('cancelPick') }),
  z.object({ command: z.literal('setRoot'), selector: selectorSchema }),
  /** Confirms the currently proposed root so content extraction may run. */
  z.object({ command: z.literal('confirmRoot') }),
  z.object({ command: z.literal('inspectStructure'), includeSuggestedSelectors: z.boolean().default(false) }),
  z.object({ command: z.literal('setCaptureMode'), mode: captureModeSchema }),
  z.object({ command: z.literal('setRecipe'), recipe: recipeSchema.nullable() }),
  z.object({ command: z.literal('previewRecipe') }),
  z.object({ command: z.literal('startObservation') }),
  z.object({ command: z.literal('stopObservation') }),
  z.object({ command: z.literal('rescan') }),
  z.object({ command: z.literal('compareSnapshots'), fromSnapshotId: z.string().max(64), toSnapshotId: z.string().max(64) }),
  z.object({ command: z.literal('getSnapshots') }),
  /** Build the allowlisted report; UI shows preview and downloads. */
  z.object({
    command: z.literal('buildReport'),
    options: z.object({
      includeStructure: z.boolean().default(true),
      includeRecipe: z.boolean().default(false),
      includeSnapshots: z.boolean().default(false),
      includeComparisons: z.boolean().default(true),
      omitText: z.boolean().default(true),
      aliasIdentifiers: z.boolean().default(true),
      timestamps: z.enum(['keep', 'dayOnly', 'omit']).default('dayOnly'),
      urls: z.enum(['omit', 'originOnly', 'stripQuery', 'keep']).default('omit'),
      includeSuggestedSelectors: z.boolean().default(false),
    }),
  }),
]);
export type UiCommand = z.infer<typeof uiCommandSchema>;
export type UiCommandInput = z.input<typeof uiCommandSchema>;

/**
 * Session-less commands. `openSession` is how the UI learns its session ID.
 * The background creates the session when the action is clicked; the UI page
 * is opened with `?session=<id>` and then calls getStatus with it.
 */
export const uiRequestSchema = z.object({ ...envelopeBase, kind: z.literal('uiRequest'), payload: uiCommandSchema });
export type UiRequest = z.infer<typeof uiRequestSchema>;

/* ---------------------------------------------------------------------------
 * Background -> Agent commands
 * ------------------------------------------------------------------------- */

export const agentCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('hello') }),
  z.object({ command: z.literal('pickRoot') }),
  z.object({ command: z.literal('cancelPick') }),
  z.object({ command: z.literal('setRoot'), selector: selectorSchema }),
  z.object({ command: z.literal('describeRoot'), includeSuggestedSelectors: z.boolean() }),
  z.object({ command: z.literal('inspectStructure'), includeSuggestedSelectors: z.boolean() }),
  z.object({ command: z.literal('extract'), recipe: recipeSchema, captureMode: captureModeSchema, trigger: z.enum(['preview', 'manual', 'observationStart', 'mutation']) }),
  z.object({ command: z.literal('startObservation'), recipe: recipeSchema, captureMode: captureModeSchema }),
  z.object({ command: z.literal('stopObservation') }),
  z.object({ command: z.literal('detach') }),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;

export const agentRequestSchema = z.object({ ...envelopeBase, kind: z.literal('agentRequest'), payload: agentCommandSchema });
export type AgentRequest = z.infer<typeof agentRequestSchema>;

/* ---------------------------------------------------------------------------
 * Results
 * ------------------------------------------------------------------------- */

export const rootStateSchema = z.object({
  confirmed: z.boolean(),
  description: rootDescriptionSchema.nullable(),
  /** Only present when the user asked for suggestions. */
  suggestedSelectors: z.array(suggestedSelectorSchema).max(5).optional(),
  /** Selector as entered/confirmed by the user (user-authored, so may be shown). */
  userSelector: z.string().max(512).nullable(),
  attached: z.boolean(),
});
export type RootState = z.infer<typeof rootStateSchema>;

export const sourceSummarySchema = z.object({
  tabId: z.number().int(),
  /** Origin only. Path, query and fragment are never stored. */
  origin: z.string().max(512),
  /** Title is page content; stored only for display, excluded from exports by default. */
  title: z.string().max(200).nullable(),
});

export const sessionSnapshotMetaSchema = snapshotSchema.omit({ records: true });
export type SnapshotMeta = z.infer<typeof sessionSnapshotMetaSchema>;

export const statusResultSchema = z.object({
  sessionId: idSchema,
  generation: generationSchema,
  status: sessionStatusSchema,
  statusDetail: z.string().max(500).nullable(),
  source: sourceSummarySchema.nullable(),
  captureMode: captureModeSchema,
  root: rootStateSchema,
  recipe: recipeSchema.nullable(),
  structure: structureSummarySchema.nullable(),
  observation: z.object({
    active: z.boolean(),
    lastSnapshotAt: z.number().int().nullable(),
    lastRecordCount: z.number().int().nullable(),
    lastMissingIdentityCount: z.number().int().nullable(),
    snapshotCount: z.number().int(),
    retainedBytes: z.number().int(),
    pausedReason: z.string().max(300).nullable(),
  }),
  limits: z.record(z.string(), z.number()),
  activeWarnings: z.array(warningSchema).max(50),
});
export type StatusResult = z.infer<typeof statusResultSchema>;

export const resultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ok') }),
  z.object({ type: z.literal('status'), status: statusResultSchema }),
  z.object({ type: z.literal('agentHello'), generation: generationSchema, documentGeneration: z.string().max(64), href: z.string().max(2048) }),
  z.object({ type: z.literal('rootState'), root: rootStateSchema }),
  z.object({ type: z.literal('structure'), summary: structureSummarySchema }),
  z.object({ type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ type: z.literal('snapshots'), snapshots: z.array(sessionSnapshotMetaSchema).max(100) }),
  z.object({ type: z.literal('comparison'), comparison: comparisonResultSchema }),
  z.object({ type: z.literal('report'), report: z.unknown(), serializedBytes: z.number().int() }),
]);
export type Result = z.infer<typeof resultSchema>;

export const responseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('response'),
  requestId: idSchema,
  sessionId: idSchema,
  generation: generationSchema,
  ok: z.boolean(),
  result: resultSchema.optional(),
  error: structuredErrorSchema.optional(),
  warnings: z.array(warningSchema).max(50).default([]),
});
export type Response = z.infer<typeof responseSchema>;

/* ---------------------------------------------------------------------------
 * Agent -> Background events (unsolicited)
 * ------------------------------------------------------------------------- */

export const agentEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('pickResult'), root: rootStateSchema }),
  z.object({ event: z.literal('pickCancelled') }),
  z.object({ event: z.literal('rootLost'), reason: z.enum(['detached', 'replaced', 'navigation']) }),
  z.object({ event: z.literal('navigation'), sameDocument: z.boolean() }),
  z.object({ event: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ event: z.literal('observationPaused'), reason: z.string().max(300), warnings: z.array(warningSchema).max(20) }),
  z.object({ event: z.literal('unloading') }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentEventEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('agentEvent'),
  sessionId: idSchema,
  generation: generationSchema,
  payload: agentEventSchema,
});
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;

/* ---------------------------------------------------------------------------
 * Background -> UI push (status changes)
 * ------------------------------------------------------------------------- */

export const uiPushSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('uiPush'),
  sessionId: idSchema,
  payload: z.discriminatedUnion('event', [
    z.object({ event: z.literal('statusChanged') }),
    z.object({ event: z.literal('snapshotAdded'), snapshotId: z.string().max(64) }),
    z.object({ event: z.literal('pickResult'), root: rootStateSchema }),
  ]),
});
export type UiPush = z.infer<typeof uiPushSchema>;

/** Any message that may arrive at chrome.runtime.onMessage. */
export const anyMessageSchema = z.discriminatedUnion('kind', [
  uiRequestSchema,
  agentRequestSchema,
  responseSchema,
  agentEventEnvelopeSchema,
  uiPushSchema,
]);
export type AnyMessage = z.infer<typeof anyMessageSchema>;
