# Contributing

Thank you for helping improve Rujarvis.

Before opening a change, read [AGENTS.md](AGENTS.md) — the invariants that must
stay true — and [docs/jarvis/architecture.md](docs/jarvis/architecture.md). Project
prose and code comments are in Russian; issues and pull requests in English
or Russian are both welcome.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`pnpm jarvis:roundtrip` (and `-- --en`) checks the voice path with real models:
it synthesises commands, recognises them and runs them through the same
parser as live speech. Run it when you touch recognition, wake words, stop
words or the command tables.

Keep changes focused and include tests that prove the behaviour being changed.
Anything touching the red lines (`jarvis/risk/`, the tool gate, confirmation
flow) needs a test showing the confirmation is still required.

Most of the voice and desktop layer only runs on Windows. If you could not test
on Windows, say so in the pull request rather than claiming it works.

## Developer Certificate of Origin

Rujarvis uses the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) and
does not require a contributor license agreement. Sign off every commit:

```text
Signed-off-by: Your Name <your-email@example.com>
```

`git commit -s` adds the line for you. Pull requests are checked
automatically.

Do not submit credentials, proprietary SDKs, paid license files, personal
data, or code you do not have the right to contribute.
