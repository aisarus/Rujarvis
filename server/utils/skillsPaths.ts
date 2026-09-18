import path from 'node:path';
import { resolveInterpreterDataDir } from '../../shared/interpreterConfigPaths';
import { resolveInterpreterHome } from '../../shared/interpreterHome';

const SKILLS_SUBDIR = 'skills';
const AGENTS_DIR = '.agents';

export function getInterpreterUserDataDir(): string {
  const userDataDir = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (userDataDir) {
    return path.resolve(userDataDir);
  }

  return resolveInterpreterDataDir();
}

export function getGlobalSkillsRoot(): string {
  return path.join(resolveInterpreterHome(), SKILLS_SUBDIR);
}

export function getProjectSkillsRoot(workspacePath: string | null): string | null {
  if (!workspacePath) {
    return null;
  }

  return path.join(workspacePath, AGENTS_DIR, SKILLS_SUBDIR);
}
