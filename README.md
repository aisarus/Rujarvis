# Rujarvis

**A Russian-speaking voice assistant for Windows, built on
[Interpreter Workstation](https://github.com/openinterpreter/interpreter-workstation)
and driven entirely by subscriptions you already pay for.**

You talk to it in ordinary Russian — *«закрой это окно»*, *«посмотри почему билд
упал и почини через Клод Код»*, *«а пока открой Telegram»* — and it decides what
the request needs, which agent should do it, and whether to ask you first.

Rujarvis does not rewrite Workstation. It adds a «Jarvis» layer on top: Russian
voice UX, task routing between models, and subscription coding agents (Claude
Code, Codex) driven through their official CLIs.

Rujarvis is an independent project. It is not affiliated with or endorsed by
Open Interpreter.

## Why subscriptions and not API keys

This is the design constraint the whole project is bent around: **no paid APIs,
no API keys, no per-token billing.** Everything runs through CLIs you are
already signed into — `claude` and `codex` — plus local models for speech.

That constraint shapes the architecture. Long-running work happens inside live
CLI sessions that are kept warm and reused, because a warm session answers in
three seconds where a cold one takes twenty-eight. Speech recognition and
synthesis run locally on your own GPU and CPU.

## What works today

- **Voice, end to end.** Wake word «Джарвис», push-to-talk on `Ctrl+Space`,
  mute on `Ctrl+M`. Recognition runs on the GPU (`whisper large-v3-turbo`) with
  a CPU fallback; speech goes through a local Piper voice. Measured over 1313
  real phrases from one machine's log: median **630 ms**, mean 851 ms, 87 %
  under a second, worst case 16 s when the room was noisy.
- **Direct commands answered instantly**, without a model: scroll, keys, click
  by name, open and close applications, switch windows, dictation.
- **Long work by one sentence.** The agent writes a plan, marks steps as it
  goes, and the plan is a file you can watch while it runs.
- **A conversation that runs beside the work.** Anything that is not a direct
  command goes to a live Claude Code session that remembers the thread all
  evening and can steer the running task — stop it, pause it, resume it, file a
  correction, add a plan step, or start something new. It has no hands of its
  own: seven verbs, and every one of them goes through the working stream and
  its permissions.
- **Computer use on a subscription.** The desktop — screen, mouse, keyboard,
  windows, browser, Blender, Krita — is offered to Claude Code as MCP tools, so
  the model can look, act, and look again without an API key.

## What it asks you before doing

Four red lines: spending money, contacting other people, overwriting system
files, and destructive or outward-reaching commands (`git push`, `rm -rf`,
`curl | sh` and the like). Everything else runs without interrupting you.

They are checked twice, in code rather than in a prompt. First the phrase you
said is classified before any agent starts. Then **every tool call the agent
makes** goes through a Claude Code `PreToolUse` hook that classifies the
concrete action — the shell command, the file being written, the button being
clicked — with the same policy, and asks you by voice before anything on a red
line. No answer means no. This matters because the agent reads web pages and
files, and those can try to talk it into things you never asked for.

What the hook cannot see: a click by screen coordinates or by element number
does not say what is being pressed. Codex runs in its own sandbox
(`workspace-write`, no network) and gets no desktop tools. Details:
[docs/jarvis/architecture.md](docs/jarvis/architecture.md).

Two words always work, immediately, even when nothing else does: **«стоп»**
stops the current work, **«тишина»** makes it shut up and stop listening. They
are matched before any model sees the phrase, and a test suite guards the fact
that no new command can ever swallow them.

## Install

Windows 11, one line in PowerShell. The voice layer starts by default only on
Windows; elsewhere the app runs as plain Workstation unless `JARVIS_VOICE=on`.


```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1)))
```

The installer checks Node 22 and pnpm 9 (switching them through fnm and
corepack when needed), builds the app, downloads a speech model sized to your
machine, and puts **Rujarvis** in the Start menu.

**Honest status:** this one-liner has not yet been observed to run to the end on
a clean machine. The last recorded attempt (18 September) got as far as
`pnpm install` and stopped on an `electron-rebuild` MSBuild failure; the checks
that caused earlier failures — Node version, pnpm version, MSVC build tools —
have been fixed since, but nothing past that point has been watched on a fresh
Windows box. The machine this is developed on was finished by hand. If it
breaks for you, [docs/jarvis/install.md](docs/jarvis/install.md) has the manual
path, and an issue with the failing step is genuinely useful.

Then sign in to Claude Code once, in a terminal:

```bash
claude auth login
```

Details, parameters and a manual build: [docs/jarvis/install.md](docs/jarvis/install.md).

## What is inside

| Layer | Directory | What it does |
| --- | --- | --- |
| Backends | `jarvis/backends` | `AgentBackend` plus Claude Code / Codex / Interpreter adapters, warm live sessions, fallback chain |
| Router | `jarvis/router` | Works out required capabilities, picks a backend, normalises the phrase |
| Risk | `jarvis/risk` | SAFE / NORMAL / SENSITIVE / DANGEROUS, policy in code |
| Voice | `jarvis/voice` | Wake word, interrupt words, speech queue, spoken-vs-full answers |
| Dialogue | `jarvis/dialogue` | The conversation stream: live session, its seven levers, the file bridge to the task manager |
| Control | `jarvis/control` | The direct-command table and the spoken command catalogue |
| Agent | `jarvis/agent` | The plan: steps, states, progress |
| Tasks | `jarvis/tasks` | Foreground and background tasks, pause, cancel, the emergency kill switch |
| Desktop | `jarvis/desktop` | The MCP server that hands the screen, browser, Blender and Krita to the agent |
| Measure | `jarvis/measure` | Three-valued gates: passed / failed / **nothing to measure with** |
| Memory | `jarvis/memory` | Journal of what was done, project aliases, lessons learned from failures |
| Observe | `jarvis/observe` | The storyline shown in the log window, run logs |
| Context | `jarvis/context` | World state: active window, current project, last task |

Workstation's own infrastructure — agent runtime, computer use, browser, files,
shell, skills, permissions, desktop UI — is used as it is.

There is also `jarvis/dota`, an experiment in reading Dota 2's official Game
State Integration feed and drawing an overlay. It is parked, not maintained.

## Development

```bash
pnpm install
pnpm run dev            # renderer + Electron with hot reload
pnpm test:vitest        # vitest suite; the Jarvis layer alone is ~1,650 tests
pnpm run typecheck
```

Two habits this codebase is strict about, both learned the hard way:

**Measure before claiming.** A tool that reports success for something it never
did is worse than one that fails loudly, so checks return three answers —
passed, failed, or *nothing to measure with* — and «works» means a green run,
not code that looks right.

**Comments explain why, not what.** Nearly every odd-looking line here is the
scar of a specific failure, and the comment says which one. They are in
Russian, like the rest of the project's prose.

### Checking the claims above

Numbers in this README are measurements, and you should be able to reproduce
them rather than take them on trust:

| Claim | How to check it |
| --- | --- |
| The test count | `pnpm exec vitest run jarvis electron/jarvis server/jarvis scripts` — the summary line is the number |
| That it builds and passes on something other than this machine | the CI workflow on `main` under the repository's Actions tab |
| Recognition latency | `[jarvis] услышал за N мс` in `%LOCALAPPDATA%\Rujarvis\data\jarvis.log`; the figures above are the median, mean and 90th percentile of 1313 such lines |
| The conversation's seven levers | `npm run jarvis:talk-check` — drives a real CLI session and reports which levers reached the task manager |

Anything this README asserts without a way to check it is a bug in the README.


## Documentation

Project docs are in Russian.

**Current:**

- [Design specs](docs/jarvis/design/) — the living record, one document per
  feature, each carrying the measurements that justified the decision
- [Install, settings and what stays on disk](docs/jarvis/install.md)
- [Architecture and the red-line gate](docs/jarvis/architecture.md)
- [Syncing with upstream](docs/jarvis/upstream-sync.md)

**A snapshot from 18 September**, written before the voice layer, plan mode and
the conversation stream landed. Useful for shape and intent, not for detail:
[voice UX](docs/jarvis/voice-ru.md),
[backends](docs/jarvis/backends.md),
[MVP status](docs/jarvis/mvp-status.md).

Upstream documentation lives in [README.upstream.md](README.upstream.md) and
the `docs/` directory.

## Privacy

Speech is recognised and synthesised locally. The only things that leave your
machine are what you send to the Claude Code or Codex CLI you signed in to —
the same as using them directly — and your audio, only if you opt into cloud
recognition by setting `ELEVENLABS_API_KEY`. There is no telemetry. What stays on disk is
listed in [docs/jarvis/install.md](docs/jarvis/install.md#что-остаётся-на-диске).

## Licence

Apache License 2.0, same as upstream. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
