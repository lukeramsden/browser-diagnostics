import type { App } from '../main';
import { errorBox, h, replace } from '../dom';

export function renderSession(app: App, el: HTMLElement): void {
  const s = app.status;
  const busy = { current: false };
  const run = async (cmd: Parameters<App['client']['send']>[0]) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await app.client.send(cmd);
      await app.refresh();
    } catch (err) {
      await app.refresh();
      el.prepend(errorBox(err));
    } finally {
      busy.current = false;
    }
  };

  const canAttach = !!s && (s.status === 'notAttached' || s.status === 'staleDocument' || s.status === 'staleRoot' || s.status === 'failure' || s.status === 'pausedByUser' || s.status === 'pausedAtLimit');
  const attached = !!s && s.status !== 'notAttached' && s.status !== 'attaching' && s.status !== 'permissionLost' && s.status !== 'unsupportedPage';

  replace(
    el,
    h('h2', {}, 'Session'),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'What this tool does'),
      h('p', {}, 'It inspects one tab you chose by clicking the extension action, and only the part of the page you select as the inspection root. It never scans other tabs, never sends anything off this computer, and never sends messages, clicks controls or scrolls the page for you.'),
      h('h3', {}, 'Capture defaults'),
      h('p', {}, 'By default it collects structure only: tag and attribute-name counts, repeated shapes, visibility and boundary information. No text, links, IDs, class names or attribute values are recorded until you enable "selected fields" capture and review a recipe.'),
      h('h3', {}, 'Side effects you should expect'),
      h('p', {}, 'This tool only observes, but the page itself keeps reacting to what you do. Opening a conversation may send a read receipt; scrolling may load more data. The extension cannot prevent that.'),
      h('h3', {}, 'What "attach" grants'),
      h('p', {}, 'Attaching injects a small script into the selected tab using the temporary access Chrome granted when you clicked the extension action. That access ends when the tab navigates to another site or closes. This page will then say "Permission lost" instead of attaching to a different tab.'),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', disabled: !canAttach, onClick: () => void run({ command: 'attach' }) }, s?.generation ? 'Attach again' : 'Attach'),
      h('button', { disabled: !attached, onClick: () => void run({ command: 'detach' }) }, 'Stop (detach)'),
      h('button', { onClick: () => void run({ command: 'clearSession' }) }, 'Clear session content'),
      h('button', { onClick: () => void app.refresh() }, 'Refresh status'),
    ),
    h('p', { class: 'note' }, 'Clear removes everything this session retained (structure summaries, snapshots, comparisons). Files you already exported are outside its control.'),
    s?.activeWarnings.length ? h('div', {}, h('h3', {}, 'Active warnings'), ...s.activeWarnings.map((w) => h('div', { class: 'warn' }, `${w.code}: ${w.message}`))) : null,
    s
      ? h(
          'details',
          {},
          h('summary', {}, 'Limits in effect'),
          h('pre', {}, Object.entries(s.limits).map(([k, v]) => `${k}: ${v}`).join('\n')),
        )
      : null,
  );
}
