# Privacy and data handling

This document states what the extension can access, what it retains, where it goes, and what it does **not** promise.

## What it can access

- Only the one tab on which you clicked the extension action, and only after you press **Attach**. The `activeTab` grant ends when that tab navigates to a different origin or closes; the extension does not hold host permissions.
- Only the DOM of that tab's top frame, in the isolated world. It does not run page JavaScript, read page variables, intercept network traffic, take screenshots or read other tabs.
- Inside the tab, only the subtree of the root you selected and confirmed. Structure inspection can be run before confirmation; content extraction cannot.

Cross-origin iframes and closed shadow roots are boundaries: their contents are counted, never read.

## What it never reads

Regardless of recipe or capture mode:

- Values, attributes or text of `<input>`, `<textarea>`, `<select>`, `<option>` and anything `contenteditable` (drafts, passwords, tokens, composer text). Text extraction skips these subtrees entirely.
- `<script>`, `<style>`, `<template>`, `<noscript>`, `<object>`, `<embed>` content.
- Event-handler attributes (`on*`), `srcdoc`, `value`, `nonce`, `integrity`. Recipes naming them are rejected; a bypass at runtime yields `missing: forbiddenAttribute`.
- The page URL beyond its origin. Path, query and fragment are never stored.

## Capture modes

- **Structure only** (default). Structure summaries contain aggregates: tag, role and attribute-*name* counts, repeated tag-shape signatures, counts of hidden/visible elements, shadow roots, iframes and sensitive controls. Recipe previews and snapshots show field presence, byte lengths, match counts and a *hash* of identity values. No text, IDs, classes, URLs or attribute values.
- **Selected fields**. The text/attribute values of the fields in the recipe you reviewed are captured and shown on the diagnostics page. A preview is mandatory before observation is allowed in this mode, because a selector can match more than you intended.

The mode cannot be changed while observing.

## Where data lives

- `chrome.storage.session` only: memory-backed, extension-private, cleared when Chrome exits. Nothing is written to `storage.local`, IndexedDB, cookies or disk by the extension.
- Retention is bounded: at most 20 snapshots or 4 MiB per session. When the bound is hit, observation *pauses* and says so; nothing is silently dropped.
- **Stop (detach)** removes the agent from the page. **Clear session content** deletes every stored key for the session, including snapshots and comparisons. Browser storage deletion is ordinary deletion, not secure erasure.
- Routine logs (`console`) never include captured page content. Errors are reported by code and field path, not by value.

## Export

Nothing leaves the extension unless you build a report, review the exact JSON, tick the confirmation and save it. The report is built from an allowlist, not by serialising internal state. It is versioned (`schemaVersion`, `reportKind`, `extensionVersion`) and records the redaction options used.

Options and their meaning:

| Option | Default | Effect |
|---|---|---|
| Omit all text | on | Text/attribute values replaced by `null`; byte length, truncation and match counts kept |
| Alias identifiers | on | Identity keys and identity-field values replaced by `record_N` / `id_N`, stable only within the file; the map is never exported |
| Timestamps | day only | Snapshot/report times and ISO-8601-looking values reduced to `YYYY-MM-DD`, or omitted |
| URLs in values | omit | Absolute `http(s)` URLs — whole values or embedded in text — omitted, reduced to origin, stripped of query/fragment, or kept |
| Recipe and root selection | off | Selectors may embed page identifiers (account or conversation IDs) |
| Snapshots with records | off | Per-record fields, subject to the options above |

The source tab is always recorded as origin only; the tab title is never included.

**Redaction is heuristic, not anonymisation.** Small amounts of text, rare wording, timing patterns and structure can still identify people. Aliases aid readability; they are not a privacy guarantee. Saved files are outside the extension's control; clearing a session does not delete them.

## Untrusted input

Everything that crosses a boundary is validated at runtime with explicit schemas and size/depth bounds: messages from the page agent, messages from the diagnostics page, recipes (including pasted ones), stored records. The diagnostics page builds its DOM with `textContent` only; there is no `innerHTML`. Page strings that look like HTML render as text. Recipes are data (selectors and read operations) and cannot carry code, regular expressions or property paths.

## What this is not

Observation of a loaded page is not synchronisation. It cannot see records that were never rendered, cannot tell deletion from scrolling out of view, and cannot attribute records across a navigation or root replacement — those end the observation context and are reported as *stale document* / *stale root*.
