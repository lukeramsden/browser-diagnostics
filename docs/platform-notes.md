# Platform notes (Phase 0)

Facts verified against official documentation on the date below. Anything marked **to confirm** is checked by an automated test in a later phase; the plan does not depend on it being true.

Verified: 2026-09-11 against developer.chrome.com and playwright.dev.

## Toolchain in use

| Tool | Version | Why |
|---|---|---|
| Node | 22.x | Build/test host only; never shipped. |
| TypeScript | 7.x | Type checking (`tsc --noEmit`). |
| Vite | 8.x | Two builds: UI + background (ES modules), and the agent (single IIFE file). |
| Vitest | 5.x | Unit tests in jsdom. |
| Playwright | 1.63 | MV3 extension integration tests. |
| zod | 4.x | Runtime message and recipe validation. |
| @types/chrome | 0.2.x | Type definitions only. |

No runtime dependencies are shipped in the extension other than bundled zod.

## Permissions and what each one buys

Manifest permissions: `activeTab`, `scripting`, `storage`. Nothing else.

### `activeTab`

Source: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab

- Granted when the user **invokes** the extension: executing the action, a context-menu item, a `commands` shortcut, or an omnibox suggestion. Clicking our action is the only path we use.
- Grants temporary host permission to that tab. With `scripting`, we may call `scripting.executeScript()` / `insertCSS()` on it, and read its URL/title/favicon via `tabs.Tab`.
- **Lifetime:** access lasts while the user stays on that page. Same-origin navigation (`example.com` → `example.com/foo`) keeps access; navigating to another origin or closing the tab revokes it.
- Consequence for us: the user clicks the action on the target tab; we open the diagnostics page; the grant on the source tab remains valid, so a later **Attach** click on the diagnostics page can inject the agent. If the grant has lapsed, `executeScript` rejects and we surface `permissionLost` — we never re-acquire access silently.
- Same-document (SPA) navigation does not revoke the grant, but our injected agent must still detect it (hash/`history` changes) and mark the root stale.

### `scripting`

Source: https://developer.chrome.com/docs/extensions/reference/api/scripting

- Chrome 88+, MV3. `executeScript({ target: { tabId }, files: [...] })` injects into the main frame by default. We never set `allFrames` or `frameIds`.
- `world` defaults to `"ISOLATED"` (Chrome 95+). We keep the default; MAIN-world injection is a deferred, gated feature.
- `files` paths are relative to the extension root; the injected file is a classic script, so the agent build must be a **single self-contained IIFE**, no ES imports.
- If the injected script evaluates to a promise, the result waits for it — useful for a synchronous "hello" handshake that returns the document generation.
- Injecting twice into the same document runs the script twice; the agent guards with a `window`-scoped sentinel and re-uses the existing instance.

### `storage` (`chrome.storage.session`)

Source: https://developer.chrome.com/docs/extensions/reference/api/storage

- `storage.session`: Chrome 102+, MV3. In-memory; cleared on extension disable/reload/update and on browser restart.
- **Quota:** `QUOTA_BYTES = 10485760` (10 MB) in Chrome 112+ (1 MB in Chrome 111 and earlier). Our retained-snapshot budget is 4 MiB plus small metadata, so we set `minimum_chrome_version` to 116 to stay comfortably inside the 10 MB era and inside `documentId` support (below).
- **Access level:** by default **not** exposed to content scripts (`TRUSTED_CONTEXTS`). We never call `setAccessLevel`. The agent must go through the background worker.
- `getBytesInUse()` is available and is used for quota-pressure warnings.
- Writes exceeding quota reject the promise; the session store treats this as `storageQuota` and pauses observation visibly.

## Messaging and sender validation

Source: https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender

`MessageSender` fields used for validation:

- `id` — must equal `chrome.runtime.id`.
- `tab` / `tab.id` — present only for content-script senders; must equal the session's source tab.
- `frameId` — must be `0` (top-level frame).
- `documentId` — Chrome 106+. UUID of the sending document; recorded at attach and compared on every agent message. A mismatch means the document was replaced → `wrongDocument`.
- `origin` — compared with the session's stored origin.
- `url` — never stored beyond its origin.

The UI page sends from an extension context (`sender.id === chrome.runtime.id`, `sender.url` starts with `chrome-extension://<id>/`). The agent sends from the tab. Messages are typed by a `kind` discriminator; the background rejects any message whose `kind` does not match what that sender class is allowed to send.

## Service-worker lifecycle

Source: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle and Playwright docs.

- MV3 service workers are suspended after ~30 s idle and restarted on demand. In-memory state is lost. All session state that matters lives in `chrome.storage.session`; the worker rebuilds from it on every message.
- Long-lived `runtime.connect` ports keep a worker alive while open; we use short `sendMessage` request/response calls instead so worker restart is a normal, tested path.
- Agent-side observation continues across worker restarts (the content script lives in the page); its next event message wakes the worker, which validates session/generation from storage.

## Downloading the report

- The diagnostics page is an extension page. Creating a `Blob`, `URL.createObjectURL`, and clicking an `<a download>` from a user gesture triggers a normal browser download **without the `downloads` permission**. **Confirmed** by Playwright (`page.waitForEvent('download')`) in `tests/integration/phase2.spec.ts` (recipe download) and `phase4.spec.ts` (report download, file content equals the preview).
- Fallback if that fails in some environment: show the JSON in a `<textarea>` for manual copy. We will not add `downloads`.

## Playwright and MV3 extensions

Source: https://playwright.dev/docs/chrome-extensions

- Extensions load only with `chromium.launchPersistentContext(userDataDir, { channel: 'chromium', args: ['--disable-extensions-except=<dir>', '--load-extension=<dir>'] })`.
- Google Chrome / Edge removed the side-load flags; use Playwright's bundled Chromium (`chromium-1234` is already installed locally).
- `channel: 'chromium'` allows headless runs with extensions.
- Get the extension ID from `context.serviceWorkers()[0].url()` (or `waitForEvent('serviceworker')`).
- Idle suspension: Playwright keeps the same `Worker` handle across a restart; `evaluate()` in flight at the moment of suspension throws `"Service worker restarted"`.
- **Action click:** there is no Playwright API to click the toolbar action. The harness path (documented in `docs/validation-guide.md`) is: from a test, call `chrome.action.onClicked` handler equivalent via `serviceWorker.evaluate(() => globalThis.__diagnosticsTestHooks.openForTab(tabId))`. That hook is compiled only when `import.meta.env.VITE_TEST_HOOKS === 'true'`, is absent from the production build, and only replicates what a real action click does. **Caveat:** `activeTab` is granted only by a real user gesture, so in tests the fixture page origin is granted through a test-only `host_permissions` entry in a separate test manifest generated by the build (`dist-test/`). The production manifest never has it. This is the one place the test path differs from the user path and it is documented as such.

## Minimum Chrome version

`minimum_chrome_version: "116"` — gives us `storage.session` at 10 MB, `MessageSender.documentId`, and `scripting` `world`/`injectImmediately`. Nothing here needs anything newer.

## Content-security policy

`extension_pages`: `script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'`. `connect-src 'none'` makes accidental network calls from the UI fail loudly. Blob URLs for downloads are unaffected by `connect-src`.

## Open items carried into later phases

All resolved:

1. Blob download without `downloads` — confirmed (Phase 2 and Phase 4 e2e).
2. `storage.session` accounting — retention uses our own `estimatedBytes` (UTF-8 length of the JSON) as the authoritative budget (4 MiB, well under the 10 MiB quota); a write failure is additionally surfaced as `storageQuota`. `getBytesInUse` is read only for display when available. The retention-limit e2e test (Phase 3) confirms the pause path.
3. `MessageSender.documentId` does not change on same-document navigation; the agent's own `popstate`/`hashchange`/`history` detection marks the session stale (Phase 1 e2e).
