# Recipe format (schemaVersion 1)

A recipe tells the extension *where* records are inside the confirmed root and *which* parts of each record to read. It is data: CSS selectors and a small fixed set of read operations. It cannot contain code, regular expressions, property paths, URLs or transformations, and it cannot widen what the extension is allowed to access. Recipes are validated with a strict schema at every boundary (editor, message, storage); unknown keys are rejected.

## Shape

```json
{
  "schemaVersion": 1,
  "name": "Fixture messages",
  "rootSelector": "#log",
  "recordSelector": "article[role=\"article\"]",
  "fields": {
    "recordId":   { "selector": ":scope", "read": "attribute", "attribute": "data-record-id" },
    "sender":     { "selector": ".sender", "read": "text", "required": true },
    "body":       { "selector": ".body", "read": "text", "required": true },
    "at":         { "selector": "time", "read": "attribute", "attribute": "datetime" },
    "links":      { "selector": ".body a", "read": "attribute", "attribute": "href", "multiple": true },
    "attachment": { "selector": "[data-attachment]", "read": "exists" },
    "linkCount":  { "selector": "a", "read": "count" }
  },
  "identityFields": ["recordId"]
}
```

| Key | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. |
| `name` | yes | 1–120 characters. Used in file names (sanitised) and the UI. |
| `rootSelector` | no | Documents the root this recipe expects. The session's confirmed root is always what is used; a mismatch produces a warning, not a different root. |
| `recordSelector` | yes | Evaluated with `root.querySelectorAll`. Each match is one record, in document order. Elements belonging to the extension's own overlay are skipped. |
| `fields` | yes | 1–20 named fields. Names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`, ≤ 64 chars). |
| `identityFields` | no | Names of `text`/`attribute` fields whose values, joined, form the record identity. Empty means records have no identity and cannot be tracked between snapshots. |

Selectors are ≤ 512 characters and must be valid CSS; invalid ones fail validation, or if a browser rejects one at runtime the field reads `missing: invalidSelector`.

## Fields

Each field has a `selector` resolved **relative to the record element** with `record.querySelectorAll(selector)`. The literal `":scope"` means the record element itself. `:scope > x` works as in the platform.

| `read` | Result | Extra keys |
|---|---|---|
| `text` | Text content of the first match (or every match with `multiple: true`) | `multiple` |
| `attribute` | Value of the named attribute on the first match (or every match) | `attribute` (required), `multiple` |
| `exists` | `true` if at least one element matches | — |
| `count` | Number of matches | — |

Common keys: `required` (default `false`; a missing required field is reported per record and in warnings) and `note` (≤ 200 chars, free text for humans; never used for matching).

### Text semantics

- Text is the concatenation of text nodes in the subtree, **verbatim**: whitespace, newlines, tabs, emoji and right-to-left scripts are preserved. No trimming or normalisation. `<br>` produces no newline unless the DOM contains one.
- Subtrees of sensitive controls (`input`, `textarea`, `select`, `option`, anything `contenteditable`, plus `script`, `style`, `template`, `noscript`, `object`, `embed`) contribute nothing. A field whose match *is* or is *inside* such a control reads `missing: sensitiveElement`.
- Values are truncated at 8 KiB (UTF-8, never splitting a code point). Truncation is flagged (`truncated: true`) and the original byte length (`sourceBytes`) is kept.

### Attribute semantics

- Attribute names are ≤ 64 characters, `[A-Za-z_:][A-Za-z0-9_.:-]*`.
- Forbidden: names starting `on`, and `srcdoc`, `value`, `nonce`, `integrity`. The schema rejects them; the extractor independently refuses them (`missing: forbiddenAttribute`).
- Attributes of sensitive controls are not read (`missing: sensitiveElement`).
- An element that matches but lacks the attribute reads `missing: attributeAbsent`.

### Multiple matches

For single-valued `text`/`attribute` fields, the first match in document order is used and the record is flagged `ambiguous` for that field (with `matchCount`). Use `multiple: true` to get a list (≤ 50 values; more sets `truncated`).

## Identity

`identityFields` decides how records are matched between snapshots. The joined values (length-prefixed, so `"a"+"bc"` ≠ `"ab"+"c"`) form `identityKey`. If any identity field is missing or empty, the record has **no identity** and is never matched — it appears under *records without identity*.

Comparison is by identity only. Text is never used as identity; identical text under different identities is reported as *same content, different identity*. Identity fields that repeat within one snapshot (e.g. a sender name) make the comparison *unreliable* and the report says so.

In structure-only capture, `identityKey` is a SHA-256-derived hash of the values (`identityHashed: true`); matching still works, values are not retained.

## Capture mode interaction

The recipe does not choose the capture mode. In **structure only** (default) every `text`/`attribute` value is withheld (`redacted: true`, value empty) and only `sourceBytes`, `matchCount`, `truncated` and hashed identity are kept. In **selected fields** the values of these fields — and nothing else on the page — are captured. A preview of the exact recipe in that mode is required before observation.

## Limits

20 fields · 200 records per extraction (`limitReached` + warning; first 200 in document order) · 8 KiB per value · 50 values per list · 3 s per extraction pass (`limitReached`, warning `traversalMaxMs`; repeated hits pause observation).

## Import and export

Paste JSON into the editor and press **Validate** or **Set recipe for this session**. Pasted recipes are inert: nothing is read from the page until you press **Preview extraction**. **Download recipe JSON** saves the validated recipe. Recipes may embed page identifiers in selectors (e.g. `#conv-123`); the report includes the recipe only when you tick that option.

## Not supported, on purpose

Regular expressions, JavaScript, XPath, `innerHTML`, computed styles, property access (`el.__reactProps`), following links, clicking, scrolling, reading other frames or closed shadow roots, and any transformation of values. If a site cannot be described with selectors and these four reads, that is a finding to record, not a reason to add code to recipes.
