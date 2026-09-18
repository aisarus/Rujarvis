import fs from "node:fs";

// Requiring Electron installs its platform binary when pnpm's side-effects
// cache restored the package metadata without the downloaded executable. Do
// this before Playwright starts so a cold download is not charged against an
// individual page fixture's timeout.
const { default: electronPath } = await import("electron");

if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  throw new Error(
    `Electron test runtime is unavailable at ${String(electronPath)}`,
  );
}

console.log(`Electron test runtime ready: ${electronPath}`);
