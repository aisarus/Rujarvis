# Contributor and agent guidance

Rujarvis is a standalone Electron voice assistant for Windows, in Russian and
English, that drives the official Claude Code and Codex CLIs on the user's own
subscription. These rules say what must stay true.

## Before changing code

- Run `git rev-parse --show-toplevel` and check that it is this repository's
  root. Work done or tested in another copy is not verification of this one.
- Use `pnpm`. Read `README.md` and `docs/jarvis/architecture.md` first.
- Preserve user work and unrelated changes. Never publish, push, or create a
  public artifact without explicit authorization.

## Where things are

- `app/` — the Electron app: `main.ts` (tray, single instance, startup),
  `settingsWindow.ts` + `ui/` (onboarding and settings), `voiceBridge.ts`
  (microphone, recognition, direct commands, speech), overlays.
- `jarvis/` — everything else: core, router, risk, backends, voice, dialogue,
  desktop MCP server, locale, setup (paths and settings).
- `scripts/` — installer helpers and live checks (`jarvis-*`, `probe-*`,
  `voice-roundtrip.ts`).
- Files outside `app/`, `jarvis/`, `scripts/`, `resources/`, `docs/jarvis/`
  and the root config are leftovers from Interpreter Workstation: nothing
  builds, imports or tests them. Do not build on them.

## Invariants

- **Red lines are enforced in code, twice.** The spoken phrase is classified
  before an agent starts (`jarvis/router`, `jarvis/risk/policy.ts`), and every
  agent tool call goes through the PreToolUse hook (`jarvis/risk/gateHook.ts`,
  `jarvis/risk/toolGate.ts`). Silence, an unreadable call and any failure mean
  *deny*. Without the hook the agent gets no shell, no skill writing and no
  write access to Jarvis's own folder. Do not pre-approve a new tool that can
  spend money, contact people, run commands or write outside the task without
  teaching the hook about it.
- Model text can raise a risk class, never lower it. Normalisation only narrows
  permissions. The user's original phrase always reaches the backend.
- Stop, silence, pause and continue — and yes/no answers — are matched before
  anything else, in **both** languages whatever the selected language is, and
  must never wait behind a model, a queue or another command. No command may
  use one of those words (`jarvis/voice/redLines.vitest.test.ts` guards this).
- Dictated text and speech not addressed to Jarvis are not logged unless the
  user chose *everything* in settings (`speechLogging`).
- Everything on disk lives under one folder (`jarvis/setup/paths.ts`). Do not
  add files anywhere else.
- No API keys, no telemetry, no hosted accounts. Agents run through CLIs the
  user signed into.
- Checks answer three ways — passed, failed, or *nothing to measure with*. A
  tool that reports success for something it never did is a bug.

## Two languages

User-facing text goes through `tr('русский', 'english')`
(`jarvis/locale/language.ts`); tables that recognise speech hold both
languages. Adding a Russian phrase to a command table means adding the English
one too, and the catalogue test (`jarvis/control/catalogue.vitest.test.ts`)
checks that every promised phrase in both languages really parses.

## Code rules

- Prefer the simplest complete structural fix. Do not add compatibility
  fallbacks for obsolete local formats — migrate once (see `install.ps1`,
  `Move-LegacyData`).
- Comments explain why, not what. In `jarvis/` and `app/` they are mostly in
  Russian.
- Windows-only behaviour (PowerShell desktop driver, `tasklist`/`taskkill`,
  the Start menu) must fail gracefully elsewhere, never crash the app.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

Anything that crosses a process boundary — spawning a CLI, the MCP server,
the hook, the speech models — needs a run against the real thing, not only a
fake: `pnpm jarvis:roundtrip` for the voice path, `pnpm jarvis:talk-check` for
the conversation stream, the app under a display for the UI. Most desktop
behaviour runs only on Windows: say so when you could not test it there.

Never claim an end-to-end path works from typechecking alone.
