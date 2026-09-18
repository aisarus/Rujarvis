# Test OIX changes locally

Workstation installs and launches the exact OIX release pinned by the app, while
the terminal selects its release independently through OIX's `current` link.
Both use OIX's official managed standalone package store and shared
`$INTERPRETER_HOME`. If OIX is missing from the terminal, Workstation also makes
its pinned release available as `interpreter` and `i`. The pinned release and
archive contract live in `scripts/download-oix.mjs`; normal builds do not depend
on a neighboring source checkout or the legacy `oix` gitlink.

The checked-out OIX source is an upstream product boundary. It is safe to read
or build it, but do not patch it as part of a Workstation change. If OIX itself
needs a change, make and review that change in its own repository and then bump
Workstation's release pin after it ships.

## 1. Verify the pinned public runtime

From the Workstation app root:

```bash
pnpm run download:oix -- --current-platform
resources/oix/"$(node -p 'process.platform + "-" + process.arch')"/bin/interpreter --version
pnpm run test:interpreter:smoke
```

The smoke test exercises the same `interpreter app-server` entrypoint the
Electron app launches.

## 2. Build a local OIX checkout without modifying it

Point `OIX_CHECKOUT` at an Open Interpreter checkout. The commands below only
build and read it.

```bash
OIX_CHECKOUT=/absolute/path/to/openinterpreter
cd "$OIX_CHECKOUT/codex-rs"
env CARGO_INCREMENTAL=0 cargo test -p codex-app-server
env CARGO_INCREMENTAL=0 cargo build -p codex-cli --bin codex
```

Adjust the test package or filter for the contract being changed. Provider,
model, harness, thread, steering, approval, and history changes should be
covered at the app-server boundary.

## 3. Select the locally built executable

First download the pinned package so its `codex-path`, `codex-resources`, helper
binaries, and metadata are present. Then use the explicit development override
to select the local build. The resolver verifies that the executable identifies
as Interpreter and exposes `app-server --listen`; a random executable named
`interpreter` is rejected.

```bash
cd /absolute/path/to/workstation/app
pnpm run download:oix -- --current-platform

OIX_CHECKOUT=/absolute/path/to/openinterpreter
export INTERPRETER_OIX_PATH="$OIX_CHECKOUT/codex-rs/target/debug/codex"
```

On Windows, point `INTERPRETER_OIX_PATH` at the built `.exe`. This override is
for development only and must not be persisted in product configuration.

## 4. Test Workstation against the local build

```bash
pnpm run test:interpreter:smoke
resources/oix/"$(node -p 'process.platform + "-" + process.arch')"/bin/interpreter app-server --help
pnpm run test:unit
```

For manual desktop testing, keep `INTERPRETER_OIX_PATH` exported and run:

```bash
pnpm dev
```

To return to normal resolution, unset the development override. Workstation
will install and launch its pinned OIX release. It will only select that release
for the terminal when no terminal OIX exists or when the terminal selector is
still owned by Workstation:

```bash
unset INTERPRETER_OIX_PATH
```

## 5. Ship an OIX release bump

After the OIX change is published:

1. Update `PINNED_VERSION` in `scripts/download-oix.mjs`.
2. Regenerate the app-server schemas with the downloaded unified runtime.
3. Run the packaging, contract, integration, and Electron smoke tests.
4. Commit the generated protocol changes and the release pin together.

Do not move the legacy `oix` gitlink as a substitute for updating the runtime
release pin. Workstation's production boundary is the downloaded, checksummed
package.
