# Findings: <site / view>

Fill in from evidence produced by the extension (see [validation-guide.md](validation-guide.md)). Where a question cannot be answered from DOM evidence, write "not observable" — do not infer. Do not paste private message content; reference exported report files (with their redaction options) instead.

## Context

| | |
|---|---|
| Date(s) | |
| Browser / version | |
| Extension version | (`extensionVersion` in the report) |
| Site and view tested | describe the view — origin only, no URLs |
| Account/conversation entitlement confirmed by | |
| Text capture used? | no / yes — justification: |
| Exported report files | filename → options used (omit text? alias? timestamps? URLs? recipe? snapshots?) |

## 1. Attachment and root

- Root description (tag, role, depth, descendant estimate, in shadow root?):
- Did selecting the root require an identifier that looks account- or conversation-specific? yes / no
- Root stability: survived scroll / conversation switch / reload? (stale-root events observed:)

## 2. Structure summary (structure-only)

- Nodes visited / limit; `limitReached`?
- Repeated shapes matching visible record count:
- Attribute *names* suggesting identifiers:
- `<time>` elements present? Links? Hidden vs visible counts?
- Boundaries: open shadow roots / iframes / closed roots suspected:
- Sensitive controls inside the root (should be 0 for a well-chosen root):

## 3. Recipe

- Recipe name / where stored (never commit real-site recipes with private values; keep them under `examples/` with placeholders):
- Records matched vs visible records:
- Records without identity:
- Ambiguous fields:
- Fields missing per record (required):
- Body `sourceBytes` plausible? Truncation hit?

## 4. Identity

| Question | Evidence (snapshot / comparison IDs) | Answer |
|---|---|---|
| Does the DOM expose a stable per-record identifier? | | yes / no / not observable |
| Does it survive virtualisation / node reuse? | | |
| Does it survive "load older" pagination? | | |
| Does it survive conversation switch and back? | | |
| Does it survive reload? (cannot be compared across generations — compare hashed identities manually) | | |
| Is a conversation identifier exposed? | | |
| Is a sender identifier (not display name) exposed? | | |
| Are exact timestamps present without interaction? | | |
| Did any comparison report *identity unreliable*? Why? | | |

## 5. Content completeness (only if text capture was justified)

- Repeated identical texts kept separate? 
- Multiline / emoji / RTL intact?
- Links represented (as text? as href attribute?)
- Replies / quotes / attachments represented?
- Hidden or collapsed records flagged not visible?
- Anything extracted that was outside the intended records? (If yes: recipe defect; fix and re-run.)

## 6. Lifecycle

- Behaviour on incoming record:
- Behaviour on edit / delete in the UI (remember: removed from view ≠ deleted):
- Behaviour on account switch (permission lost? stale document?):
- Limits hit (records, snapshots, bytes, time):

## 7. Conclusion

- Can records be extracted repeatably from the rendered DOM while they are on screen? yes / partially / no
- Which identifiers would a production extension have to rely on, and what is *not* available?
- Could records be reconciled with an external data set directly (same IDs), only via a mapping, or not at all from DOM evidence?
- Open questions that DOM inspection cannot answer (document them before proposing any deeper probe):

## 8. Limitations of this validation

State explicitly: the observation covered only records rendered in one tab during the session; it is not a synchronisation; redaction in the exported files is heuristic, not anonymisation.
