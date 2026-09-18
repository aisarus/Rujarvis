# Compatible document engine

The app's default document workflow is code execution plus managed skills. An
embedded document engine is an optional distribution integration, not a
requirement for building or running the community app.

The current local protocol uses port 38123 and starts lazily only when a
document viewer requests it. Installation requires an explicit user action; the
app does not install an engine during startup. The internal
`officeExtension.ensureRunning()` IPC name is retained temporarily for protocol
compatibility and does not identify or require a particular vendor.

Configure an optional release repository and installation directory through
`distribution.documentEngine` in `product.json`. Empty values disable engine
installation without disabling code-and-skills document workflows. See
`docs/document-engine.md` for the neutral integration contract and a known
compatible implementation.
