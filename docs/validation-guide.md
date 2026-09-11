# Validation guide

How to use the extension to answer "does this page expose stable, extractable records?" — and how to read the answers. The output of a validation is a filled-in [`findings-template.md`](findings-template.md) plus exported evidence you reviewed.

## Definitions used everywhere

| Term | Meaning here |
|---|---|
| **Visible** | Connected to the document, not `hidden`, computed `display` not `none`, `visibility` not `hidden`/`collapse`, has at least one client rect with non-zero width or height. Nothing about the viewport: off-screen elements are visible. |
| **Record** | One element matched by the recipe's `recordSelector` inside the confirmed root. |
| **Identity** | Joined values of the recipe's `identityFields`. No identity fields, or a missing/empty value, means *no identity*. Text is never identity. |
| **Added to view** | Identity present in snapshot B, absent in A. |
| **Removed from view** | Identity present in A, absent in B. *Not deletion*: virtualised lists, pagination and collapsing all remove from view. |
| **Changed** | Same identity, different field values (or, in structure-only mode, different content fingerprint). |
| **Node reuse** | The same DOM element (temporary node handle) shows a different identity than before. Expected in virtualised lists; it proves position ≠ identity. |
| **Stale document** | The page reloaded or navigated (full or same-document). The observation context ends; snapshots from before and after cannot be compared. |
| **Stale root** | The confirmed root left the document (framework re-render, conversation switch). Select and confirm again. |
| **Limit reached** | A bound in README §Limits was hit. Results are complete *up to the limit* and say so. |

## Protocol (synthetic fixture or real site)

Work through these in order. Each step maps to a section of the findings template. Do not skip the structure-only steps.

### 0. Prepare

- Build and load the extension (README). Use a dedicated browser profile.
- On a real site: choose one conversation/view you are entitled to inspect. Confirm you have the right to look at every record it renders. Decide *before starting* whether text capture is acceptable at all.

### 1. Attach and scope

1. Open the page, click the extension action, press **Attach**. Status must read *Ready for one-shot inspection*.
2. In **Structure**, use the picker or a selector to choose the smallest root that contains the records and nothing else (not the composer, not the sidebar). Read the root description (tag, role, depth, descendant estimate). **Confirm** it.
3. Record: root description, whether it sits in a shadow root, and whether selecting it required an ID that looks like an account or conversation identifier.

### 2. Structure only

1. **Inspect structure**. Note: nodes visited vs limit, repeated shapes (candidate record containers), `data-*` element count, `<time>` count, link count, hidden vs visible counts, open shadow roots, iframes, sensitive controls.
2. Ask: is there a repeated shape whose occurrence count matches the number of records you can see? Are there attribute *names* that look like stable identifiers (`data-*id*`, `data-key`, `id`)? Attribute *values* are not shown here — that is the point.
3. If nothing in the summary suggests records or identifiers, that is a valid finding. Stop or proceed only with a clear reason.

### 3. Recipe, still structure only

1. Write a recipe ([recipe-format.md](recipe-format.md)) using the repeated shape and attribute names from step 2. Keep it minimal: record selector, one candidate identity attribute, body, sender, time.
2. **Preview** with capture mode *structure only*. You see per record: identity present?, hashed identity, field presence, byte lengths, match counts, ambiguity, hidden flag.
3. Check: record count vs what you see; records without identity; ambiguous fields; `sourceBytes` of body fields being plausible (a 0-byte body means the selector missed).
4. Iterate on the recipe until presence and counts are right. You have not read any text yet.

### 4. Identity stability, still structure only

1. **Observe → Start**. Then, in the page: scroll (virtualised lists), load older records, receive or send a test record (if authorised), switch conversation and back, reload.
2. After each action, **Compare** the two most recent snapshots. Look for:
   - node reuse with no changed records → identity survives virtualisation;
   - duplicates or *identity unreliable* → the chosen attribute is not a record ID;
   - large *removed from view* → pagination or virtualisation, not deletion;
   - *stale root* / *stale document* → the framework replaces the container; attribution across that boundary is impossible from DOM evidence.
3. Hashed identities let you see stability without seeing values. If identities change on every render (all records added + all removed), the attribute is a render key, not a record ID.

### 5. Selected fields, only if justified

1. Switch capture mode to *selected fields*. **Preview** is mandatory; read every row. If the preview shows anything outside the intended records (another conversation, a sidebar item, the composer), fix the recipe first.
2. Verify against known records: repeated identical texts stay separate; multiline and emoji are intact; links appear as text; replies and attachments are represented; a hidden record is flagged not visible.
3. Observe briefly if a live change is needed to answer a question. Stop as soon as it is answered.

### 6. Export evidence

1. In **Export**, start from the defaults (omit text, alias identifiers, day-only timestamps, omit URLs, no recipe, no snapshots). Add only what a reader needs to verify the finding.
2. **Build preview**, read the JSON, confirm, save. The saved file equals the preview byte for byte.
3. **Stop (detach)** and **Clear session content**. Note that saved files are now your responsibility.

## Reading the results honestly

- A missing identifier is a result. Do not infer identity from position, timestamp or text.
- "Extractable while rendered" is the strongest claim DOM observation supports. It says nothing about records never rendered, or about what the service stores.
- If a comparison says *identity unreliable*, every added/removed/changed list under it is a hint, not evidence.
- If any snapshot has `limitReached`, counts are lower bounds.
- Distinguish "the page does not expose it" from "this recipe did not find it". Only the former is a finding about the site; the latter needs another recipe attempt, still in structure-only mode.

## What the fixture app exercises

`npm run test:e2e` runs this protocol automatically against `tests/fixtures/app` (stable IDs, identical texts, virtualised node reuse, pagination, incoming/edit/remove, hidden record, drafts and credentials, open and closed shadow roots, iframe, HTML-injection payload, root replacement, pushState navigation, mutation storm, oversized text, tab close, service-worker restart, retention limit). A real-site validation should be able to point at the corresponding fixture case for every claim it makes.
