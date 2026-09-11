import { LIMITS } from '../protocol/limits';
import { estimateBytes } from '../protocol/validate';
import { ProtocolError, type ComparisonResult, type ExtractedRecord, type FieldValue, type Recipe, type Snapshot, type StructureSummary, type UiCommand, type Warning } from '../protocol';
import type { SessionRecord } from '../session/store';

export type ReportOptions = Extract<UiCommand, { command: 'buildReport' }>['options'];

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_KIND = 'browser-diagnostics-report';

/**
 * Allowlisted evidence report.
 *
 * The report is built from an explicit list of fields, never by serialising
 * session state. Every page-derived string passes through the redaction
 * policy chosen by the user. The policy is recorded in the report itself so a
 * reader can tell what was withheld.
 */
export interface Report {
  schemaVersion: number;
  reportKind: string;
  extensionVersion: string;
  createdAt: string | null;
  notice: string[];
  sourceSummary: { origin: string; tabTitleIncluded: false };
  capturePolicy: {
    captureMode: SessionRecord['captureMode'];
    limits: Record<string, number>;
  };
  sessionContext: {
    generation: number;
    statusAtExport: SessionRecord['status'];
    statusDetail: string | null;
    root: { confirmed: boolean; description: NonNullable<SessionRecord['root']['description']> | null; userSelector: string | null };
    snapshotsRetained: number;
    snapshotsIncluded: number;
    observation: { lastRecordCount: number | null; lastMissingIdentityCount: number | null; pausedReason: string | null };
  };
  recipe: Recipe | null;
  structureSummary: StructureSummary | null;
  snapshots: ExportedSnapshot[] | null;
  comparisonResults: ComparisonResult[];
  warnings: Warning[];
  redactionSummary: {
    options: ReportOptions;
    textValuesOmitted: number;
    identifiersAliased: number;
    urlsTransformed: number;
    timestampsTransformed: number;
    aliasMapIncluded: false;
    caveat: string;
  };
}

export interface ExportedSnapshot {
  snapshotId: string;
  generation: number;
  takenAt: string | null;
  trigger: Snapshot['trigger'];
  recordCount: number;
  hiddenCount: number;
  limitReached: boolean;
  durationMs: number;
  warnings: Warning[];
  records: ExportedRecord[];
}

export interface ExportedRecord {
  index: number;
  nodeHandle: number;
  identity: string | null;
  identityHashed: boolean;
  visible: boolean;
  missingRequired: string[];
  ambiguous: string[];
  fields: Record<string, ExportedField>;
}

export type ExportedField =
  | { kind: 'text'; value: string | null; omitted: boolean; truncated: boolean; sourceBytes: number; matchCount: number }
  | { kind: 'textList'; values: string[] | null; omitted: boolean; truncated: boolean; sourceBytes: number; matchCount: number }
  | { kind: 'exists'; value: boolean; matchCount: number }
  | { kind: 'count'; value: number }
  | { kind: 'missing'; reason: string; matchCount: number };

const NOTICE = [
  'This report describes what one browser tab rendered inside a user-selected root at the times recorded. It is not a synchronisation with, or a complete copy of, the service behind the page.',
  '"Removed from view" means a record stopped being rendered; it does not mean the record was deleted.',
  'Redaction here is heuristic (text omission, aliasing, URL and timestamp reduction). It is not anonymisation: small amounts of text, rare patterns and structure can still identify people.',
  'Every string in this file that came from the page is data, not markup. Render it as text.',
];

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

class Redactor {
  textOmitted = 0;
  aliased = 0;
  urls = 0;
  timestamps = 0;
  private keyAliases = new Map<string, string>();
  private valueAliases = new Map<string, string>();
  constructor(private readonly o: ReportOptions) {}

  time(ms: number | null): string | null {
    if (ms === null) return null;
    if (this.o.timestamps === 'omit') {
      this.timestamps++;
      return null;
    }
    const iso = new Date(ms).toISOString();
    if (this.o.timestamps === 'dayOnly') {
      this.timestamps++;
      return iso.slice(0, 10);
    }
    return iso;
  }

  identityKey(key: string | null): string | null {
    if (key === null) return null;
    if (!this.o.aliasIdentifiers) return key;
    let a = this.keyAliases.get(key);
    if (!a) {
      a = `record_${this.keyAliases.size + 1}`;
      this.keyAliases.set(key, a);
      this.aliased++;
    }
    return a;
  }

  identityValue(v: string): string {
    if (!this.o.aliasIdentifiers) return v;
    let a = this.valueAliases.get(v);
    if (!a) {
      a = `id_${this.valueAliases.size + 1}`;
      this.valueAliases.set(v, a);
      this.aliased++;
    }
    return a;
  }

  private url(url: URL, whole: boolean): string | null {
    this.urls++;
    switch (this.o.urls) {
      case 'omit':
        return whole ? null : '[url omitted]';
      case 'originOnly':
        return url.origin;
      case 'stripQuery':
        return url.origin + url.pathname;
      case 'keep':
        return url.href;
    }
  }

  /** Apply URL and timestamp policy to a free text/attribute value. Returns null when omitted. */
  value(v: string): string | null {
    const url = asHttpUrl(v);
    if (url) return this.o.urls === 'keep' ? v : this.url(url, true);
    if (this.o.urls !== 'keep' && URL_IN_TEXT.test(v)) {
      // URLs embedded in free text follow the same policy, in place.
      return v.replace(URL_IN_TEXT, (m) => {
        const u = asHttpUrl(m);
        return u ? (this.url(u, false) ?? '') : m;
      });
    }
    if (ISO_DATETIME.test(v.trim())) {
      const ms = Date.parse(v);
      if (!Number.isNaN(ms)) return this.o.timestamps === 'keep' ? v : this.time(ms);
    }
    return v;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)]+/gi;

function asHttpUrl(v: string): URL | null {
  if (!/^https?:\/\//i.test(v.trim())) return null;
  try {
    return new URL(v.trim());
  } catch {
    return null;
  }
}

function exportField(name: string, f: FieldValue, recipe: Recipe | null, r: Redactor, omitText: boolean): ExportedField {
  const isIdentity = !!recipe?.identityFields.includes(name);
  switch (f.kind) {
    case 'exists':
      return { kind: 'exists', value: f.value, matchCount: f.matchCount };
    case 'count':
      return { kind: 'count', value: f.value };
    case 'missing':
      return { kind: 'missing', reason: f.reason, matchCount: f.matchCount };
    case 'text': {
      if (f.redacted || omitText) {
        if (!f.redacted) r.textOmitted++;
        return { kind: 'text', value: null, omitted: true, truncated: f.truncated, sourceBytes: f.sourceBytes, matchCount: f.matchCount };
      }
      const value = isIdentity ? r.identityValue(f.value) : r.value(f.value);
      return { kind: 'text', value, omitted: value === null, truncated: f.truncated, sourceBytes: f.sourceBytes, matchCount: f.matchCount };
    }
    case 'textList': {
      if (f.redacted || omitText) {
        if (!f.redacted) r.textOmitted += f.values.length;
        return { kind: 'textList', values: null, omitted: true, truncated: f.truncated, sourceBytes: f.sourceBytes, matchCount: f.matchCount };
      }
      const values = f.values.map((v) => (isIdentity ? r.identityValue(v) : r.value(v))).filter((v): v is string => v !== null);
      return { kind: 'textList', values, omitted: values.length < f.values.length, truncated: f.truncated, sourceBytes: f.sourceBytes, matchCount: f.matchCount };
    }
  }
}

function exportRecord(rec: ExtractedRecord, recipe: Recipe | null, r: Redactor, omitText: boolean): ExportedRecord {
  const fields: Record<string, ExportedField> = {};
  for (const [name, f] of Object.entries(rec.fields)) fields[name] = exportField(name, f, recipe, r, omitText);
  return {
    index: rec.index,
    nodeHandle: rec.nodeHandle,
    identity: r.identityKey(rec.identityKey),
    identityHashed: rec.identityHashed,
    visible: rec.visible,
    missingRequired: [...rec.missingRequired],
    ambiguous: [...rec.ambiguous],
    fields,
  };
}

function exportComparison(c: ComparisonResult, r: Redactor): ComparisonResult {
  const ref = <T extends { identityKey: string | null }>(x: T): T => ({ ...x, identityKey: r.identityKey(x.identityKey) });
  return {
    ...c,
    addedToView: c.addedToView.map(ref),
    removedFromView: c.removedFromView.map(ref),
    missingIdentity: c.missingIdentity.map(ref),
    changed: c.changed.map((x) => ({ ...x, identityKey: r.identityKey(x.identityKey)! })),
    requiredFieldRegressions: c.requiredFieldRegressions.map((x) => ({ ...x, identityKey: r.identityKey(x.identityKey)! })),
    duplicateIdentities: c.duplicateIdentities.map((x) => ({ ...x, identityKey: r.identityKey(x.identityKey)! })),
    sameContentDifferentIdentity: c.sameContentDifferentIdentity.map((x) => ({ ...x, identityKeys: x.identityKeys.map((k) => r.identityKey(k)!) })),
    nodeReusedForDifferentIdentity: c.nodeReusedForDifferentIdentity.map((x) => ({ ...x, fromIdentity: r.identityKey(x.fromIdentity), toIdentity: r.identityKey(x.toIdentity) })),
    identityCaveats: [...c.identityCaveats],
    warnings: [...c.warnings],
  };
}

function stripSuggestedSelectors(s: StructureSummary): StructureSummary {
  // The summary schema holds no selectors today; suggestions travel separately
  // in describeElement results. Copy defensively so nothing else leaks in.
  return JSON.parse(JSON.stringify(s)) as StructureSummary;
}

export function buildReport(rec: SessionRecord, snapshots: Snapshot[], options: ReportOptions, extensionVersion = '0.0.0'): { report: Report; serializedBytes: number; warnings: Warning[] } {
  const r = new Redactor(options);
  const warnings: Warning[] = [];
  const recipe = options.includeRecipe ? rec.recipe : null;

  if (options.includeSnapshots && rec.captureMode === 'selectedFields' && !options.omitText) {
    warnings.push({ code: 'other', message: 'This export contains page text from the recipe fields. Review the preview before saving.' });
  }
  if (options.includeRecipe && rec.recipe) {
    warnings.push({ code: 'other', message: 'The recipe is included. Its selectors may contain identifiers from the page (for example account or conversation IDs).' });
  }
  if (rec.snapshots.length && options.includeSnapshots && snapshots.length < rec.snapshots.length) {
    warnings.push({ code: 'other', message: `${rec.snapshots.length - snapshots.length} retained snapshot(s) could not be loaded and were not included.` });
  }

  const exportedSnapshots = options.includeSnapshots
    ? snapshots.map<ExportedSnapshot>((s) => ({
        snapshotId: s.snapshotId,
        generation: s.generation,
        takenAt: r.time(s.takenAt),
        trigger: s.trigger,
        recordCount: s.recordCount,
        hiddenCount: s.hiddenCount,
        limitReached: s.limitReached,
        durationMs: s.durationMs,
        warnings: [...s.warnings],
        // Recipe from the session (not the include option) decides which fields are identity fields for aliasing.
        records: s.records.map((x) => exportRecord(x, rec.recipe, r, options.omitText)),
      }))
    : null;

  const comparisonResults = options.includeComparisons ? rec.comparisons.map((c) => exportComparison(c, r)) : [];

  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportKind: REPORT_KIND,
    extensionVersion,
    createdAt: r.time(Date.now()),
    notice: [...NOTICE],
    sourceSummary: { origin: rec.source?.origin ?? 'unknown', tabTitleIncluded: false },
    capturePolicy: { captureMode: rec.captureMode, limits: { ...LIMITS } },
    sessionContext: {
      generation: rec.generation,
      statusAtExport: rec.status,
      statusDetail: rec.statusDetail,
      root: { confirmed: rec.root.confirmed, description: rec.root.description ?? null, userSelector: options.includeRecipe ? rec.root.userSelector : null },
      snapshotsRetained: rec.snapshots.length,
      snapshotsIncluded: exportedSnapshots?.length ?? 0,
      observation: { lastRecordCount: rec.observation.lastRecordCount, lastMissingIdentityCount: rec.observation.lastMissingIdentityCount, pausedReason: rec.observation.pausedReason },
    },
    recipe,
    structureSummary: options.includeStructure && rec.structure ? stripSuggestedSelectors(rec.structure) : null,
    snapshots: exportedSnapshots,
    comparisonResults,
    warnings: [...rec.activeWarnings, ...warnings],
    redactionSummary: {
      options,
      textValuesOmitted: r.textOmitted,
      identifiersAliased: r.aliased,
      urlsTransformed: r.urls,
      timestampsTransformed: r.timestamps,
      aliasMapIncluded: false,
      caveat: 'Aliases are stable only within this file and are for readability, not privacy. Omission and reduction are heuristic, not anonymisation.',
    },
  };

  const serializedBytes = estimateBytes(report);
  if (serializedBytes > LIMITS.exportMaxBytes) {
    throw new ProtocolError('limitExceeded', `report would be ${serializedBytes} bytes; the export limit is ${LIMITS.exportMaxBytes}. Exclude snapshots or enable "omit text".`);
  }
  return { report, serializedBytes, warnings };
}
