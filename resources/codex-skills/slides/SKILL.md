---
name: slides
description: Create, inspect, and edit editable PowerPoint (`.pptx`) decks with local code execution. Use for slide decks, presentations, speaker notes, charts, tables, images, and layout-sensitive presentation work.
---

# PowerPoint workflow

This is workflow guidance, not a callable tool. Use the shell or code-execution
tool exposed by the active OIX harness. Do not look for a tool named `slides`.

## Workflow

1. Inspect the source deck before editing. Preserve its theme, layouts, masters, dimensions, and visible identity unless the user asks for a redesign.
2. Use `python-pptx` for editable text, tables, images, shapes, charts, and speaker notes. Use one cohesive builder script for a new deck or substantial revision.
3. Keep real slide text and data editable. Do not flatten an entire slide into a screenshot.
4. Use consistent margins, alignment, typography, and color. Prefer a clear visual hierarchy over dense bullet lists.
5. Validate the `.pptx` as a ZIP package, reopen it with `python-pptx`, and confirm slide count and key content.
6. If a permissive renderer is available, render every slide to images and inspect for clipping, overflow, poor contrast, and accidental overlap.
7. If the deck is open in Interpreter, call `interpreter-app tools builtin-interpreter interpreter_refresh_file --json '{"path":"/absolute/path.pptx"}'` once after the final write.

## Dependencies

```sh
uv pip install python-pptx pillow
```

Use an existing Python installation when available. Install only missing dependencies, and request approval for exact system-level installation commands.

## Quality bar

- Deliver a valid, editable `.pptx` with no placeholder or implementation text.
- Keep titles, body text, labels, and charts legible at presentation distance.
- Check every slide, not only the title slide.
- Preserve source assets and notes when revising an existing deck.
- Keep helper scripts and rendered previews outside the final deliverable folder.
