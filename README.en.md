# Rujarvis

[Русская версия](README.md)

**A voice assistant for Windows that speaks Russian and English and gets work
done with the Claude Code subscription you already have.**

You talk to it in plain language — *"close this window"*, *"find why the build
fails and fix it"*, *«а пока открой Telegram»* — and it decides what the
request needs: an instant keyboard or window action, an answer, or real work
done by Claude Code on your screen, in your browser and in your files. Before
anything that spends money, messages people or can't be undone, it asks you
out loud.

Rujarvis started as a fork of
[Interpreter Workstation](https://github.com/openinterpreter/interpreter-workstation)
and is now a standalone app. It is not affiliated with or endorsed by Open
Interpreter.

## Install

Windows 10/11, one line in PowerShell:

```powershell
irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex
```

English by default instead of Russian:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1))) -Language en
```

The installer puts Git and Node.js in place if they are missing, builds the
app, downloads a speech model sized to your machine and a voice, adds
**Rujarvis** to the Start menu and starts it. No administrator rights, no C++
compiler, no Rust. Running it again updates the install.

On first start a short setup walks you through the language, signing in to
Claude Code, the speech models and a microphone check. Everything can be
changed later from the tray icon → **Settings**.

You need [Claude Code](https://claude.ai/code) signed in with your own
subscription for anything beyond direct commands. Codex works as a fallback if
you have it.

## Talking to it

| Say | What happens |
| --- | --- |
| **Jarvis** / **Джарвис** | Wakes it; for a minute after that you can talk without the name |
| `Ctrl+Space` | Push to talk: press, speak, press again |
| `Ctrl+M` | Microphone off / on |
| **stop** / **стоп** | Stops the current work immediately |
| **silence** / **тишина** | Stops talking and listening |
| *what can you do* / *что ты умеешь* | Shows every direct command |

Direct commands — scroll, keys, tabs, windows, clicking a button by its name, a
numbered grid over the screen, dictation, opening and closing apps — are
answered instantly, without a model. Anything else goes to a live Claude Code
session that remembers the conversation and can start, correct, pause or stop
the running work.

The stop and silence words, and yes/no answers, work in both languages
whichever language is selected.

## What it asks you before doing

Four red lines: spending money, contacting other people, changing system files,
and destructive or outward-reaching commands (`git push`, `rm -rf`, `curl | sh`
and the like). Everything else runs without interrupting you.

They are checked twice, in code rather than in a prompt. The phrase you said
is classified before any agent starts. Then **every tool call the agent makes**
goes through a Claude Code `PreToolUse` hook that classifies the concrete
action — the shell command, the file being written, the button being clicked —
and asks you by voice before anything on a red line. No answer means no. This
matters because the agent reads web pages and files, and those can try to talk
it into things you never asked for.

What the hook cannot see: a click by screen coordinates or by element number
does not say what is being pressed. Codex runs in its own sandbox
(`workspace-write`, no network) and gets no desktop tools. Details:
[docs/jarvis/architecture.md](docs/jarvis/architecture.md).

## Where things are

Everything lives in one folder, `%LOCALAPPDATA%\Rujarvis`:

| Folder | What is in it |
| --- | --- |
| `src\` | The app itself |
| `data\` | Settings, memory, the action journal, the current plan, your standing instructions (`характер.md`) |
| `logs\jarvis.log` | The log; the tray has **Open log** |
| `models\` | Speech recognition (`whisper\`) and voices (`voices\`) |

Files the agent makes for you go to **Jarvis** (or **Джарвис**) on your desktop,
sorted into sections by type — Documents, Spreadsheets, Presentations, Images,
Video, Audio, Code, Archives, Apps, Other — with one subfolder per task
(`Images\Cafe logo\`). Anything the agent leaves loose in the folder is sorted
after the task; files you put there yourself are left alone.

The log records commands addressed to Jarvis, never your dictation or
conversations around you — unless you choose *everything* in **Settings →
Folders and log**, which helps when it mishears.

## Privacy

Speech is recognised and synthesised locally. The only things that leave your
machine are what you send to the Claude Code or Codex CLI you signed in to —
the same as using them directly — and your audio, only if you opt into cloud
recognition by setting `ELEVENLABS_API_KEY`. There is no telemetry.

## Honest status

- The app, setup, voice pipeline, red-line hook and both languages are tested
  on Linux in CI and by hand under a virtual display; the Windows-only parts
  (desktop driver, app launching, installer) are covered by unit tests but
  still need a pass on a real Windows machine after this rewrite.
- Measured by synthesising phrases with the Piper voice and recognising them
  with Whisper `base` (`pnpm jarvis:roundtrip`): Russian 10/12, English 9/12,
  and every stop, silence, pause and continue word recognised in both. A real
  microphone and a larger model do better; synthetic speech is a floor.
- Window control through UI Automation (`window_*` tools) uses
  [cua-driver](https://github.com/trycua/cua) (MIT). The installer downloads a
  pinned release and checks its SHA-256; if that fails, screen, mouse, keyboard
  and browser still work without it.
- GPU recognition is optional: run a whisper.cpp server and set
  `JARVIS_GPU_STT`; otherwise recognition runs on the CPU.

## Development

```bash
pnpm install
pnpm build            # esbuild, a few seconds
pnpm start            # the app
pnpm typecheck
pnpm test             # ~1,700 tests
pnpm jarvis:roundtrip -- --en   # voice round-trip with real models
```

| Directory | What it does |
| --- | --- |
| `app/` | The Electron app: tray, settings and onboarding, voice bridge, overlays |
| `jarvis/backends` | Claude Code / Codex adapters, warm live sessions, fallback chain |
| `jarvis/router` | Works out what a request needs and which backend takes it |
| `jarvis/risk` | Risk classes, the red-line policy and the tool-call hook |
| `jarvis/voice` | Wake word, stop words, recognition and synthesis, noise filtering |
| `jarvis/control` | Direct commands and the command catalogue |
| `jarvis/desktop` | The MCP server that gives the agent the screen, browser, Blender and Krita |
| `jarvis/dialogue` | The conversation stream and its levers |
| `jarvis/locale` | Russian / English |
| `jarvis/setup` | Paths, settings, onboarding helpers |

Two habits this codebase is strict about: **measure before claiming** — checks
answer passed, failed, or *nothing to measure with* — and **comments explain
why, not what**. Comments and design notes are mostly in Russian.

## Documentation

- [Install, settings and what stays on disk](docs/jarvis/install.md)
- [Architecture and the red-line hook](docs/jarvis/architecture.md)
- [Design notes](docs/jarvis/design/) (Russian)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md)

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
