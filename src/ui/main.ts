import type { StatusResult } from '../protocol';
import { Client } from './client';
import { h, replace } from './dom';
import { renderSession } from './sections/session';
import { renderStructure } from './sections/structure';
import { renderRecipe } from './sections/recipe';
import { renderObserve } from './sections/observe';
import { renderExport } from './sections/export';

export interface App {
  client: Client;
  status: StatusResult | null;
  refresh(): Promise<void>;
  /** Re-render every section from current status. */
  render(): void;
}

const STATUS_LABEL: Record<StatusResult['status'], string> = {
  notAttached: 'Not attached',
  attaching: 'Attaching…',
  ready: 'Ready for one-shot inspection',
  observing: 'Observing',
  pausedByUser: 'Paused by user',
  pausedAtLimit: 'Paused at a resource limit',
  staleDocument: 'Stale document',
  staleRoot: 'Stale root',
  permissionLost: 'Permission lost',
  unsupportedPage: 'Unsupported page',
  failure: 'Agent or extraction failure',
};

function sessionIdFromUrl(): string | null {
  return new URL(location.href).searchParams.get('session');
}

function renderBanner(status: StatusResult | null, error: string | null): void {
  const banner = document.getElementById('banner')!;
  if (!status) {
    replace(banner, h('span', { class: 'k' }, 'Session'), h('span', {}, error ?? 'Loading…'));
    return;
  }
  const src = status.source;
  replace(
    banner,
    h('span', { class: 'k' }, 'Source tab'),
    h('span', {}, src ? `tab ${src.tabId} — ${src.origin}` : 'none'),
    h('span', { class: 'k' }, 'Status'),
    h('span', {}, h('span', { class: 'status', 'data-status': status.status }, STATUS_LABEL[status.status]), status.statusDetail ? ` — ${status.statusDetail}` : ''),
    h('span', { class: 'k' }, 'Capture'),
    h('span', {}, status.captureMode === 'structureOnly' ? 'Structure only (no text)' : 'Selected fields (text of reviewed recipe fields)'),
    h('span', { class: 'k' }, 'Root'),
    h('span', {}, status.root.attached ? `${status.root.confirmed ? 'confirmed' : 'selected, not confirmed'} <${status.root.description?.tag ?? '?'}>` : 'none'),
    h('span', { class: 'k' }, 'Observation'),
    h(
      'span',
      {},
      status.observation.active ? 'active' : 'inactive',
      ` · snapshots ${status.observation.snapshotCount}/${status.limits.maxSnapshotsRetained}`,
      status.observation.lastSnapshotAt !== null ? ` · last ${new Date(status.observation.lastSnapshotAt).toLocaleTimeString()} (${status.observation.lastRecordCount} records, ${status.observation.lastMissingIdentityCount} without identity)` : '',
    ),
    error ? h('span', { class: 'k' }, 'Error') : null,
    error ? h('span', { class: 'err' }, error) : null,
  );
}

async function boot(): Promise<void> {
  const sessionId = sessionIdFromUrl();
  if (!sessionId) {
    renderBanner(null, 'No session. Open this page by clicking the extension action on the tab you want to inspect.');
    return;
  }
  const client = new Client(sessionId);
  const sections = {
    session: document.getElementById('section-session')!,
    structure: document.getElementById('section-structure')!,
    recipe: document.getElementById('section-recipe')!,
    observe: document.getElementById('section-observe')!,
    export: document.getElementById('section-export')!,
  };

  const app: App = {
    client,
    status: null,
    async refresh() {
      try {
        const { result } = await client.send({ command: 'getStatus' });
        if (result.type === 'status') app.status = result.status;
        renderBanner(app.status, null);
      } catch (err) {
        renderBanner(app.status, (err as Error).message);
      }
      app.render();
    },
    render() {
      renderSession(app, sections.session);
      renderStructure(app, sections.structure);
      renderRecipe(app, sections.recipe);
      renderObserve(app, sections.observe);
      renderExport(app, sections.export);
    },
  };

  // Tabs
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b === btn);
      for (const s of document.querySelectorAll<HTMLElement>('main section')) s.hidden = s.dataset['section'] !== btn.dataset['section'];
    });
  }

  client.onPush(() => void app.refresh());
  await app.refresh();
}

void boot();
