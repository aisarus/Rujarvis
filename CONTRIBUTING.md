# Contributing

Thank you for helping improve Rujarvis.

Before opening a change, read [AGENTS.md](AGENTS.md) — it describes what
belongs in the Jarvis layer and what stays in upstream Interpreter Workstation —
and the document under `docs/jarvis/` for the part you are changing. Project
prose and code comments are in Russian; issues and pull requests in English
or Russian are both welcome.

```bash
git submodule update --init --recursive
pnpm install
pnpm typecheck
pnpm run test:unit
pnpm run test:vitest
```

Keep changes focused and include tests that prove the behaviour being changed.
Anything touching the red lines (`jarvis/risk/`, the tool gate, confirmation
flow) needs a test showing the confirmation is still required.

Most of the voice and desktop layer only runs on Windows. If you could not test
on Windows, say so in the pull request rather than claiming it works.

## Developer Certificate of Origin

Rujarvis inherits Interpreter Workstation's
[Developer Certificate of Origin 1.1](https://developercertificate.org/) and
does not require a contributor license agreement. Sign off every commit:

```text
Signed-off-by: Your Name <your-email@example.com>
```

`git commit -s` adds the line for you. Pull requests are checked
automatically.

Do not submit credentials, proprietary SDKs, paid license files, personal
data, or code you do not have the right to contribute.
