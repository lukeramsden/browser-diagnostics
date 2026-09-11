import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observer } from '../../src/agent/observer';
import type { Recipe, Snapshot, Warning } from '../../src/protocol';

const recipe: Recipe = { schemaVersion: 1, name: 'r', recordSelector: 'li', fields: { id: { selector: ':scope', read: 'attribute', attribute: 'data-id', required: false, multiple: false }, t: { selector: ':scope', read: 'text', required: false, multiple: false } }, identityFields: ['id'] };

function setup() {
  document.body.innerHTML = '<ul id="root"><li data-id="1">a</li></ul>';
  const root = document.getElementById('root')!;
  const snapshots: Snapshot[] = [];
  const paused: Array<{ reason: string; warnings: Warning[] }> = [];
  let rootLost = 0;
  const obs = new Observer(root, recipe, 'selectedFields', 1, { onSnapshot: (s) => snapshots.push(s), onPaused: (reason, warnings) => paused.push({ reason, warnings }), onRootLost: () => rootLost++ }, { debounceMs: 50, minIntervalMs: 200 });
  return { root, obs, snapshots, paused, rootLost: () => rootLost };
}

// Flush microtasks + MutationObserver callbacks + extract()'s awaits.
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Observer', () => {
  it('takes an initial snapshot, coalesces a burst into one rescan and skips unchanged results', async () => {
    const { root, obs, snapshots } = setup();
    await obs.start();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.trigger).toBe('observationStart');
    for (let i = 2; i <= 6; i++) root.insertAdjacentHTML('beforeend', `<li data-id="${i}">x</li>`);
    await settle(10);
    expect(snapshots).toHaveLength(1); // debounced
    await settle(300);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.trigger).toBe('mutation');
    expect(snapshots[1]!.recordCount).toBe(6);
    // A mutation that does not change the extraction (attribute the recipe ignores) is not emitted.
    root.firstElementChild!.setAttribute('data-noise', 'z');
    await settle(400);
    expect(snapshots).toHaveLength(2);
    expect(obs.unchangedRescans).toBe(1);
    obs.stop();
  });

  it('ignores mutations from the extension UI and stops when the root is detached', async () => {
    const { root, obs, snapshots, rootLost } = setup();
    await obs.start();
    const ui = document.createElement('div');
    ui.setAttribute('data-browser-diagnostics-ui', 'picker');
    root.appendChild(ui);
    ui.textContent = 'overlay';
    await settle(400);
    expect(snapshots).toHaveLength(1);
    root.remove();
    root.appendChild(document.createElement('li'));
    await settle(400);
    expect(rootLost()).toBe(1);
    expect(snapshots).toHaveLength(1);
  });

  it('manual rescan always emits; stop() prevents further snapshots', async () => {
    const { root, obs, snapshots } = setup();
    await obs.start();
    await obs.rescan();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.trigger).toBe('manual');
    obs.stop();
    root.insertAdjacentHTML('beforeend', '<li data-id="9">z</li>');
    await settle(500);
    expect(snapshots).toHaveLength(2);
  });
});
