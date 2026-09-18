import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BuiltinServerDefinition,
  BuiltinToolContext,
  BuiltinToolDefinition,
} from '../../builtinTools';
import { resolvePathWithWorkspace } from '../../../utils/permissions';

function resolveTestPath(rawPath: unknown, context?: BuiltinToolContext): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim() || !context?.workspace) {
    return null;
  }
  return resolvePathWithWorkspace(rawPath, context.workspace);
}

const readFileTool: BuiltinToolDefinition = {
  name: 'read_file',
  description: 'Read a UTF-8 test fixture through the real filesystem permission boundary.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
    },
    required: ['path'],
  },
  fileAccess: { mode: 'read', pathArg: 'path' },
  mode: 'read',
  fileTypes: ['*'],
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    const resolvedPath = resolveTestPath(args.path, context);
    if (!resolvedPath) {
      return {
        content: [{ type: 'text', text: 'Test file read requires a path and an active workspace.' }],
        isError: true,
      };
    }

    const content = await readFile(resolvedPath, 'utf8');
    return {
      content: [{ type: 'text', text: `Read file at: ${resolvedPath}\n${content}` }],
      isError: false,
    };
  },
};

const writeFileTool: BuiltinToolDefinition = {
  name: 'write_file',
  description: 'Write a UTF-8 test fixture through the real filesystem permission boundary.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
      content: { type: 'string', description: 'UTF-8 file contents.' },
    },
    required: ['path', 'content'],
  },
  fileAccess: { mode: 'write', pathArg: 'path' },
  mode: 'write',
  fileTypes: ['*'],
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  handler: async (args, context) => {
    const resolvedPath = resolveTestPath(args.path, context);
    if (!resolvedPath || typeof args.content !== 'string') {
      return {
        content: [{ type: 'text', text: 'Test file write requires a path, content, and an active workspace.' }],
        isError: true,
      };
    }

    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, args.content, 'utf8');
    return {
      content: [{ type: 'text', text: `Wrote file at: ${resolvedPath}` }],
      isError: false,
    };
  },
};

export const testFilesystemServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-test-filesystem',
  name: 'Test Filesystem',
  description: 'Test-only filesystem permission fixtures.',
  isBuiltin: true,
  tools: [readFileTool, writeFileTool],
  resources: [],
  prompts: [],
};
