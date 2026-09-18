import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the one durable OIX home shared by the Interpreter CLI and desktop app.
 * OIX owns this contract: INTERPRETER_HOME wins, otherwise ~/.openinterpreter.
 * CODEX_HOME is intentionally not an input because it must not choose product identity.
 */
export function resolveInterpreterHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const explicitHome = env.INTERPRETER_HOME?.trim();
  if (explicitHome) {
    return platformPath.resolve(explicitHome);
  }

  const resolvedUserHome = homeDir
    ?? (platform === 'win32' ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE)
    ?? os.homedir();
  return platformPath.join(resolvedUserHome, '.openinterpreter');
}
