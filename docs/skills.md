# Skills and the Open Interpreter home

Workstation is a client around OIX. It does not maintain a second agent home.
The desktop-launched app server and the standalone `interpreter` CLI resolve the
same canonical home:

1. `INTERPRETER_HOME`, when explicitly set.
2. `~/.openinterpreter` otherwise.

OIX configuration, authentication state, conversations, plugins, and global
skills therefore share one root. Global skills live at
`$INTERPRETER_HOME/skills/`. Workstation UI preferences may still live in the
operating system's normal Electron application-data directory; those are not
OIX runtime configuration.

## App-managed skills

The app ships a small set of default skills under `resources/codex-skills`.
At runtime, Workstation installs them into the shared OIX `skills/` directory.
The installer records a content hash in
`$INTERPRETER_HOME/.interpreter-managed-skills.json`.

On an app update:

- Shipped skills are updated to the versions bundled with that app release.
- Unrelated user and enterprise skills are left untouched.
- If a user edited a shipped skill, the old directory is copied to
  `$INTERPRETER_HOME/.interpreter-managed-skill-backups/` before the release
  version replaces it.
- The update is staged before replacement so a partially copied skill is never
  treated as the installed release.

To customize a workflow permanently, create a separately named skill instead of
editing an app-managed skill. Enterprises can add their own global skill folders
through OIX configuration without forking Workstation.

## OIX-managed skills

OIX separately owns `$INTERPRETER_HOME/skills/.system/`. Its bundled skills are
embedded in the OIX runtime, fingerprinted as one release bundle, and refreshed
when the updated runtime starts an interactive, `exec`, or app-server session.
The Workstation manifest never records, backs up, retires, or replaces anything
inside `.system/`; OIX likewise refreshes only `.system/` and leaves
Workstation-managed and user-managed sibling folders alone.

The current computer-use guidance intentionally exists in both ownership
domains with different contracts. OIX's `.system/qa-testing` skill can install
the upstream TryCua `cua-driver` on demand. Workstation's `computer-use` skill
targets the app's bundled driver, approvals, browser bridge, and overlay rules.
Any future consolidation should explicitly choose one owner instead of allowing
either updater to claim the other's namespace.

## Document workflows

Workstation ships Apache-2.0 workflow skills for Word documents, PDFs,
PowerPoint presentations, and spreadsheets. They rely on OIX code execution and
permissive libraries such as `python-docx`, `pypdf`, `reportlab`, `python-pptx`,
and `openpyxl`. A compatible office renderer may be used for visual verification
and formula recalculation when installed, but no commercial office SDK is
required or bundled. These workflows are not duplicated as format-specific
built-in agent tool servers; the skills and ordinary code execution are the
agent-facing contract.

The PDF workflow derives from OpenAI's individually Apache-2.0 public PDF skill.
The Word workflow retains its Apache-2.0 license and is adapted for OIX. The
PowerPoint and spreadsheet workflows are Workstation-owned Apache-2.0 skills.
