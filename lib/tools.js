import fs from 'node:fs/promises';
import path from 'node:path';
import { execute } from './shell.js';
import { diffLines } from './diff.js';

export const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          offset: { type: 'integer', description: '1-based start line (optional)' },
          limit: { type: 'integer', description: 'Max lines (optional, default 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List directory entries.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search literal substring in files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in project root.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

export function isReadOnlyTool(name) {
  return name === 'read_file' || name === 'list_dir' || name === 'grep';
}

export async function approvalFor(context, name, argumentsText) {
  if (name === 'bash') {
    return context.workspace.bashNeedsApproval(parseArgs(argumentsText).command || '') ? 'on_request' : 'auto';
  }

  const pathArg = extractPath(name, argumentsText);
  if (!pathArg) return 'auto';
  try {
    await context.workspace.resolvePath(pathArg);
    return 'auto';
  } catch {
    return 'on_request';
  }
}

export function approvalPrompt(name, argumentsText) {
  if (name === 'bash') {
    const cmd = parseArgs(argumentsText).command || '';
    return `Allow bash command outside sandbox policy?\n  command: ${cmd}`;
  }
  return 'Allow access outside workspace?';
}

export async function dispatch(context, name, argumentsText) {
  if (name === 'read_file') return toolReadFile(context, argumentsText);
  if (name === 'write_file') return toolWriteFile(context, argumentsText);
  if (name === 'list_dir') return toolListDir(context, argumentsText);
  if (name === 'grep') return toolGrep(context, argumentsText);
  if (name === 'bash') return toolBash(context, argumentsText);
  return `Unknown tool: ${name}`;
}

function extractPath(name, argumentsText) {
  const args = parseArgs(argumentsText);
  if (args.path) return args.path;
  if (name === 'list_dir' || name === 'grep') return '.';
  return null;
}

async function toolReadFile(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  const abs = await context.workspace.resolvePath(args.path);
  const data = await fs.readFile(abs, 'utf8');
  const startLine = args.offset ?? 1;
  const maxLines = args.limit ?? 200;
  const lines = data.split(/\n/);
  const out = [];

  for (let index = 0; index < lines.length && out.length < maxLines; index += 1) {
    const lineNo = index + 1;
    if (lineNo >= startLine) {
      out.push(`${lineNo}|${lines[index].replace(/\r$/, '')}`);
    }
  }
  return out.length > 0 ? `${out.join('\n')}\n` : `(empty file or offset beyond end): ${args.path}`;
}

async function toolWriteFile(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.content, 'content');
  const abs = await context.workspace.resolvePath(args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  // Read old content for diff (if file exists)
  let oldContent = '';
  let fileExisted = false;
  try {
    oldContent = await fs.readFile(abs, 'utf8');
    fileExisted = true;
  } catch {
    // file does not exist yet
  }

  await fs.writeFile(abs, args.content, 'utf8');

  // Compute and append diff
  const diffText = diffLines(args.path, oldContent, args.content, fileExisted);
  const size = Buffer.byteLength(args.content, 'utf8');
  return `Wrote ${size} bytes to ${args.path}\n${diffText}`;
}

async function toolListDir(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  const abs = await context.workspace.resolvePath(args.path);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const entry of entries.slice(0, 500)) {
    out.push(`${entryKind(entry)} ${entry.name}`);
  }
  if (entries.length > 500) out.push('...[truncated]');
  return out.length > 0 ? `${out.join('\n')}\n` : '(empty directory)';
}

async function toolGrep(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.path, 'path');
  requireString(args.pattern, 'pattern');
  const start = await context.workspace.resolvePath(args.path);
  const out = [];
  await walkFiles(start, async (file) => {
    if (out.length >= 100) return;
    let data;
    try {
      data = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    const rel = context.workspace.relativePath(file);
    const lines = data.split(/\n/);
    for (let i = 0; i < lines.length && out.length < 100; i += 1) {
      const line = lines[i].replace(/\r$/, '');
      if (line.includes(args.pattern)) {
        out.push(`${rel}:${i + 1}:${line.trim()}`);
      }
    }
  });
  return out.length > 0 ? `${out.join('\n')}\n` : `No matches for '${args.pattern}' under ${args.path}`;
}

async function toolBash(context, argumentsText) {
  const args = parseArgs(argumentsText);
  requireString(args.command, 'command');
  const shellConfig = {
    cwd: (context.workspace && context.workspace.root) || process.cwd(),
    maxObservationBytes: (context.config && context.config.maxObservationBytes) || 8192,
  };
  return execute(shellConfig, args.command);
}

function parseArgs(argumentsText) {
  try {
    return JSON.parse(argumentsText || '{}');
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error.message}`);
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required string parameter '${name}' is missing or empty`);
  }
}

function entryKind(entry) {
  return entry.isDirectory() ? 'dir' : 'file';
}

async function walkFiles(dir, fn) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await walkFiles(full, fn);
    } else if (entry.isFile()) {
      await fn(full);
    }
  }
}
