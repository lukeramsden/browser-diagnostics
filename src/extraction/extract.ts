import { LIMITS } from '../protocol/limits';
import { FORBIDDEN_ATTRIBUTE_PATTERNS } from '../protocol/recipe';
import { newId, type CaptureMode, type ExtractedRecord, type FieldValue, type Recipe, type RecipeField, type Snapshot, type Warning } from '../protocol';
import { fnv1a, isAgentUi, isSensitiveControl, isVisible, truncateUtf8, utf8Length, withinSensitiveControl } from '../agent/dom';

/**
 * Declarative recipe evaluation. Pure with respect to the page.
 * Selectors are the only "program"; there is no eval, no regex transforms,
 * no property paths.
 */

export interface ExtractOptions {
  captureMode: CaptureMode;
  trigger: Snapshot['trigger'];
  generation: number;
  /** Test hook: override limits. */
  limits?: Partial<Record<'extractionMaxRecords' | 'fieldMaxBytes' | 'multiValueMaxItems' | 'traversalMaxMs' | 'traversalSliceMs', number>>;
}

/* ---------------------------------------------------------------------------
 * Node handles: temporary per-document identity for node-reuse diagnostics.
 * A WeakMap keyed by Element means handles die with the document and never
 * leak into a report as anything but a small integer.
 * ------------------------------------------------------------------------- */
const handles = new WeakMap<Element, number>();
let nextHandle = 1;
export function nodeHandle(el: Element): number {
  let h = handles.get(el);
  if (h === undefined) {
    h = nextHandle++;
    handles.set(el, h);
  }
  return h;
}
/** Test-only: forget all handles. */
export function _resetHandlesForTests(): void {
  nextHandle = 1;
}

/* ---------------------------------------------------------------------------
 * Safe reads
 * ------------------------------------------------------------------------- */

/**
 * Text of an element excluding any sensitive control subtree (inputs,
 * editors, scripts…) and our own UI. Preserves whitespace, newlines and
 * Unicode exactly as in the DOM text nodes; no normalisation.
 */
export function safeText(el: Element): string {
  if (isSensitiveControl(el)) return '';
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (isSensitiveControl(e) || isAgentUi(e)) return;
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(el);
  return parts.join('');
}

function isForbiddenAttribute(name: string): boolean {
  return FORBIDDEN_ATTRIBUTE_PATTERNS.some((re) => re.test(name));
}

function resolve(record: Element, selector: string): Element[] | null {
  if (selector.trim() === ':scope') return [record];
  try {
    return Array.from(record.querySelectorAll(selector));
  } catch {
    return null;
  }
}

function readOne(el: Element, field: RecipeField): { value: string } | { missing: 'attributeAbsent' | 'sensitiveElement' | 'forbiddenAttribute' } {
  if (field.read === 'attribute') {
    if (isForbiddenAttribute(field.attribute)) return { missing: 'forbiddenAttribute' };
    // Attributes on sensitive controls (e.g. input value/placeholder) are off limits too.
    if (isSensitiveControl(el)) return { missing: 'sensitiveElement' };
    const v = el.getAttribute(field.attribute);
    return v === null ? { missing: 'attributeAbsent' } : { value: v };
  }
  if (withinSensitiveControl(el)) return { missing: 'sensitiveElement' };
  return { value: safeText(el) };
}

interface FieldRead {
  value: FieldValue;
  /** Raw source strings (pre-redaction) for identity/fingerprint. */
  raw: string[] | null;
  ambiguous: boolean;
}

function readField(record: Element, field: RecipeField, mode: CaptureMode, maxBytes: number, maxItems: number): FieldRead {
  const els = resolve(record, field.selector);
  if (els === null) return { value: { kind: 'missing', reason: 'invalidSelector', matchCount: 0 }, raw: null, ambiguous: false };
  const matchCount = els.length;

  if (field.read === 'exists') return { value: { kind: 'exists', value: matchCount > 0, matchCount }, raw: null, ambiguous: false };
  if (field.read === 'count') return { value: { kind: 'count', value: matchCount }, raw: null, ambiguous: false };

  if (matchCount === 0) return { value: { kind: 'missing', reason: 'noMatch', matchCount }, raw: null, ambiguous: false };

  const redact = mode === 'structureOnly';

  if (field.multiple) {
    const values: string[] = [];
    let truncated = false;
    let sourceBytes = 0;
    let missingReason: 'attributeAbsent' | 'sensitiveElement' | 'forbiddenAttribute' | null = null;
    for (const el of els.slice(0, maxItems)) {
      const r = readOne(el, field);
      if ('missing' in r) {
        missingReason ??= r.missing;
        continue;
      }
      sourceBytes += utf8Length(r.value);
      const t = truncateUtf8(r.value, maxBytes);
      truncated ||= t.truncated;
      values.push(t.value);
    }
    if (els.length > maxItems) truncated = true;
    if (values.length === 0 && missingReason) return { value: { kind: 'missing', reason: missingReason, matchCount }, raw: null, ambiguous: false };
    return {
      value: { kind: 'textList', values: redact ? values.map(() => '') : values, truncated, sourceBytes, redacted: redact, matchCount },
      raw: values,
      ambiguous: false,
    };
  }

  const r = readOne(els[0]!, field);
  if ('missing' in r) return { value: { kind: 'missing', reason: r.missing, matchCount }, raw: null, ambiguous: matchCount > 1 };
  const t = truncateUtf8(r.value, maxBytes);
  return {
    value: { kind: 'text', value: redact ? '' : t.value, truncated: t.truncated, sourceBytes: utf8Length(r.value), redacted: redact, matchCount },
    raw: [t.value],
    ambiguous: matchCount > 1,
  };
}

async function sha256Hex(s: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return fnv1a(s) + fnv1a(s.split('').reverse().join(''));
}

const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Identity separator unlikely to occur in values; values are also length-prefixed. */
function joinIdentity(values: string[]): string {
  return values.map((v) => `${v.length}:${v}`).join('\u001f');
}

export async function extract(root: Element, recipe: Recipe, opts: ExtractOptions): Promise<Snapshot> {
  const maxRecords = opts.limits?.extractionMaxRecords ?? LIMITS.extractionMaxRecords;
  const maxBytes = opts.limits?.fieldMaxBytes ?? LIMITS.fieldMaxBytes;
  const maxItems = opts.limits?.multiValueMaxItems ?? LIMITS.multiValueMaxItems;
  const maxMs = opts.limits?.traversalMaxMs ?? LIMITS.traversalMaxMs;
  const sliceMs = opts.limits?.traversalSliceMs ?? LIMITS.traversalSliceMs;
  const warnings: Warning[] = [];
  const start = performance.now();

  if (recipe.rootSelector) {
    let matches = false;
    try {
      matches = root.matches(recipe.rootSelector);
    } catch {
      warnings.push({ code: 'other', message: 'recipe.rootSelector is not valid CSS; ignored.' });
    }
    if (!matches) warnings.push({ code: 'other', message: 'The confirmed root does not match recipe.rootSelector. Extraction used the confirmed root anyway.' });
  }

  let all: Element[];
  try {
    all = Array.from(root.querySelectorAll(recipe.recordSelector)).filter((e) => !isAgentUi(e));
  } catch {
    return finish([], 0, true, [{ code: 'other', message: 'recordSelector is not valid CSS.' }]);
  }
  const limitReached = all.length > maxRecords;
  if (limitReached) {
    warnings.push({ code: 'limitReached', message: `${all.length} records matched; only the first ${maxRecords} in document order were captured.`, limit: 'extractionMaxRecords', limitValue: maxRecords });
  }
  const chosen = all.slice(0, maxRecords);
  const records: ExtractedRecord[] = [];
  let hiddenCount = 0;
  let sliceStart = performance.now();
  let timedOut = false;

  for (let index = 0; index < chosen.length; index++) {
    const now = performance.now();
    if (now - start > maxMs) {
      timedOut = true;
      break;
    }
    if (now - sliceStart > sliceMs) {
      await yieldToPage();
      sliceStart = performance.now();
    }
    const el = chosen[index]!;
    const fields: Record<string, FieldValue> = {};
    const missingRequired: string[] = [];
    const ambiguous: string[] = [];
    const rawByField = new Map<string, string[] | null>();
    for (const [name, field] of Object.entries(recipe.fields)) {
      const r = readField(el, field, opts.captureMode, maxBytes, maxItems);
      fields[name] = r.value;
      rawByField.set(name, r.raw);
      if (r.ambiguous) ambiguous.push(name);
      if (field.required && r.value.kind === 'missing') missingRequired.push(name);
    }

    let identityKey: string | null = null;
    let identityHashed = false;
    if (recipe.identityFields.length) {
      const vals: string[] = [];
      let complete = true;
      for (const f of recipe.identityFields) {
        const raw = rawByField.get(f);
        const v = raw?.[0];
        if (v === undefined || v === '') {
          complete = false;
          break;
        }
        vals.push(v);
      }
      if (complete) {
        const joined = joinIdentity(vals);
        if (opts.captureMode === 'structureOnly') {
          identityKey = `h:${await sha256Hex(joined)}`;
          identityHashed = true;
        } else identityKey = joined.length > 4096 ? `h:${await sha256Hex(joined)}` : joined;
        if (identityKey.startsWith('h:')) identityHashed = true;
      }
    }

    // Content fingerprint excludes identity fields so "same content, different identity" is detectable.
    const fpSource = Object.entries(recipe.fields)
      .filter(([name, f]) => (f.read === 'text' || f.read === 'attribute') && !recipe.identityFields.includes(name))
      .map(([name]) => `${name}=${(rawByField.get(name) ?? []).join('\u001e')}`)
      .join('\u001d');
    const contentFingerprint = fnv1a(fpSource) + fnv1a(fpSource.length + fpSource);

    const visible = isVisible(el);
    if (!visible) hiddenCount++;

    records.push({ index, nodeHandle: nodeHandle(el), fields, identityKey, identityHashed, contentFingerprint, visible, missingRequired, ambiguous });
  }

  if (timedOut) warnings.push({ code: 'limitReached', message: `Extraction stopped after ${maxMs} ms; ${records.length} of ${chosen.length} records were captured.`, limit: 'traversalMaxMs', limitValue: maxMs });
  const ambiguousCount = records.filter((r) => r.ambiguous.length).length;
  if (ambiguousCount) warnings.push({ code: 'ambiguousMatch', message: `${ambiguousCount} record(s) had single-valued fields matching more than one element; the first match was used.` });
  const missingReqCount = records.filter((r) => r.missingRequired.length).length;
  if (missingReqCount) warnings.push({ code: 'missingRequired', message: `${missingReqCount} record(s) lack a required field.` });
  const truncCount = records.filter((r) => Object.values(r.fields).some((f) => (f.kind === 'text' || f.kind === 'textList') && f.truncated)).length;
  if (truncCount) warnings.push({ code: 'truncated', message: `${truncCount} record(s) had a field truncated at ${maxBytes} bytes.`, limit: 'fieldMaxBytes', limitValue: maxBytes });
  if (recipe.identityFields.length) {
    const noId = records.filter((r) => r.identityKey === null).length;
    if (noId) warnings.push({ code: 'other', message: `${noId} record(s) have no extracted identity; they cannot be matched between snapshots.` });
  } else warnings.push({ code: 'other', message: 'Recipe has no identityFields; records cannot be tracked between snapshots.' });

  return finish(records, hiddenCount, limitReached || timedOut, warnings);

  function finish(recs: ExtractedRecord[], hidden: number, limit: boolean, w: Warning[]): Snapshot {
    return {
      snapshotId: newId(),
      generation: opts.generation,
      takenAt: Date.now(),
      trigger: opts.trigger,
      recordCount: recs.length,
      limitReached: limit,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      records: recs,
      hiddenCount: hidden,
      warnings: [...w].slice(0, 50),
      estimatedBytes: 0, // filled in by the session store when retained
    };
  }
}
