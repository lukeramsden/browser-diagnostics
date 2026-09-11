import { describe, expect, it } from 'vitest';
import { inspectStructure, shapeSignature } from '../../src/agent/structure';
import { traverse } from '../../src/agent/traversal';
import { describeElement, suggestSelectors } from '../../src/agent/root';
import { AGENT_MARKER_ATTR, isSensitiveControl, truncateUtf8, withinSensitiveControl } from '../../src/agent/dom';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

const SECRETS = ['SECRET_TEXT', 'secret-id', 'secret-class', 'https://secret.example', 'secret-value', 'Secret Label', 'draft-secret', 'pw-secret'];

const PAGE = `
<section id="secret-id" class="secret-class other" role="log" aria-label="Secret Label" data-conversation-id="secret-value">
  ${Array.from({ length: 5 }, (_, i) => `<article data-record-id="secret-value-${i}" class="msg"><span class="sender">SECRET_TEXT</span><div class="body">SECRET_TEXT ${i}</div><time datetime="2024-01-01T00:0${i}:00Z">t</time><a href="https://secret.example/${i}">l</a></article>`).join('')}
  <input type="password" value="pw-secret" />
  <div contenteditable="true">draft-secret</div>
  <iframe srcdoc="<p>x</p>"></iframe>
  <div ${AGENT_MARKER_ATTR}="x"><b>OUR UI</b></div>
</section>`;

describe('inspectStructure', () => {
  it('summarises structure without any page values', async () => {
    const root = mount(PAGE);
    const sum = await inspectStructure(root);
    const json = JSON.stringify(sum);
    for (const s of SECRETS) expect(json, `must not contain ${s}`).not.toContain(s);
    expect(sum.tagCounts['article']).toBe(5);
    expect(sum.tagCounts['time']).toBe(5);
    expect(sum.roleCounts['log']).toBe(1);
    expect(sum.attributeNameCounts['data-record-id']).toBe(5);
    expect(sum.attributeNameCounts['id']).toBe(1);
    expect(sum.attributeNameCounts['href']).toBe(5);
    expect(sum.linkCount).toBe(5);
    expect(sum.timeElementCount).toBe(5);
    expect(sum.iframeCount).toBe(1);
    expect(sum.sensitiveControlCount).toBe(2);
    expect(sum.warnings.some((w) => w.code === 'unsupportedBoundary')).toBe(true);
    // repeated shape detected
    expect(sum.repeatedShapes[0]?.shape).toBe('article>span,div,time,a');
    expect(sum.repeatedShapes[0]?.occurrences).toBe(5);
    // our own UI excluded
    expect(sum.tagCounts['b']).toBeUndefined();
    expect(sum.limitReached).toBe(false);
  });

  it('enters open shadow roots and counts them', async () => {
    const root = mount('<div><div id="host"></div></div>');
    const host = root.querySelector('#host')!;
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<p>in shadow</p><p>two</p>';
    const closedHost = document.createElement('div');
    root.appendChild(closedHost);
    closedHost.attachShadow({ mode: 'closed' }).innerHTML = '<em>closed</em>';
    const sum = await inspectStructure(root);
    expect(sum.openShadowRootCount).toBe(1);
    expect(sum.tagCounts['p']).toBe(2);
    expect(sum.tagCounts['em']).toBeUndefined();
  });

  it('reports limitReached instead of pretending completeness', async () => {
    const root = mount(`<div>${'<span></span>'.repeat(50)}</div>`);
    const sum = await inspectStructure(root, { maxNodes: 10 });
    expect(sum.limitReached).toBe(true);
    expect(sum.nodesVisited).toBe(10);
    expect(sum.warnings[0]?.code).toBe('limitReached');
    expect(sum.warnings[0]?.limit).toBe('structureMaxNodes');
    expect(sum.limits.maxNodes).toBe(10);
  });

  it('clips depth and reports it', async () => {
    let html = 'x';
    for (let i = 0; i < 10; i++) html = `<div>${html}</div>`;
    const root = mount(html);
    const stats = await traverse(root, () => undefined, { maxDepth: 3 });
    expect(stats.limitReached).toBe(true);
    expect(stats.limitKind).toBe('depth');
    expect(stats.maxDepthReached).toBe(3);
  });

  it('shapeSignature contains tag names only', () => {
    const el = mount('<li id="secret-id" class="secret-class"><a href="https://secret.example">SECRET_TEXT</a><time></time></li>');
    const sig = shapeSignature(el);
    expect(sig).toBe('li>a,time');
  });
});

describe('describeElement / suggestSelectors', () => {
  it('describes an element without values', () => {
    const el = mount('<article id="secret-id" class="a b" role="article" data-record-id="secret-value"><p>SECRET_TEXT</p></article>');
    const d = describeElement(el);
    expect(JSON.stringify(d)).not.toMatch(/secret|SECRET/);
    expect(d).toMatchObject({ tag: 'article', role: 'article', hasId: true, classCount: 2, dataAttributeCount: 1, childElementCount: 1, inShadowRoot: false });
  });

  it('flags selectors that embed page values', () => {
    const el = mount('<article id="secret-id" class="msg" data-record-id="secret-value"><p>t</p></article>');
    const sugg = suggestSelectors(el);
    const withValues = sugg.filter((s) => s.containsPageValues);
    const without = sugg.filter((s) => !s.containsPageValues);
    expect(withValues.some((s) => s.selector === '#secret-id')).toBe(true);
    expect(without.some((s) => s.selector === 'article[data-record-id]')).toBe(true);
    for (const s of without) expect(s.selector).not.toMatch(/secret/);
    for (const s of sugg) expect(s.matchCount).toBeGreaterThan(0);
  });
});

describe('sensitive controls', () => {
  it('identifies inputs, editors and their descendants', () => {
    const root = mount('<div><input value="x"><div contenteditable><b id="inner">draft</b></div><div contenteditable="false"><i id="ok">fine</i></div></div>');
    expect(isSensitiveControl(root.querySelector('input')!)).toBe(true);
    expect(withinSensitiveControl(root.querySelector('#inner')!)).toBe(true);
    expect(withinSensitiveControl(root.querySelector('#ok')!)).toBe(false);
  });
});

describe('truncateUtf8', () => {
  it('does not split code points', () => {
    const s = 'a€😀b';
    const r = truncateUtf8(s, 5); // a(1)+€(3)=4; 😀 is 4 → cut
    expect(r).toEqual({ value: 'a€', truncated: true });
    expect(truncateUtf8('abc', 10)).toEqual({ value: 'abc', truncated: false });
  });
});
