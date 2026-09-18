---
name: pdf
description: Read, create, edit, and verify PDFs with local code-execution tools and rendered-page inspection. Use whenever PDF layout, forms, extraction, merging, or final visual quality matters.
license: Apache-2.0
metadata:
  author: OpenAI and Open Interpreter contributors
  managed-by: interpreter-workstation
---

# PDF workflow

This is workflow guidance, not a callable tool. Use the shell or code-execution tool exposed by the active OIX harness. Do not look for a tool named `pdf`.

## Workflow

1. Inspect metadata and text with `pypdf` or `pdfplumber`.
2. Render pages to PNG with Poppler (`pdftoppm`) before making layout-sensitive decisions.
3. Use `pypdf` for page operations and forms, `reportlab` for new PDFs, and `pdfplumber` for focused extraction.
4. After every meaningful write, reopen the file and render all affected pages.
5. If the file is open in Interpreter, call `interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{"path":"/absolute/path.pdf"}'` once after the final write.

## Dependencies

```sh
uv pip install pypdf pdfplumber reportlab
```

Use an existing Python and Poppler installation when available. Install only missing pieces, and request approval for exact system-level installation commands.

## Quality bar

- No clipped, overlapping, missing, or unreadable content.
- Preserve page size, rotation, form field identity, and source fidelity.
- Verify page count and expected text after saving.
- Inspect the latest rendered pages before delivery.
- Keep intermediate renders and scripts out of the final deliverable folder.

Derived from OpenAI's Apache-2.0 `pdf` skill and modified for OIX code execution and Workstation refresh behavior.
