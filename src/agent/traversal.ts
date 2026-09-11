import { LIMITS } from '../protocol/limits';
import { isAgentUi } from './dom';

export interface TraversalOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxMs?: number;
  sliceMs?: number;
  /** Enter open shadow roots. Default true. */
  enterShadowRoots?: boolean;
}

export interface VisitedNode {
  el: Element;
  depth: number;
  inShadow: boolean;
}

export interface TraversalStats {
  nodesVisited: number;
  maxDepthReached: number;
  durationMs: number;
  limitReached: boolean;
  limitKind: 'nodes' | 'depth' | 'time' | null;
  openShadowRoots: number;
  iframes: number;
  /** Elements skipped because they exceed maxDepth (not visited). */
  depthClipped: number;
}

const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Bounded, chunked depth-first traversal. Skips the agent's own UI. Enters
 * open shadow roots (ordinary selectors do not, so this is the only way they
 * show up in reports). Never enters iframes. Yields to the page every
 * `sliceMs` so a large root cannot freeze the host.
 */
export async function traverse(root: Element, visit: (n: VisitedNode) => void, opts: TraversalOptions = {}): Promise<TraversalStats> {
  const maxNodes = opts.maxNodes ?? LIMITS.structureMaxNodes;
  const maxDepth = opts.maxDepth ?? LIMITS.structureMaxDepth;
  const maxMs = opts.maxMs ?? LIMITS.traversalMaxMs;
  const sliceMs = opts.sliceMs ?? LIMITS.traversalSliceMs;
  const enterShadow = opts.enterShadowRoots ?? true;

  const stats: TraversalStats = { nodesVisited: 0, maxDepthReached: 0, durationMs: 0, limitReached: false, limitKind: null, openShadowRoots: 0, iframes: 0, depthClipped: 0 };
  const start = performance.now();
  let sliceStart = start;

  // Stack of [element, depth, inShadow]; push children in reverse for document order.
  const stack: Array<[Element, number, boolean]> = [[root, 0, root.getRootNode() instanceof ShadowRoot]];

  while (stack.length) {
    const now = performance.now();
    if (now - start > maxMs) {
      stats.limitReached = true;
      stats.limitKind = 'time';
      break;
    }
    if (now - sliceStart > sliceMs) {
      await yieldToPage();
      sliceStart = performance.now();
    }
    const [el, depth, inShadow] = stack.pop()!;
    if (isAgentUi(el)) continue;
    if (stats.nodesVisited >= maxNodes) {
      stats.limitReached = true;
      stats.limitKind = 'nodes';
      break;
    }
    stats.nodesVisited++;
    if (depth > stats.maxDepthReached) stats.maxDepthReached = depth;
    visit({ el, depth, inShadow });

    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      stats.iframes++;
      continue; // boundary: never enter
    }

    if (depth >= maxDepth) {
      const clipped = el.childElementCount + (el.shadowRoot ? el.shadowRoot.childElementCount : 0);
      if (clipped > 0) {
        stats.depthClipped += clipped;
        stats.limitReached = true;
        stats.limitKind ??= 'depth';
      }
      continue;
    }

    if (enterShadow && el.shadowRoot) {
      stats.openShadowRoots++;
      const kids = el.shadowRoot.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1, true]);
    }
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1, inShadow]);
  }

  stats.durationMs = Math.round((performance.now() - start) * 10) / 10;
  return stats;
}
