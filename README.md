# Browser Diagnostics

[![CI](https://github.com/lukeramsden/browser-diagnostics/actions/workflows/ci.yml/badge.svg)](https://github.com/lukeramsden/browser-diagnostics/actions/workflows/ci.yml)

A local-only Chrome (Manifest V3) extension for investigating how an authenticated web application exposes rendered data to a content script. It answers one question: *what structure and identifiers does this page expose inside a root I choose, and can records be extracted repeatably?*

It is **not** a synchroniser, importer, scraper or message client. It observes what one tab renders inside one user-selected root, at the times you look. Records that scroll out of a virtualised list are "removed from view", not deleted; records never rendered are never seen.

Everything stays on your machine: no remote scripts, fonts, telemetry or uploads. Captured data lives in `chrome.storage.session` (cleared when the browser closes) until you clear it or export it as a file you review first. See [`docs/privacy.md`](docs/privacy.md).

## Install (unpacked)

```sh
npm install
npm run build          # writes dist/
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, choose `dist/`.
2. Open the tab you want to inspect, then click the extension's toolbar action. A diagnostics page opens in a new tab, bound to that one source tab.

The manifest requests only `activeTab`, `scripting` and `storage`. There are no host permissions; the extension can only touch a tab after you click its action on that tab, and access ends when that tab navigates to another origin or closes.

Minimum Chrome: 116. Platform constraints and their sources are in [`docs/platform-notes.md`](docs/platform-notes.md).

## Using it

The diagnostics page has five sections. Each step is explicit; nothing runs until you ask.

1. **Session** — *Attach* injects the agent into the source tab. *Stop (detach)* removes it. *Clear session content* erases everything retained for this session. The banner always shows one of: not attached, ready for one-shot inspection, observing, paused by user, paused at a resource limit, stale document, stale root, permission lost, unsupported page, failure.
2. **Structure** — pick a root by CSS selector or with the on-page picker, then *confirm* it. *Inspect structure* produces a bounded summary (tag/role/attribute-name counts, repeated shapes, shadow-root and iframe counts, sensitive-control counts). It contains no text, IDs, classes, URLs or attribute values.
3. **Recipe** — a declarative JSON recipe (record selector + field selectors + read operations). See [`docs/recipe-format.md`](docs/recipe-format.md). Default capture mode is *structure only*: previews show field presence, lengths and match counts but withhold values. Switch to *selected fields* to see the values of the reviewed fields; a preview is required before observing with values enabled.
4. **Observe** — watches the confirmed root for DOM mutations, re-runs the recipe (debounced, ≤ ~1/s) and retains a snapshot when the result changed. Pick two snapshots and *Compare*: added to view, removed from view, changed, duplicate identities, same content under different identities, node reuse, records without identity. Observation pauses (never truncates silently) at 20 snapshots or 4 MiB.
5. **Export** — builds an allowlisted, versioned, self-describing JSON report from options you choose (structure / comparisons / snapshots / recipe; omit text, alias identifiers, reduce timestamps, omit or strip URLs). You see the exact JSON before confirming the save. The source is recorded as origin only.

The step-by-step protocol for validating a real site, and the definitions used (visible, identity, removed-from-view), are in [`docs/validation-guide.md`](docs/validation-guide.md). Record results with [`docs/findings-template.md`](docs/findings-template.md).

## Limits

| Limit | Value | Surfaced as |
|---|---|---|
| Structure traversal | 5 000 nodes, depth 30, 3 s | `limitReached` in the summary |
| Records per extraction | 200 | `limitReached` + warning |
| Text per field | 8 KiB (UTF‑8, code-point safe) | `truncated: true` + marker |
| Values per multi-valued field | 50 | `truncated: true` |
| Recipe fields | 20 | recipe rejected |
| Snapshots retained | 20 or 4 MiB | status *paused at a resource limit* |
| Single message | 1 MiB | request rejected |
| Export | 8 MiB | build refused with explanation |

## Development

```sh
npm test               # Vitest unit tests (jsdom)
npm run build:test     # dist-test/ with localhost host permission for the fixture only
npm run test:e2e       # Playwright against the built extension + synthetic fixture app
npm run check          # typecheck + unit + e2e
```

`tests/fixtures/app` is a synthetic messenger with known ground truth (stable IDs, identical texts, virtualised node reuse, hidden records, drafts, password inputs, open/closed shadow roots, an iframe, an HTML-injection payload, root replacement, pushState navigation, mutation storms and oversized text). No real site data is in this repository, and `src/` contains no site-specific selectors.

Layout: `src/agent` (isolated-world content script), `src/background` (router, sender validation), `src/extraction`, `src/diagnostics`, `src/protocol` (zod schemas, all boundaries validated), `src/session`, `src/export`, `src/ui`.

## Status

The extension, tests and documentation are complete for synthetic-fixture validation. It has not been validated against a real site; the repository contains no real-site recipes or data.

## License

[MIT](LICENSE)
