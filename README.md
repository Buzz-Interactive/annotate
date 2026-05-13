# annotate-js

> **The annotation tool built for the AI-revision loop.** Mark up any static HTML page in the browser, export reviewer comments as a structured JSON brief, hand it straight to Claude, GPT or any agent of choice to action the changes. One script tag. No backend. No framework.

---

## What it is

`annotate-js` is a single-file annotation system designed to make AI-assisted document revision practical. Long-form HTML deliverables — discovery docs, technical specs, fundraising packs, regulated artefacts — get reviewed by humans who naturally want to mark up exactly the sentence, table cell, or bullet they're commenting on. `annotate-js` turns that inline mark-up into a clean structured brief an AI agent can act on.

Drop the script tag into any HTML page and reviewers can select text, attach a comment, and revisit it across multiple sessions. Each annotation captures the selected text, a surrounding-text context window, the nearest heading, the reviewer's comment, a session ID, and a stale-flag — exactly the shape an agent needs to locate the change, understand the intent, and apply the edit. Export is a single JSON file that pastes straight into a prompt: *"Here is the document, here are the reviewer comments, apply them."*

When the agent returns the revised HTML, reviewers import the same JSON back into the new version. Text-context re-anchoring re-finds every annotation in the updated document; any annotation the tool can no longer place is flagged `moved` or `stale`, telling reviewers and agents alike which comments were actioned, which still apply, and which need a fresh look. A **session model** archives each round so the full review history stays traceable across iterations.

Annotations never leave the reviewer's device unless they explicitly export — important when the document is regulated, commercial, or otherwise sensitive. No backend, no SaaS subscription, no telemetry. The reviewer owns the annotation data; the agent receives only what the reviewer chooses to send.

---

## The loop

```
Reviewer  →  annotate-js  →  JSON export  →  AI agent  →  revised HTML
                                                              │
                                  ┌───────────────────────────┘
                                  ▼
                            annotate-js (import)
                                  │
                                  ▼
                       fresh / moved / stale flags
                       per annotation, surfacing what
                       was actioned and what still applies
```

---

## Why this exists

Existing annotation tools were built for human-to-human review: comments stay inside the tool, get resolved by another human, and never leave the SaaS. `annotate-js` is built for the AI-to-human loop instead. The reviewer marks up the document, hands the structured export to an agent, and the agent does the rewrite. The tool sits between a reviewer and an LLM, not between two reviewers — and the exported JSON is the contract.

---

## Features

- **Built for the AI-revision loop.** Structured JSON export pastes straight into a prompt.
- **Round-trip aware.** Import the same JSON back into the revised document; annotations are re-anchored and flagged `fresh`, `moved`, or `stale` so the next AI pass knows what's been actioned.
- **Session model.** Each review round is archived separately. Full revision history stays traceable.
- **Section-aware.** Every annotation carries its nearest heading (`H1`–`H3`) so the agent sees which part of the document each comment refers to.
- **Text-context anchoring.** Captures a prefix/suffix window around each selection so annotations survive small DOM and copy changes.
- **Local-first.** IndexedDB on the reviewer's machine. Nothing transmitted until the reviewer chooses to export.
- **Privacy by default.** No telemetry, no third-party calls.
- **Zero dependencies, zero build step.** One script tag, any static HTML.

---

## Install

### CDN — single-tag bundle (easiest)

```html
<script src="https://cdn.jsdelivr.net/gh/Buzz-Interactive/annotate@1.0.1/annotate.bundle.js"></script>
```

`annotate.bundle.js` is the JS plus the CSS inlined; the stylesheet is injected automatically into `<head>` on script load. Best option when you want one tag and no styling overrides.

### CDN — split (lets you override styles)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/Buzz-Interactive/annotate@1.0.1/annotate.css">
<script src="https://cdn.jsdelivr.net/gh/Buzz-Interactive/annotate@1.0.1/annotate.js"></script>
```

Pin to a tag for stability (`@1.0.0`), to a branch for latest (`@main`), or to a major (`@1`) for semver-tracked updates.

### Self-host

Download `annotate.bundle.js` (single file) or the `annotate.js` + `annotate.css` pair from the [releases page](https://github.com/Buzz-Interactive/annotate/releases) and serve from your own origin.

```html
<!-- single-file -->
<script src="/path/to/annotate.bundle.js"></script>

<!-- or split -->
<link rel="stylesheet" href="/path/to/annotate.css">
<script src="/path/to/annotate.js"></script>
```

That's it. No initialisation call needed. The script auto-bootstraps on `DOMContentLoaded`.

---

## Document scoping

Every annotation is stored against a **document key** so reviewers see only the comments that belong to the page in front of them. The key is also what `IndexedDB` filters on when the page boots.

### Default behaviour

By default the document key is the last segment of `location.pathname`. So `https://example.com/docs/spec.html` resolves to `spec.html`. Good enough when every document on your origin has a unique filename.

### Explicit override (recommended for production)

Set `data-annotate-document-id` on the `<body>` tag to declare the key yourself:

```html
<body data-annotate-document-id="acme/2026-05/architecture-blueprint">
  <!-- document content -->
  <script src="https://cdn.jsdelivr.net/gh/Buzz-Interactive/annotate@1.0.1/annotate.bundle.js"></script>
</body>
```

Pick the override when any of the following apply:

- **Same filename in different folders.** `/team-a/spec.html` and `/team-b/spec.html` would otherwise share the same key and cross-contaminate.
- **Hostname or path migrations.** Move a doc from `staging.example.com/foo.html` to `docs.example.com/v2/foo.html` and the explicit ID keeps reviewer annotations attached to the document, not the URL.
- **Multiple revisions of the same document.** Give each revision a distinct ID (`spec-v1`, `spec-v2`) if you want reviewers to keep separate annotation rounds per revision.

### Precedence

1. `<body data-annotate-document-id="...">` — explicit override.
2. `location.pathname.split('/').pop()` — default.
3. `'index.html'` — fallback when both are empty.

### Migration note

If you add `data-annotate-document-id` to a document that already had reviewer annotations under the default key, those annotations remain in the reviewer's `IndexedDB` but become unreachable from the new key. Two options:

- **Before** adding the attribute, ask reviewers to **Export** the active session as JSON.
- **After** adding the attribute, reviewers **Import** the exported JSON, which re-attaches the annotations to the new key.

Pages that have only ever shipped with the attribute aren't affected.

---

## Usage

1. Open any HTML page that includes `annotate.js`.
2. Select text. A popover appears.
3. Add a comment and save. The selection is highlighted.
4. Open the sidebar (top-right toolbar) to see all annotations grouped by section.
5. Click **Export** to download a JSON file of the current session.
6. Hand the JSON to your AI agent of choice along with the original HTML:

   > Here is the original HTML document and a JSON file of reviewer annotations. Each annotation contains the selected text, a surrounding-text context window, the nearest heading, and the reviewer's comment. Apply every comment to the document and return the revised HTML.

7. When the agent returns the revised HTML, open it and **Import** the same JSON. Annotations are re-anchored; each gets a status:
   - `fresh` — the selected text was found exactly as before; the comment may still apply or may already be actioned (reviewer judgement).
   - `moved` — the text was found but the surrounding context has shifted; worth re-reading.
   - `stale` — the text was not found; the agent likely actioned it.

8. Add follow-up annotations on the revised document and loop.

---

## JSON export shape

```jsonc
{
  "documentPath": "research-doc.html",
  "exportedAt": "2026-05-13T10:30:00.000Z",
  "session": {
    "id": "0d4b0...",
    "name": "Round 1 — 13 May 2026",
    "createdAt": "2026-05-13T09:15:00.000Z"
  },
  "annotations": [
    {
      "id": "8a1c...",
      "selectedText": "the platform fee is deducted from the inbound cash",
      "context": {
        "prefix": " At first funding, ",
        "suffix": " before the remainder is auto-invested"
      },
      "sectionHeading": "4.3 Annual platform fee — WK Fees API",
      "comment": "Confirm this still holds for ISA transfers.",
      "createdAt": "2026-05-13T10:12:00.000Z",
      "status": "fresh"
    }
  ]
}
```

---

## Prompt template for AI agents

A starter you can paste into Claude, GPT, or any agent:

```
You are revising an HTML document based on reviewer feedback.

Inputs:
1. The original HTML document (attached).
2. A JSON file of reviewer annotations (attached).

For each annotation in the JSON:
- Locate the `selectedText` inside `sectionHeading` using the `context.prefix`
  and `context.suffix` to disambiguate.
- Apply the change requested in `comment`.
- Preserve the document's existing HTML structure, styles, and surrounding
  copy unless the comment explicitly asks for structural change.

Return the full revised HTML document. Do not return a diff.
After the document, list each annotation by `id` and one sentence on how
you actioned it, so the reviewer can confirm on re-import.
```

---

## Browser support

Modern evergreen browsers (Chrome, Edge, Firefox, Safari). Requires `IndexedDB`, `crypto.randomUUID` (falls back to a manual UUID if missing), `Range`, and `Selection` — all standard. No support for IE11.

---

## Privacy and data handling

`annotate-js` stores all annotations in `IndexedDB` on the reviewer's device under the database name `annotate-js`. Nothing is transmitted to any server unless the reviewer explicitly clicks **Export**, at which point a JSON file is downloaded locally. No analytics, no third-party scripts loaded by the tool, no fingerprinting. If the reviewer clears their browser storage or uses private browsing, annotations are lost — export early and often.

When sharing the exported JSON with an AI agent, treat it as you would any sensitive document: only the reviewer can decide whether the document and the comments are appropriate to share. The tool itself has no opinion.

---

## Contributing

Source lives in `src/annotate.ts` (TypeScript). The published `annotate.js` at the repo root is the compiled output — never edit it directly.

```bash
git clone https://github.com/Buzz-Interactive/annotate.git
cd annotate-js
npm install        # installs typescript only
npm run typecheck  # no emit, just verify types
npm run build      # compiles src/annotate.ts → annotate.js
npm run watch      # rebuild on save
npm run demo       # serves examples/demo.html at http://localhost:8000/examples/demo.html
```

The repo ships:

- `src/annotate.ts` — typed source.
- `annotate.js` — compiled output of `tsc`, committed, jsDelivr-served. Always rebuild before tagging a release.
- `annotate.css` — hand-written, not generated.
- `annotate.bundle.js` — `annotate.js` plus `annotate.css` inlined via `scripts/bundle.mjs`. Single-tag distribution. Regenerated by `npm run build` (or `npm run build:bundle` alone) and committed alongside source.
- `tsconfig.json` — strict-mode TypeScript config targeting ES2020 with the DOM lib.
- `scripts/bundle.mjs` — Node script that produces `annotate.bundle.js`. Zero deps, just `fs` and `path`.

Public API surface: the script auto-bootstraps on load; consumers do not import anything. The TS types are for source maintainers and for anyone scripting the IndexedDB store directly (database name `annotate-js`, stores `annotations` / `sessions` / `settings`).

## License

MIT. See [LICENSE](./LICENSE).
