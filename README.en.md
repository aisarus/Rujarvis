# Rujarvis

[Русская версия](README.md)

**Lecture notes for students who study in a foreign language.**

Rujarvis records a lecture — in the room through your laptop's microphone, or on
Zoom through your computer's sound — transcribes it on your computer and writes
notes in your language into Obsidian: timed sections, a summary, concepts with the
lecturer's own term, exam questions. A lecture in Hebrew, notes in English. Then
you can study from that lecture in its Study window.

- **The audio stays with you.** whisper.cpp recognises speech on your computer. For
  Hebrew it uses the fine-tuned [ivrit.ai](https://huggingface.co/ivrit-ai) model:
  on open recordings of university lectures, 14% word errors against 35% for plain
  small. Other languages use the general large-v3-turbo.
- **Your own subscription writes the notes.** Claude Code (Claude Pro) or Codex
  (ChatGPT Plus), signed in by you; either one is enough. No API keys, no account
  with us, no telemetry. Only the text of the transcript and the files you hand in
  for a walkthrough leave your computer.
- **It does not trust the recording blindly.** Recognition mixes up numbers and
  letters, and lecturers make mistakes too. Numbers, formulas, notation and stated
  answers are checked against the lecture itself and knowledge of the subject, and
  every correction is visible, with its minute:
  *(⚠ 1:42:39: the lecturer said "1 and 3", by calculation it is 1 and 4 — check
  against the slide)*. Formulas are in LaTeX, which Obsidian renders.
- **A lecture does not get lost.** The audio goes to disk right away. Close the app
  mid-class and the notes finish themselves on the next start. A recording from your
  phone or a course video goes through the "From a file…" button.
- **Then you study.** The Study window: what to review today, a quiz in the language
  of the lecture with a translation and the lecturer's voice from that minute,
  flashcards, exam practice, problems.
- **Course files too.** A syllabus, an article, an assignment: drop the file and get
  a walkthrough in your language in Obsidian and questions on it in Study.

Notes are in Russian or English. Lectures can be in Hebrew, English, Russian and
other languages, with settings per course. What has been run live is Hebrew →
Russian (see [honest status](#honest-status)).

**It is also a voice assistant.** The full edition listens for commands in Russian
and English: *"close this window"*, *"scroll down"*, *"find why the build fails and
fix it"*. Simple things happen at once, with no model and no internet. Anything
bigger is real work by Claude Code on your screen, in your browser and in your
files. Before anything that spends money, messages people or can't be undone, it
asks you out loud. Details: [talking to it](#talking-to-it) and
[what it asks you before doing](#what-it-asks-you-before-doing). The notes-only
edition installs without any of this.

## Install

### What the notes need

- **Windows 10/11 with an NVIDIA graphics card, or a Mac on macOS 13 or later.** On
  Windows without NVIDIA the installer does not set up recognition, and a lecture is
  only recorded. A button in settings can install it, but without a graphics card this
  is untested and probably many times slower than the lecture itself.
- **A Claude Pro or ChatGPT Plus subscription.** The first-run wizard installs Claude
  Code or Codex with a button and checks hearing and the model before your first
  class.
- **Obsidian, preferably.** Notes land in the open vault, in a `Lectures` folder.
  Without Obsidian they go to Jarvis's results folder, as the same `.md` files.
- **Disk space.** A few gigabytes for the app and models, plus about 280 MB for a
  90-minute class. Audio older than a week is removed by itself; notes and
  transcripts stay.
- **For Zoom on a Mac, macOS 14.2 or later.** On older versions a Zoom lecture is
  recorded through the microphone.

### Notes only

For a student who wants the note-taker, not the voice assistant: no command
listening, no voice, no hands on the computer. The line is for lectures in Hebrew;
for another language use its code (`en`, `ru`, …).

Windows, in PowerShell:

```powershell
$f = "$env:TEMP\rujarvis-install.ps1"; irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 -OutFile $f; & $f -Edition notes -LectureLanguage he -Language en
```

macOS, in Terminal (with a ChatGPT subscription, add `--codex`):

```bash
f=/tmp/rujarvis-install.sh; curl -fsSL https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.sh -o "$f" && bash "$f" --notes --lecture-language he --language en
```

More in [the install guide](docs/jarvis/install.md#только-конспекты) (Russian).

### All of Jarvis

The notes and the voice assistant together. Windows 10/11, one line in PowerShell.

Where to find it: press **Win**, type `PowerShell`, open "Windows PowerShell".
Administrator rights are not needed. Copy the whole line, paste it (**Ctrl+V**
or right-click) and press Enter.

```powershell
$f = "$env:TEMP\rujarvis-install.ps1"; irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 -OutFile $f; & $f
```

English by default instead of Russian:

```powershell
$f = "$env:TEMP\rujarvis-install.ps1"; irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 -OutFile $f; & $f -Language en
```

The installer puts Git and Node.js in place if they are missing, builds the
app, downloads a speech model sized to your machine and a voice, adds
**Rujarvis** to the Start menu and starts it. No administrator rights, no C++
compiler, no Rust. Running it again updates the install.

macOS, one line in Terminal.

Where to find it: press **Cmd+Space**, type `Terminal`, press Enter. It ships
with macOS — nothing to install. Copy the whole line, paste it (**Cmd+V**) and
press Enter. The system asks for your password once if Homebrew is needed.

```bash
f=/tmp/rujarvis-install.sh; curl -fsSL https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.sh -o "$f" && bash "$f" --language en
```

Through a file as well, not `curl | bash`. The reason is measured: a script
arriving through a pipe has an already-empty `stdin` and cannot ask you
anything — a prompt from Homebrew, corepack or pnpm fails silently instead of
reaching you. Run from a file, `stdin` stays your terminal, and flags read
normally, without `-s --`.

Same order: Homebrew, Git and Node.js are installed if missing, the app is
built, the speech models are downloaded, **Rujarvis** lands in `~/Applications`.
Voice, the conversation and Claude Code work the same as on Windows. Driving
other windows — focus, keys, screenshots, reading elements — works on macOS
too, through System Events and CoreGraphics instead of the Windows API.
Measured on a real Mac on 2026-09-24: of sixteen acceptance scenarios thirteen
passed, two had nothing to measure (they are about the Windows registry), and
one failed — the click grid does not cover the menu bar and the dock.

macOS asks for two separate permissions: Accessibility (windows, mouse, keys)
and Screen Recording (screenshots). Without the first, CGEvent does not fail —
it **silently does nothing** — so Jarvis asks for the permission up front
rather than discovering it from a no-op.

On first start a short setup walks you through the language, signing in to
Claude Code, the speech models and a microphone check. Everything can be
changed later from the tray icon → **Settings**.

You need [Claude Code](https://claude.ai/code) signed in with your own
subscription for anything beyond direct commands. Codex works as a fallback if
you have it.

**Your own model instead of a subscription** — for powerful computers. If you
already run Ollama (0.14+), LM Studio or llama.cpp (`llama-server --jinja`),
enter its address and model name in **Settings → Agents**. Jarvis points the
same Claude Code at it: no Anthropic sign-in, same red lines and tools. "Check
and turn on" asks the model for real and refuses one that cannot call tools.
Only addresses on this computer or your home network are accepted; Jarvis does
not download models.

## How a lecture goes

The overlay has a **● Lecture notes** button, since you can't give voice commands in a
lecture hall. It asks where the sound comes from: the room (microphone) or Zoom
(computer sound). The note opens in Obsidian at once and grows as you watch: the
transcript chunk by chunk, a section of notes every five minutes. **■ Stop lecture notes**
writes the summary and files the lecture under its course:

```
Lectures/
  Statistics/
    Statistics.md                        course page
    2026-11-03 — Measures of center.md   notes
    2026-11-03 — Measures of center — transcript.md
    2026-11-03 — Measures of center.wav  audio: play it from any minute
```

- **The look of the notes** is your choice in settings: a walkthrough, questions
  first, or the lecture's language alongside (the lecturer's sentences with a
  translation and a glossary of the lecture).
- **The course** is guessed from your timetable and the content; if it is wrong, use
  the "Course: … ▾" button.
- **If the lecturer is hard to hear**, the overlay says so in the first minutes, not
  that evening over empty notes. The best insurance is a phone recording from the
  front row and "From a file…".

Details, in Russian: [lecture notes](docs/jarvis/lecture-notes.md),
[Study](docs/jarvis/study.md), [course files](docs/jarvis/document-pipeline.md).

## Talking to it

This is about the full edition.

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
answered instantly, without a model. Anything else goes to the conversation, which
remembers the thread and can start, correct, pause or stop the running work. A
live Claude Code session runs it, or Codex when Claude Code is not there (a
slower turn: one process per reply).

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
(`workspace-write`: writes only inside the working folder) and gets no desktop
tools; whether that sandbox has network access is set by Codex's own
configuration, not by Jarvis — check it if that matters to you. Details:
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

### Uninstall

Windows, in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Rujarvis\src\uninstall.ps1"
```

macOS, in Terminal:

```bash
bash "$HOME/Library/Application Support/Rujarvis/src/uninstall.sh"
```

Uninstalling closes Jarvis and removes its shortcuts, autostart and its whole
folder. It leaves your results folder on the desktop and your Claude Code and
Codex sign-ins alone.

## Privacy

Speech is recognised and synthesised locally, and lecture audio stays on disk. The
only things that leave your machine are what you send to the Claude Code or Codex
CLI you signed in to — the same as using them directly, which for notes means the
text of the transcript — and your audio, only if you opt into
recognition off this machine: the cloud (the "Where speech is recognised"
switch in settings, Speech tab, plus an `ELEVENLABS_API_KEY`; the key alone turns
nothing on) or your own whisper.cpp server over the network (`JARVIS_GPU_STT`
pointing somewhere other than `localhost`). There is no telemetry.

## Honest status

This is an early version, in closed beta.

- **Notes, live.** The project's owner records their own university classes with it
  on Windows with NVIDIA: lectures in Hebrew, notes in Russian, the laptop's
  microphone in the lecture hall. The latest run was on 2026-11-03: three classes, the
  longest 2:30. Study runs on those same lectures. Other language pairs have hardly
  been run live.
- **Checking the recording is a model's work, not a guarantee.** On the 2026-11-03
  statistics class the summary put together the right median formula and flagged the
  lecturer's wrong answer. But sections can still carry something unmarked ("frequency
  (density)"), and the time in a mark is sometimes one line late. No mark does not
  mean no mistake: check against the slide.
- **Zoom on Windows** is measured through the output loopback: silence with no sound,
  signal on a phrase from the speakers.
- **Codex** is tested live (codex-cli 0.153.4, a ChatGPT subscription): an 8-minute
  lecture in Hebrew, Study, an open answer, a docx walkthrough. PDFs through Codex are
  only read on a Mac so far.
- **Mac.** In CI on Apple Silicon and Intel: the `--notes --codex` install, the
  note-taker with a fake microphone (`pnpm jarvis:notes-check`, 8 of 8), PDFKit. **Not
  yet checked on a live Mac:** the microphone and macOS permissions, Zoom sound,
  recognition speed on a real Intel Mac (CI's virtual machines say nothing about it),
  a whole PDF walkthrough through Codex. Voice control on a Mac was measured
  separately; see Install.
- **The voice assistant.** The app, setup, voice pipeline, red-line hook and both
  languages are tested in CI on Windows and Linux and by hand under a virtual display;
  live, it runs on the owner's Windows machine. A first tester went through the whole
  install on their own Windows; there has been no planned run on clean Windows 10 and
  11 yet.
- Measured by synthesising phrases with the Piper voice and recognising them
  with Whisper `base` (`pnpm jarvis:roundtrip`): Russian 10/12, English 9/12,
  and every stop, silence, pause and continue word recognised in both. A real
  microphone and a larger model do better; synthetic speech is a floor.
- Window control through UI Automation (`window_*` tools) uses
  [cua-driver](https://github.com/trycua/cua) (MIT). The installer downloads a
  pinned release and checks its SHA-256; if that fails, screen, mouse, keyboard
  and browser still work without it.
- GPU recognition is optional: `pnpm jarvis:gpu-stt` installs whisper.cpp and
  the small model (Windows — the CUDA build for NVIDIA cards, about 900 MB;
  Mac — `brew install whisper-cpp`, Metal) into the Jarvis folder, and Jarvis
  starts its own server on this machine. Check it with
  `pnpm jarvis:gpu-stt-check`. Without it, voice commands are recognised on the CPU
  and lectures are only recorded. Your own server over the network — `JARVIS_GPU_STT`.
- The lecture model is installed by the installer or a button in settings, by hand
  with `pnpm jarvis:lecture-model` (574 MB; ivrit.ai for Hebrew is 1.6 GB before
  compression). Study's questions are prepared by Claude Code or Codex on your
  subscription after each lecture. Formulas in the Study window are readable text
  (`x₀`, `a/b`); Obsidian renders the real fractions.

## Development

```bash
pnpm install
pnpm build            # esbuild, a few seconds
pnpm start            # the app
pnpm typecheck
pnpm test             # ~2,650 tests
pnpm jarvis:roundtrip -- --en   # voice round-trip with real models
```

| Directory | What it does |
| --- | --- |
| `app/` | The Electron app: tray, settings and onboarding, voice bridge, overlays, the Study window |
| `jarvis/lecture` | Recording a lecture, sections and summary of the notes, courses, recovery |
| `jarvis/study` | Preparing questions, quiz, flashcards, exam practice, the knowledge scale |
| `jarvis/notes`, `jarvis/documents` | Formatting Obsidian notes and walking through course files |
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
- [Lecture notes](docs/jarvis/lecture-notes.md) (Russian)
- [Studying from the notes](docs/jarvis/study.md) (Russian)
- [Walking through course files](docs/jarvis/document-pipeline.md) (Russian)
- [Design notes](docs/jarvis/design/) (Russian)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md)

Rujarvis started as a fork of
[Interpreter Workstation](https://github.com/openinterpreter/interpreter-workstation)
and is now a standalone app. It is not affiliated with or endorsed by Open
Interpreter.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
