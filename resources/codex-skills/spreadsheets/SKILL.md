---
name: spreadsheets
description: Create, inspect, analyze, and edit spreadsheets (`.xlsx`, `.xlsm`, `.csv`, `.tsv`) with local code execution. Use for formulas, formatting, charts, validation, financial models, and spreadsheet deliverables.
---

# Spreadsheet workflow

This is workflow guidance, not a callable tool. Use the shell or code-execution
tool exposed by the active OIX harness. Do not look for a tool named
`spreadsheets`.

## Workflow

1. Inspect workbook sheet names, used ranges, formulas, styles, merged cells,
   tables, and charts before editing.
2. Use `openpyxl` for `.xlsx`/`.xlsm` creation and edits. Load macro-enabled
   workbooks with `keep_vba=True` when macros must survive. Use `pandas` only for
   analysis or reshaping, not as the final formatting layer.
3. Build substantial workbooks in one cohesive script: create inputs and source
   sheets first, then formulas, formatting, validation, tables, charts, and
   print settings.
4. Keep business logic in auditable formulas and visible assumption cells. Do
   not hardcode derived values.
5. Reopen the saved workbook and verify sheet names, key values, formulas,
   defined names, and expected structures. Scan formulas for obvious broken
   references.
6. Formula libraries do not calculate cached results. When recalculation or
   visual review is required, use an installed permissive office renderer in
   headless mode, then reopen and inspect the recalculated file. State the
   limitation if no renderer is available.
7. Render or export every important sheet for a visual pass when possible.
8. If the workbook is open in Interpreter, call `interpreter-app tools
   builtin-interpreter interpreter_refresh_file --json
   '{"path":"/absolute/path.xlsx"}'` once after the final write.

## Dependencies

```sh
uv pip install openpyxl pandas
```

Install only what the task needs. Use an existing Python installation when
available, and request approval for exact system-level installation commands.

## Quality bar

- Preserve existing workbook structure and style unless redesign is requested.
- Use real formulas, tables, filters, freeze panes, validation, conditional
  formats, and charts when they improve the requested result.
- Avoid formula errors, clipped labels, unreadable widths, and default blank
  sheets.
- For financial or operational models, include visible assumptions and an
  independent check of sample outputs.
- Keep scratch CSV, scripts, and previews outside the final deliverable folder.
