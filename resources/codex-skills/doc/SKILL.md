---
name: doc
description: Create, inspect, and edit Word documents (`.docx`) with local code-execution tools. Use for document drafting, structured edits, tables, comments, and layout-sensitive Word deliverables.
license: Apache-2.0
metadata:
  author: Open Interpreter
  managed-by: interpreter-workstation
---

# Word documents

This is workflow guidance, not a callable tool. Use the shell or code-execution tool exposed by the active OIX harness. Do not look for a tool named `doc`.

## Workflow

1. Inspect the source before editing. Preserve its structure, styles, identifiers, and branding unless the user asks for a redesign.
2. Use `python-docx` for creation and structured edits. For unsupported features such as tracked changes or complex comments, edit OOXML deliberately and keep the change narrowly scoped.
3. Write one cohesive script for a substantial change instead of a chain of fragile one-line mutations.
4. Save to a new file while iterating unless the user explicitly asked to replace the original.
5. Verify content by reopening the saved document with `python-docx` and checking the requested text, tables, and section structure.
6. When layout matters, render every page with `scripts/render_docx.py` or an available permissive office renderer, inspect the images, fix defects, and render again.
7. If the file is open in Interpreter, call `interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{"path":"/absolute/path.docx"}'` once after the final write.

## Dependencies

Prefer `uv` and install only what the task needs:

```sh
uv pip install python-docx
```

Use an existing Python installation when available. If installation is blocked, ask for approval for the exact dependency command.

## Quality bar

- Use named styles and a consistent type, spacing, margin, and heading system.
- Keep tables within page bounds; avoid clipped text, broken pagination, and accidental blank pages.
- Preserve source identity and exact requested facts.
- Keep scratch files outside the final deliverable folder.
- Reopen the final `.docx` and inspect all rendered pages before delivery when rendering is available.

This skill is derived from an Apache-2.0 OpenAI document workflow and has been modified for OIX code execution and Workstation refresh behavior.
