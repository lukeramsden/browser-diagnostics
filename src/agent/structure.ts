import { LIMITS } from '../protocol/limits';
import type { StructureSummary, Warning } from '../protocol';
import { isSensitiveControl, isTextTruncated, isVisible } from './dom';
import { traverse, type TraversalOptions } from './traversal';

/**
 * Attribute *names* that may appear in a structure summary. Values are never
 * reported. `data-*` names are developer-authored and are counted by name,
 * capped in number, because they are the main clue for recipe authoring.
 */
const ATTRIBUTE_NAME_ALLOWLIST = new Set([
  'id',
  'class',
  'role',
  'href',
  'src',
  'alt',
  'title',
  'tabindex',
  'datetime',
  'dir',
  'lang',
  'hidden',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-live',
  'aria-selected',
  'aria-expanded',
  'aria-current',
  'contenteditable',
  'draggable',
  'style',
]);
const MAX_DATA_ATTRIBUTE_NAMES = 50;
const MAX_DISTINCT_TAGS = 100;
const MAX_DISTINCT_ROLES = 50;
const MAX_SHAPES = 50;
const MAX_SHAPE_LENGTH = 200;

function bump(map: Map<string, number>, key: string, cap: number): void {
  if (map.has(key)) map.set(key, map.get(key)! + 1);
  else if (map.size < cap) map.set(key, 1);
  else {
    const other = map.get('(other)') ?? 0;
    map.set('(other)', other + 1);
  }
}

/**
 * Shape signature of an element: its tag followed by the tags of its direct
 * children. Contains no attribute values or text. Used to find repeated
 * sibling shapes, which are candidate record containers.
 */
export function shapeSignature(el: Element): string {
  const kids: string[] = [];
  for (let i = 0; i < el.children.length && i < 12; i++) kids.push(el.children[i]!.tagName.toLowerCase());
  const sig = `${el.tagName.toLowerCase()}>${kids.join(',')}${el.children.length > 12 ? ',…' : ''}`;
  return sig.length > MAX_SHAPE_LENGTH ? sig.slice(0, MAX_SHAPE_LENGTH) : sig;
}

export async function inspectStructure(root: Element, opts: TraversalOptions = {}): Promise<StructureSummary> {
  const tagCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const attrNames = new Map<string, number>();
  const dataNames = new Map<string, number>();
  let dataAttributeElementCount = 0;
  let timeElementCount = 0;
  let linkCount = 0;
  let ariaLabelledCount = 0;
  let visibleElementCount = 0;
  let hiddenElementCount = 0;
  let truncatedTextCandidates = 0;
  let sensitiveControlCount = 0;

  // parent -> (shape -> count) for repeated sibling detection
  const shapesByParent = new Map<Element, Map<string, number>>();
  const depthByParent = new Map<Element, number>();

  // Visibility is expensive (getComputedStyle). Sample it: check every element
  // up to a budget, then every Nth.
  let visibilityChecks = 0;
  const VISIBILITY_BUDGET = 1500;

  const stats = await traverse(
    root,
    ({ el, depth }) => {
      bump(tagCounts, el.tagName.toLowerCase(), MAX_DISTINCT_TAGS);
      const role = el.getAttribute('role');
      if (role) bump(roleCounts, role.slice(0, 32), MAX_DISTINCT_ROLES);

      let hasData = false;
      for (const attr of el.attributes) {
        const name = attr.name;
        if (name.startsWith('data-')) {
          hasData = true;
          bump(dataNames, name.slice(0, 64), MAX_DATA_ATTRIBUTE_NAMES);
        } else if (ATTRIBUTE_NAME_ALLOWLIST.has(name)) {
          bump(attrNames, name, 64);
        } else if (name.startsWith('aria-')) {
          bump(attrNames, 'aria-(other)', 64);
        } else {
          bump(attrNames, '(other)', 64);
        }
      }
      if (hasData) dataAttributeElementCount++;
      if (el.tagName === 'TIME') timeElementCount++;
      if (el.tagName === 'A' && el.hasAttribute('href')) linkCount++;
      if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ariaLabelledCount++;
      if (isSensitiveControl(el)) sensitiveControlCount++;

      if (visibilityChecks < VISIBILITY_BUDGET || visibilityChecks % 10 === 0) {
        if (isVisible(el)) {
          visibleElementCount++;
          if (isTextTruncated(el)) truncatedTextCandidates++;
        } else hiddenElementCount++;
      }
      visibilityChecks++;

      const parent = el.parentElement;
      if (parent && depth > 0) {
        let m = shapesByParent.get(parent);
        if (!m) {
          if (shapesByParent.size < 2000) {
            m = new Map();
            shapesByParent.set(parent, m);
            depthByParent.set(parent, depth - 1);
          }
        }
        if (m) bump(m, shapeSignature(el), 20);
      }
    },
    opts,
  );

  // Aggregate repeated shapes: a shape counts if ≥3 siblings under one parent share it.
  const agg = new Map<string, { occurrences: number; parents: number; depth: number }>();
  for (const [parent, m] of shapesByParent) {
    for (const [shape, n] of m) {
      if (n < 3 || shape === '(other)') continue;
      const cur = agg.get(shape);
      const depth = depthByParent.get(parent) ?? 0;
      if (cur) {
        cur.occurrences += n;
        cur.parents += 1;
        cur.depth = Math.min(cur.depth, depth);
      } else agg.set(shape, { occurrences: n, parents: 1, depth });
    }
  }
  const repeatedShapes = [...agg.entries()]
    .map(([shape, v]) => ({ shape, occurrences: v.occurrences, parentCount: v.parents, depth: v.depth }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, MAX_SHAPES);

  const warnings: Warning[] = [];
  if (stats.limitReached) {
    warnings.push({
      code: 'limitReached',
      message: `Traversal stopped at the ${stats.limitKind} limit; the summary covers only the visited part of the root.`,
      limit: stats.limitKind === 'nodes' ? 'structureMaxNodes' : stats.limitKind === 'depth' ? 'structureMaxDepth' : 'traversalMaxMs',
      limitValue: stats.limitKind === 'nodes' ? (opts.maxNodes ?? LIMITS.structureMaxNodes) : stats.limitKind === 'depth' ? (opts.maxDepth ?? LIMITS.structureMaxDepth) : (opts.maxMs ?? LIMITS.traversalMaxMs),
    });
  }
  if (stats.iframes > 0) warnings.push({ code: 'unsupportedBoundary', message: `${stats.iframes} iframe(s) were not entered.` });
  if (visibilityChecks > VISIBILITY_BUDGET) warnings.push({ code: 'other', message: 'Visibility was sampled after the first 1500 elements; visible/hidden counts are estimates.' });
  if (stats.durationMs > 1000) warnings.push({ code: 'slowTraversal', message: `Traversal took ${Math.round(stats.durationMs)} ms.` });

  const attributeNameCounts: Record<string, number> = {};
  for (const [k, v] of attrNames) attributeNameCounts[k] = v;
  for (const [k, v] of dataNames) attributeNameCounts[k] = v;

  return {
    nodesVisited: stats.nodesVisited,
    maxDepthReached: stats.maxDepthReached,
    durationMs: stats.durationMs,
    limits: { maxNodes: opts.maxNodes ?? LIMITS.structureMaxNodes, maxDepth: opts.maxDepth ?? LIMITS.structureMaxDepth, maxMs: opts.maxMs ?? LIMITS.traversalMaxMs },
    limitReached: stats.limitReached,
    tagCounts: Object.fromEntries(tagCounts),
    roleCounts: Object.fromEntries(roleCounts),
    attributeNameCounts,
    dataAttributeElementCount,
    timeElementCount,
    linkCount,
    ariaLabelledCount,
    visibleElementCount,
    hiddenElementCount,
    truncatedTextCandidates,
    openShadowRootCount: stats.openShadowRoots,
    iframeCount: stats.iframes,
    sensitiveControlCount,
    repeatedShapes,
    warnings,
  };
}
