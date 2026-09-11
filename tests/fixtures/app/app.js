/* Synthetic messenger fixture. No network, deterministic ground truth.
 * Records are exposed via window.__fixture for tests to compare against. */
(function () {
  'use strict';

  const log = document.getElementById('log');
  const state = { conv: 'alpha', seq: 100, accountSwitched: false };

  // Ground truth. Alpha and Beta share identical text and overlapping timestamps
  // on purpose (PLAN §13): text must never be used as identity.
  const BASE = {
    alpha: [
      { id: 'a-1', sender: 'Ann', body: 'hello', at: '2024-01-01T10:00:00Z' },
      { id: 'a-2', sender: 'Bob', body: 'hello', at: '2024-01-01T10:00:05Z' },
      { id: 'a-3', sender: 'Ann', body: 'multi\nline\n\ttabbed — “quotes” 🎉 中文 עברית', at: '2024-01-01T10:01:00Z' },
      { id: 'a-4', sender: 'Bob', body: 'see https://example.com/path?q=secret#frag and @ann', at: '2024-01-01T10:02:00Z', link: 'https://example.com/path?q=secret#frag' },
      { id: 'a-5', sender: 'Ann', body: 'reply to a-2', at: '2024-01-01T10:03:00Z', replyTo: 'a-2' },
      { id: 'a-6', sender: 'Bob', body: '[attachment]', at: '2024-01-01T10:04:00Z', attachment: true },
      { id: 'a-7', sender: 'Ann', body: '<img src=x onerror="document.title=\'pwned\'"><script>alert(1)</script>&lt;b&gt;', at: '2024-01-01T10:05:00Z' },
      { id: 'a-8', sender: 'Bob', body: 'hidden by CSS', at: '2024-01-01T10:06:00Z', hidden: true },
      { id: 'a-9', sender: 'Ann', body: 'this is a rather long message that will be clamped in the preview column of the fixture', at: '2024-01-01T10:07:00Z' },
    ],
    beta: [
      { id: 'b-1', sender: 'Ann', body: 'hello', at: '2024-01-01T10:00:00Z' },
      { id: 'b-2', sender: 'Bob', body: 'hello', at: '2024-01-01T10:00:05Z' },
      { id: 'b-3', sender: 'Cid', body: 'hello', at: '2024-01-01T10:00:05Z' },
    ],
    virtual: Array.from({ length: 60 }, (_, i) => ({ id: `v-${i + 1}`, sender: i % 2 ? 'Bob' : 'Ann', body: `virtual message ${i + 1}`, at: new Date(Date.UTC(2024, 0, 2, 0, i)).toISOString() })),
    noids: [
      { sender: 'Ann', body: 'no id 1', at: '2024-01-03T00:00:00Z' },
      { sender: 'Bob', body: 'no id 2', at: '2024-01-03T00:01:00Z' },
      { sender: 'Ann', body: 'no id 1', at: '2024-01-03T00:02:00Z' },
    ],
  };
  const data = JSON.parse(JSON.stringify(BASE));

  function render(rec) {
    const el = document.createElement('article');
    el.className = 'msg' + (rec.hidden ? ' hidden-msg' : '');
    el.setAttribute('role', 'article');
    if (rec.id) el.dataset.recordId = rec.id;
    el.dataset.senderId = rec.sender.toLowerCase();
    if (rec.replyTo) el.dataset.replyTo = rec.replyTo;
    el.setAttribute('aria-label', `Message from ${rec.sender}`);

    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = rec.sender;

    const body = document.createElement('div');
    body.className = 'body';
    if (rec.link) {
      body.append(document.createTextNode('see '));
      const a = document.createElement('a');
      a.href = rec.link;
      a.textContent = rec.link;
      body.append(a, document.createTextNode(' and @ann'));
    } else {
      body.textContent = rec.body; // textContent: the injection payload stays inert text
    }
    if (rec.attachment) {
      const att = document.createElement('div');
      att.className = 'attachment';
      att.dataset.attachment = 'placeholder';
      att.textContent = '📎 image.png';
      body.append(att);
    }
    const time = document.createElement('time');
    time.setAttribute('datetime', rec.at);
    time.title = new Date(rec.at).toUTCString();
    time.textContent = new Date(rec.at).toISOString().slice(11, 16);

    const preview = document.createElement('span');
    preview.className = 'clamp';
    preview.textContent = rec.body;

    el.append(sender, body, time, preview);
    return el;
  }

  function renderConversation() {
    log.dataset.conversationId = state.conv;
    log.replaceChildren();
    if (state.conv === 'virtual') {
      renderVirtual();
      return;
    }
    for (const r of data[state.conv]) log.append(render(r));
    // Side effect of "opening" a conversation, like a real app's read receipt.
    const se = document.getElementById('side-effects');
    const n = Number(se.dataset.readReceipts) + 1;
    se.dataset.readReceipts = String(n);
    se.textContent = `read receipts sent: ${n}`;
  }

  // Virtualized list: keeps a fixed pool of 10 DOM nodes and rewrites them on scroll.
  const POOL = 10;
  let vOffset = 0;
  function renderVirtual() {
    const items = data.virtual;
    const existing = Array.from(log.children);
    for (let i = 0; i < POOL; i++) {
      const rec = items[vOffset + i];
      let node = existing[i];
      if (!rec) {
        if (node) node.remove();
        continue;
      }
      const fresh = render(rec);
      if (node) {
        // Reuse node: same DOM element, different record (PLAN §9 node reuse).
        node.replaceChildren(...fresh.childNodes);
        for (const a of Array.from(node.attributes)) if (a.name.startsWith('data-')) node.removeAttribute(a.name);
        for (const a of Array.from(fresh.attributes)) node.setAttribute(a.name, a.value);
      } else log.append(fresh);
    }
    log.dataset.virtualOffset = String(vOffset);
  }
  log.addEventListener('scroll', () => {
    if (state.conv !== 'virtual') return;
    const next = Math.min(data.virtual.length - POOL, Math.floor(log.scrollTop / 20));
    if (next !== vOffset) {
      vOffset = Math.max(0, next);
      renderVirtual();
    }
  });

  function route() {
    const m = location.hash.match(/^#\/c\/(\w+)$/);
    state.conv = m && data[m[1]] ? m[1] : 'alpha';
    renderConversation();
  }
  window.addEventListener('hashchange', route);
  route();

  // Controls
  const $ = (id) => document.getElementById(id);
  $('btn-incoming').onclick = () => {
    const rec = { id: `${state.conv[0]}-new-${++state.seq}`, sender: 'Cid', body: `incoming ${state.seq}`, at: new Date().toISOString() };
    data[state.conv].push(rec);
    if (state.conv !== 'virtual') log.append(render(rec));
    else renderVirtual();
  };
  $('btn-edit').onclick = () => {
    const list = data[state.conv];
    const rec = list[list.length - 1];
    rec.body += ' (edited)';
    const el = log.lastElementChild;
    if (el) el.querySelector('.body').textContent = rec.body;
  };
  $('btn-remove').onclick = () => {
    data[state.conv].shift();
    if (log.firstElementChild) log.firstElementChild.remove();
  };
  $('btn-older').onclick = () => {
    const older = { id: `${state.conv[0]}-old-${++state.seq}`, sender: 'Old', body: `older ${state.seq}`, at: '2023-12-31T00:00:00Z' };
    data[state.conv].unshift(older);
    log.prepend(render(older));
  };
  $('btn-replace-root').onclick = () => {
    const fresh = log.cloneNode(false);
    log.replaceWith(fresh);
    // rebind
    const newLog = document.getElementById('log');
    Object.defineProperty(window, '__logReplaced', { value: (window.__logReplaced || 0) + 1, configurable: true });
    for (const r of data[state.conv]) newLog.append(render(r));
  };
  $('btn-storm').onclick = () => {
    let n = 0;
    const t = setInterval(() => {
      const el = log.firstElementChild;
      if (el) el.querySelector('.body').textContent = `storm ${n}`;
      if (++n >= 200) clearInterval(t);
    }, 5);
  };
  $('btn-oversized').onclick = () => {
    const rec = { id: `${state.conv[0]}-big-${++state.seq}`, sender: 'Big', body: 'x'.repeat(20000) + ' END', at: new Date().toISOString() };
    data[state.conv].push(rec);
    log.append(render(rec));
  };
  $('btn-switch-account').onclick = () => {
    const acct = document.getElementById('account');
    acct.dataset.accountId = 'acct-2';
    acct.textContent = 'user-two';
    state.accountSwitched = true;
  };
  $('btn-push').onclick = () => {
    history.pushState({}, '', '/c/beta?ref=pushed');
  };

  // Open shadow root with a record inside; and a closed one that must stay opaque.
  const host = document.getElementById('shadow-host');
  const open = host.attachShadow({ mode: 'open' });
  const inShadow = document.createElement('div');
  inShadow.dataset.recordId = 'shadow-1';
  inShadow.className = 'msg';
  inShadow.textContent = 'inside open shadow root';
  open.append(inShadow);
  const closedHost = document.createElement('div');
  closedHost.id = 'closed-host';
  document.body.append(closedHost);
  const closed = closedHost.attachShadow({ mode: 'closed' });
  const c = document.createElement('p');
  c.dataset.recordId = 'closed-1';
  c.textContent = 'inside closed shadow root';
  closed.append(c);

  window.__fixture = {
    data,
    state,
    expected(conv) {
      return data[conv || state.conv].map((r) => ({ id: r.id || null, sender: r.sender, body: r.body, at: r.at }));
    },
  };
})();
