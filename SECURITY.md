# Security policy

Rujarvis drives a desktop agent with your mouse, keyboard, shell and files, so
security reports matter here more than in most projects.

**Please do not disclose vulnerabilities in a public issue.** Report them
privately through GitHub: *Security → Report a vulnerability* on
<https://github.com/aisarus/Rujarvis>. Include the commit you tested, the
impact, reproduction steps and, if you have one, a suggested fix. Do not
include real user data, recordings of other people, or active credentials.

Only the current `main` branch receives fixes.

## What is in scope

Especially welcome:

- ways for the agent to cross a red line (spending money, contacting people,
  overwriting system files, destructive shell commands) without the spoken
  confirmation — see `jarvis/risk/` and the PreToolUse gate in
  `jarvis/risk/gateHook.ts`;
- prompt injection from web pages, files or window contents that makes the
  agent act without the user;
- anything that reaches the desktop MCP server, the file bridges in the data
  folder, or the voice pipeline from outside the user's own account.

Vulnerabilities in upstream Interpreter Workstation code that also affect the
upstream project should additionally be reported to the upstream maintainers.
