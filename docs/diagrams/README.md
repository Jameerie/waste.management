# Diagrams

System documentation for the waste management system. All diagrams are
[Mermaid](https://mermaid.js.org/) inside Markdown, so they render directly on
GitHub and stay editable as text — no binary image files to regenerate when the
code changes.

| # | Diagram | Answers |
|---|---|---|
| 1 | [Use case](01-use-case.md) | Who uses the system and what they can do |
| 2 | [Architecture](02-architecture.md) | How the components fit together, and which file does what |
| 3 | [Flowchart](03-flowchart.md) | The processing logic — wake, measure, decide, alert |
| 4 | [Data model](04-data-model.md) | The database schema and why each column exists |

## Where to start

If you are new to the codebase, read them in order — they move from *who* to
*what* to *how* to *stored as what*.

If you only read one, make it the [flowchart](03-flowchart.md). The single most
important behaviour in this system is that a high reading does **not** raise an
alert; three consecutive confirmations do. That branch is the difference
between a monitor people act on and one they mute after a week, and the
flowchart is where you can see it directly.

## Keeping them accurate

These describe real code, not a plan. When you change behaviour, update the
diagram in the same commit:

| If you change… | Update |
|---|---|
| `src/fill.js` state machine or thresholds | Flowchart |
| `src/db.js` schema | Data model |
| Files, layers, or external services | Architecture |
| Endpoints or who can call them | Use case, and the registration flow in the flowchart |

## Rendering elsewhere

GitHub renders these natively. For a PDF or slide deck:

```bash
npx @mermaid-js/mermaid-cli -i docs/diagrams/03-flowchart.md -o flowchart.pdf
```

VS Code previews them with the *Markdown Preview Mermaid Support* extension.
