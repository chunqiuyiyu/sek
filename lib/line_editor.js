/**
 * line_editor.js — fish-style line editor with autosuggestions.
 *
 * Replace readline.question() with a keypress-driven loop giving:
 *  - real-time greyed-out autosuggestions (→ / Ctrl+F to accept)
 *  - Tab completion with a candidate list
 *  - syntax highlighting for known commands
 *  - history navigation (↑ / ↓)
 *  - Emacs-style line editing (Ctrl+A/E, Ctrl+U/K, Ctrl+W, etc.)
 *  - @ file-path completion (suggest files/dirs from workspace)
 *  - Conventional Commits prefix autosuggestion (add, fix, update, etc.)
 */

import { emitKeypressEvents } from 'node:readline';
import process from 'node:process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// ── ANSI escape helpers ────────────────────────────────────────────────────

const esc = '\x1b';
const csi = `${esc}[`;

function cursorBack(n = 1) { return `${csi}${n}D`; }
function eraseInLine(n = 0) { return `${csi}${n}K`; } // 0=toEnd, 1=toStart, 2=full

const style = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  inverse: '\x1b[7m',
};

/**
 * Compute visible width of a string (ignoring ANSI escape sequences).
 * Supports CJK wide characters and emoji surrogate pairs.
 */
export function visibleWidth(str) {
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);
    if (code === 0x1b) {
      i += 1;
      if (i < str.length && str[i] === '[') {
        i += 1;
        while (i < str.length) {
          const ch = str[i];
          i += 1;
          if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
              ch === '@' || ch === '[' || ch === '\\' || ch === ']' ||
              ch === '^' || ch === '_' || ch === '`' || ch === '{' ||
              ch === '|' || ch === '}' || ch === '~') {
            break;
          }
        }
      }
      continue;
    }
    if (code <= 0x1f || code === 0x7f) { i += 1; continue; }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) { i += 2; w += 2; continue; }
    // CJK wide
    if ((code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xfe00 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xffef)) {
      w += 2;
    } else {
      w += 1;
    }
    i += 1;
  }
  return w;
}

/**
 * Strip ANSI escape sequences from a string.
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function visiblePrefix(str, maxWidth) {
  if (maxWidth <= 0) return '';
  let width = 0;
  let end = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const charWidth = code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xfe00 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xffef))
      ? 2
      : 1;
    if (width + charWidth > maxWidth) break;
    width += charWidth;
    end += ch.length;
  }
  return str.slice(0, end);
}

export function promptLine(prompt) {
  return prompt.split(/\r?\n/).pop() ?? '';
}

export function cursorBackToLogicalCursor(bufferAfter, suggestionText) {
  return visibleWidth(bufferAfter) + visibleWidth(suggestionText);
}

export function normalizeInputKey(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

export function isPrintableInput(key) {
  if (!key || key.includes(esc)) return false;
  for (const ch of key) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// ── Command/context database ──────────────────────────────────────────────

const DEFAULT_COMMANDS = [
  { name: '/help', desc: 'Show help', group: 'system' },
  { name: '/exit', desc: 'Quit', group: 'system' },
  { name: '/quit', desc: 'Quit', group: 'system' },
  { name: '/stats', desc: 'Show usage stats', group: 'system' },
  { name: '/ask', desc: 'Enter read-only ask mode', group: 'system' },
  { name: '/agent', desc: 'Return to agent mode', group: 'system' },
];

const TOOL_COMMANDS = [
  { name: 'read_file', desc: 'Read a file in workspace', group: 'tool' },
  { name: 'write_file', desc: 'Write a file in workspace', group: 'tool' },
  { name: 'list_dir', desc: 'List directory contents', group: 'tool' },
  { name: 'grep', desc: 'Search for text in files', group: 'tool' },
  { name: 'bash', desc: 'Run a shell command', group: 'tool' },
];

/**
 * Conventional Commits prefixes for git commit messages.
 * These are matched in reverse-length order so that longer prefixes
 * like "perf" take precedence over shorter ones like "feat".
 */
const CONVENTIONAL_COMMIT_PREFIXES = [
  'fix', 'feat', 'chore', 'docs', 'style', 'refactor', 'perf', 'test',
  'build', 'ci', 'revert',
];

// ── @-completion helper ────────────────────────────────────────────────────

/**
 * Find the @-completion context at the cursor position.
 * Looks backwards for an '@' character that is not preceded by whitespace
 * or inside quotes, then captures the partial path after it.
 * Returns `null` if there is no active @-completion context.
 */
export function findAtToken(input, cursor) {
  if (!input) return null;
  const beforeCursor = input.slice(0, cursor);
  const lastAt = beforeCursor.lastIndexOf('@');
  if (lastAt === -1) return null;
  const partial = beforeCursor.slice(lastAt + 1);
  if (/[\s'"]/.test(partial)) return null;

  let endIndex = cursor;
  while (endIndex < input.length && !/[\s'"]/.test(input[endIndex])) {
    endIndex += 1;
  }

  return {
    atIndex: lastAt,
    startIndex: lastAt + 1,
    endIndex,
    partial,
  };
}

export function completionReplacementEnd(input, endIndex, completions) {
  if (
    endIndex < input.length &&
    /\s/.test(input[endIndex]) &&
    completions.length > 0 &&
    completions.every((completion) => completion.endsWith(' '))
  ) {
    return endIndex + 1;
  }
  return endIndex;
}

/**
 * Given a workspace root and a partial path (after @), return matching entries.
 * Returns an array of { name, isDir, full } objects.
 */
async function getPathCompletions(workspaceRoot, atToken) {
  const partial = atToken.partial || '';
  const isAbsolute = path.isAbsolute(partial);
  const dir = isAbsolute ? path.dirname(partial) : path.join(workspaceRoot, path.dirname(partial));
  const base = path.basename(partial);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!name.startsWith(base)) continue;
    const isDir = entry.isDirectory();
    const isSpecial = name === '.' || name === '..';
    const suffix = isDir ? (isSpecial ? '' : path.sep) : ' ';
    const displaySuffix = isDir ? path.sep : '';
    const full = isAbsolute
      ? path.join(dir, name) + (isDir ? path.sep : '')
      : path.relative(workspaceRoot, path.join(dir, name)) + (isDir ? path.sep : '');
    results.push({
      name,
      full,
      isDir,
      suffix,
      displaySuffix,
      isSpecial,
    });
  }
  return results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── Suggester (completion + suggestion) ────────────────────────────────────

export async function getCompletions(input, cursor, workspaceRoot) {
  if (!input) {
    return { start: 0, completions: DEFAULT_COMMANDS.map((c) => `${c.name} `) };
  }

  const atToken = findAtToken(input, cursor);
  if (atToken && workspaceRoot) {
    const entries = await getPathCompletions(workspaceRoot, atToken);
    const completions = entries.map((entry) => entry.full + (entry.isDir ? '' : ' '));
    return {
      start: atToken.startIndex,
      end: completionReplacementEnd(input, atToken.endIndex, completions),
      completions,
    };
  }

  const beforeCursor = input.slice(0, cursor);
  const afterCursor = input.slice(cursor);
  const wordStart = beforeCursor.lastIndexOf(' ') + 1;
  const wordEnd = afterCursor.indexOf(' ') === -1 ? input.length : cursor + afterCursor.indexOf(' ');
  const partial = input.slice(wordStart, wordEnd);
  const completions = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS]
    .map((cmd) => cmd.name)
    .filter((name) => name.startsWith(partial) && name !== partial)
    .map((name) => `${name} `);

  return {
    start: wordStart,
    end: completionReplacementEnd(input, wordEnd, completions),
    completions,
  };
}

export class Suggester {
  constructor() {
    this._history = [];
    this._historyIndex = -1;

    // Suggestions for the current input (computed on demand)
    this._suggestions = [];

    // Cache for autosuggest completions
    this._lastInput = '';
    this._lastSuggestion = '';
    this._suggestionIndex = 0;
  }

  /** Push a non-empty line into history. */
  pushHistory(line) {
    this._history.push(line);
    this._historyIndex = this._history.length;
  }

  setWorkspaceRoot(root) {
    this._workspaceRoot = root;
  }

  addEntry(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    const idx = this._history.indexOf(trimmed);
    if (idx !== -1) this._history.splice(idx, 1);
    this._history.unshift(trimmed);
    this._historyIndex = this._history.length;
  }

  suggest(line) {
    if (!line) return '';
    if (DEFAULT_COMMANDS.some((cmd) => cmd.name === line)) return '';
    for (const entry of this._history) {
      if (entry.startsWith(line) && entry.length > line.length) return entry;
    }
    const suffix = this._buildSuggestion(line);
    return suffix ? line + suffix : '';
  }

  /** Move history index backward (older) or forward (newer). delta = -1 or +1 */
  moveHistory(delta) {
    const newIndex = this._historyIndex + delta;
    if (newIndex < 0 || newIndex > this._history.length) return null;
    this._historyIndex = newIndex;
    return this._historyIndex < this._history.length
      ? this._history[this._historyIndex]
      : '';
  }

  // ── Autosuggestion ───────────────────────────────────────────────────────

  _buildSuggestion(input) {
    if (!input) return '';
    if (input.startsWith('/')) {
      for (const cmd of DEFAULT_COMMANDS) {
        if (cmd.name.startsWith(input) && cmd.name.length > input.length) {
          return cmd.name.slice(input.length);
        }
      }
      return '';
    }
    // Conventional commit prefix autosuggestion
    for (const prefix of CONVENTIONAL_COMMIT_PREFIXES) {
      const fullPrefix = prefix + ': ';
      if (fullPrefix.startsWith(input) && fullPrefix.length > input.length) {
        return fullPrefix.slice(input.length);
      }
    }
    return '';
  }

  /** Return current suggestion (remaining substring). */
  getSuggestion(input) {
    if (input !== this._lastInput) {
      this._lastInput = input;
      this._lastSuggestion = this._buildSuggestion(input);
      this._suggestionIndex = 0;
    }
    return this._lastSuggestion;
  }

  /** Accept one character of the suggestion. */
  acceptChar() {
    const sug = this._lastSuggestion;
    if (this._suggestionIndex < sug.length) {
      const ch = sug[this._suggestionIndex];
      this._suggestionIndex += 1;
      return ch;
    }
    return null;
  }

  /** Accept the full suggestion. */
  acceptAll() {
    const remaining = this._lastSuggestion.slice(this._suggestionIndex);
    this._suggestionIndex = this._lastSuggestion.length;
    return remaining;
  }

  reset() {
    this._lastInput = '';
    this._lastSuggestion = '';
    this._suggestionIndex = 0;
  }
}

// ── Tab completion engine ──────────────────────────────────────────────────

export class CompletionEngine {
  constructor(workspaceRoot) {
    this._workspaceRoot = workspaceRoot;
    this._currentCompletions = [];
    this._currentIndex = 0;
    this._currentInput = '';
    this._currentCursor = 0;
    this._lastTabTime = 0;
    this._doubleTab = false;
    this._atToken = null; // save for @-completion (not serialized)
  }

  reset() {
    this._currentCompletions = [];
    this._currentIndex = 0;
    this._currentInput = '';
    this._currentCursor = 0;
    this._doubleTab = false;
    this._atToken = null;
  }

  /**
   * Compute completions for the given input & cursor.
   * Returns a state snapshot that can be passed to formatCompletion.
   */
  async compute(input, cursor) {
    const now = Date.now();
    const doubleTab = (now - this._lastTabTime < 500);
    this._lastTabTime = now;
    this._currentInput = input;
    this._currentCursor = cursor;

    // @-path completion
    const atToken = findAtToken(input, cursor);
    if (atToken) {
      this._atToken = atToken;
      const paths = await getPathCompletions(this._workspaceRoot, atToken);
      this._currentCompletions = paths;
      this._currentIndex = 0;
      this._doubleTab = doubleTab && paths.length > 0;
      return {
        completions: paths.map((p) => p.full),
        index: 0,
        doubleTab: this._doubleTab,
        prefix: input.slice(0, atToken.startIndex),
        suffix: input.slice(atToken.endIndex),
      };
    }
    this._atToken = null;

    let prefix = input.slice(0, cursor);
    let suffix = input.slice(cursor);

    const trimmed = input.trim();
    const atStart = cursor === 0 || (cursor > 0 && /\s/.test(input[cursor - 1]));

    const all = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS];

    let candidates;
    if (atStart) {
      const partial = input.slice(0, cursor).trimStart();
      candidates = all.filter((c) => c.name.startsWith(partial));
    } else {
      const tokens = input.slice(0, cursor).split(/\s+/);
      const partial = tokens[tokens.length - 1] || '';
      candidates = all.filter((c) => c.name.startsWith(partial));
    }

    this._currentCompletions = candidates;
    this._currentIndex = 0;
    this._doubleTab = doubleTab && candidates.length > 0;

    return {
      completions: candidates.map((c) => c.name),
      index: 0,
      doubleTab: this._doubleTab,
      prefix,
      suffix,
    };
  }

  /**
   * Cycle to next completion. Returns updated state.
   */
  next() {
    if (this._currentCompletions.length === 0) return null;
    this._currentIndex = (this._currentIndex + 1) % this._currentCompletions.length;
    const item = this._currentCompletions[this._currentIndex];
    const name = typeof item === 'string' ? item : item.full ?? item.name;
    if (typeof name !== 'string') return null;
    const isDir = typeof item === 'object' ? item.isDir : false;
    const completionSuffix = isDir ? path.sep : ' ';

    if (this._atToken) {
      const prefix = this._currentInput.slice(0, this._atToken.startIndex);
      const suffixStr = this._currentInput.slice(this._atToken.endIndex);
      return {
        input: prefix + name + suffixStr,
        cursor: (prefix + name).length,
      };
    }

    let prefix = this._currentInput.slice(0, this._currentCursor);
    let suffix = this._currentInput.slice(this._currentCursor);

    const atStart = this._currentCursor === 0 ||
      (this._currentCursor > 0 && /\s/.test(prefix[prefix.length - 1]));
    if (atStart) {
      prefix = prefix.replace(/\S*$/, '');
    } else {
      const tokens = prefix.split(/\s+/);
      tokens[tokens.length - 1] = '';
      prefix = tokens.join(' ') + (tokens.length > 1 ? ' ' : '');
    }

    const completion = name.endsWith(completionSuffix) ? name : name + completionSuffix;
    const newInput = prefix + completion + suffix;
    const newCursor = (prefix + completion).length;
    return { input: newInput, cursor: newCursor };
  }

  /**
   * Format completion list for display (double-tab). Returns array of strings.
   */
  formatList() {
    if (!this._doubleTab) return null;
    if (this._currentCompletions.length === 0) return null;

    if (this._atToken) {
      // File path completions: show name with directory marker
      const lines = [];
      for (const p of this._currentCompletions) {
        const marker = p.isDir ? `${path.sep}` : '';
        lines.push(p.name + marker);
      }
      return lines;
    }

    const groups = {};
    for (const c of this._currentCompletions) {
      const group = c.group || 'other';
      if (!groups[group]) groups[group] = [];
      groups[group].push(c);
    }

    const lines = [];
    for (const [group, cmds] of Object.entries(groups)) {
      lines.push(`  ${group}:`);
      for (const c of cmds) {
        lines.push(`    ${c.name}  ${c.desc}`);
      }
    }
    return lines;
  }

  reset() {
    this._currentCompletions = [];
    this._currentIndex = 0;
    this._doubleTab = false;
    this._atToken = null;
  }
}

// ── Syntax highlighting ────────────────────────────────────────────────────

/**
 * Apply simple syntax highlighting to a command input.
 * Returns an array of { text, style } segments.
 */
function highlightInput(input) {
  if (!input) return [{ text: '', style: 'reset' }];
  const segments = [];
  const trimmed = input.trimStart();
  const leading = input.length - trimmed.length;
  if (leading > 0) {
    segments.push({ text: input.slice(0, leading), style: 'reset' });
  }

  const rest = trimmed;
  if (rest.startsWith('/')) {
    // Command
    const spaceIdx = rest.indexOf(' ');
    const cmd = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const isKnown = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS].some((c) => c.name === cmd);
    segments.push({ text: cmd, style: isKnown ? 'cyan' : 'red' });
    if (spaceIdx !== -1) {
      segments.push({ text: rest.slice(spaceIdx), style: 'reset' });
    }
  } else if (/^[a-z]+(\(|:)/.test(rest)) {
    // Tool call or conventional commit
    const parenIdx = rest.indexOf('(');
    const colonIdx = rest.indexOf(':');
    const splitIdx = parenIdx !== -1 && (colonIdx === -1 || parenIdx < colonIdx) ? parenIdx : colonIdx;
    if (splitIdx !== -1) {
      const name = rest.slice(0, splitIdx);
      const isKnown = TOOL_COMMANDS.some((c) => c.name === name);
      segments.push({ text: name, style: isKnown ? 'green' : 'red' });
      segments.push({ text: rest.slice(splitIdx), style: 'reset' });
    } else {
      segments.push({ text: rest, style: 'reset' });
    }
  } else {
    segments.push({ text: rest, style: 'reset' });
  }

  return segments;
}

// ── Public readLine function ───────────────────────────────────────────────

/**
 * Read a line from stdin with fish-style editing.
 *
 * Options:
 *   - workspaceRoot (string): root for @-path completion (default: process.cwd())
 *   - historySize (number): max history entries (default: 100)
 *   - suggester (Suggester): optional shared suggester instance
 *
 * Returns the line content (without trailing newline), or '' on Ctrl+C/D.
 */
export function highlight(input) {
  return highlightInput(input)
    .map((segment) => {
      if (!segment.style || segment.style === 'reset') return segment.text;
      const code = style[segment.style] || '';
      return code ? `${code}${segment.text}${style.reset}` : segment.text;
    })
    .join('');
}

export async function readLine(prompt, options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const historySize = options.historySize || 100;
  const suggester = options.suggester || new Suggester();

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // State
    let input = '';
    let cursor = 0;
    const history = suggester._history || [];
    let historyIndex = suggester._historyIndex ?? history.length;
    const completionEngine = new CompletionEngine(workspaceRoot);

    // Render
    function render() {
      // Compute suggestion
      const suggestion = suggester.getSuggestion(input);
      const suggestionStart = input.length;

      // Apply syntax highlighting
      const segments = highlightInput(input);

      // Build display line with highlighting + suggestion
      let display = '';
      for (const seg of segments) {
        const s = style[seg.style] || '';
        display += s + seg.text + style.reset;
      }
      if (suggestion) {
        const columns = Number.isInteger(stdout.columns) && stdout.columns > 0 ? stdout.columns : 0;
        const maxLineWidth = columns > 1 ? columns - 1 : 0;
        const usedWidth = visibleWidth(prompt + stripAnsi(display));
        const suggestionText = maxLineWidth > 0
          ? visiblePrefix(suggestion, maxLineWidth - usedWidth)
          : suggestion;
        if (suggestionText) {
          display += style.dim + suggestionText + style.reset;
        }
      }

      // Calculate visible cursor position after prompt
      const promptWidth = visibleWidth(prompt);
      const beforeCursor = input.slice(0, cursor);
      const cursorOffset = visibleWidth(beforeCursor);

      // Build full line
      const fullLine = prompt + display;

      // Write: move to start, erase line, write new content
      const currentLine = stripAnsi(fullLine);
      const currentWidth = visibleWidth(currentLine);
      stdout.write(`\r${csi}2K\r${fullLine}`);

      // Move cursor to correct position
      const targetCol = promptWidth + cursorOffset;
      if (targetCol < currentWidth) {
        stdout.write(`\r${csi}${currentWidth}G`);
        if (targetCol > 0) {
          stdout.write(`${csi}${targetCol + 1}G`);
        }
      } else if (targetCol > currentWidth) {
        // Pad with spaces if cursor beyond current content
        stdout.write(' '.repeat(targetCol - currentWidth));
      }
    }

    // Cleanup handler
    function cleanup() {
      stdin.setRawMode?.(false);
      stdin.removeListener('keypress', onKeypress);
      stdin.pause();
    }

    // ── Keypress handler ──────────────────────────────────────────────────────
    function onKeypress(str, key) {
      if (!key) key = {};

      // Ctrl+C / Ctrl+D
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        cleanup();
        resolve('');
        return;
      }

      // Enter
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        stdout.write('\n');
        if (input) {
          suggester.pushHistory(input);
        }
        resolve(input);
        return;
      }

      // Tab — completion
      if (key.name === 'tab') {
        (async () => {
          const state = await completionEngine.compute(input, cursor);
          if (!state) return;
          if (state.doubleTab) {
            const lines = completionEngine.formatList();
            if (lines) {
              stdout.write('\n');
              for (const line of lines) {
                stdout.write(line + '\n');
              }
              render();
            }
            return;
          }
          const result = completionEngine.next();
          if (result) {
            input = result.input;
            cursor = result.cursor;
            suggester.reset();
            render();
          }
        })();
        return;
      }

      // Up arrow — history back
      if (key.name === 'up') {
        const entry = suggester.moveHistory(-1);
        if (entry !== null) {
          input = entry;
          cursor = input.length;
          completionEngine.reset();
          render();
        }
        return;
      }

      // Down arrow — history forward
      if (key.name === 'down') {
        const entry = suggester.moveHistory(1);
        if (entry !== null) {
          input = entry;
          cursor = input.length;
          completionEngine.reset();
          render();
        }
        return;
      }

      // Ctrl+F / right arrow — accept one suggestion character
      if ((key.ctrl && key.name === 'f') || key.name === 'right') {
        const ch = suggester.acceptChar();
        if (ch) {
          input = input.slice(0, cursor) + ch + input.slice(cursor);
          cursor += 1;
          render();
        }
        return;
      }

      // Ctrl+E / End — accept full suggestion
      if ((key.ctrl && key.name === 'e') || key.name === 'end') {
        const rest = suggester.acceptAll();
        if (rest) {
          input += rest;
          cursor = input.length;
          render();
        }
        return;
      }

      // Ctrl+A / Home — go to start
      if ((key.ctrl && key.name === 'a') || key.name === 'home') {
        cursor = 0;
        render();
        return;
      }

      // Ctrl+U — delete whole line
      if (key.ctrl && key.name === 'u') {
        input = '';
        cursor = 0;
        suggester.reset();
        completionEngine.reset();
        render();
        return;
      }

      // Ctrl+W — delete word before cursor
      if (key.ctrl && key.name === 'w') {
        if (cursor > 0) {
          const before = input.slice(0, cursor);
          const match = before.match(/(\s*\S*)$/);
          const wordLen = match ? match[1].length : 0;
          input = input.slice(0, cursor - wordLen) + input.slice(cursor);
          cursor -= wordLen;
          render();
        }
        return;
      }

      // Ctrl+K — delete after cursor
      if (key.ctrl && key.name === 'k') {
        input = input.slice(0, cursor);
        render();
        return;
      }

      // Ctrl+L — clear screen and redraw
      if (key.ctrl && key.name === 'l') {
        stdout.write('\x1b[2J\x1b[H');
        render();
        return;
      }

      // Backspace
      if (key.name === 'backspace') {
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor);
          cursor -= 1;
          suggester.reset();
          render();
        }
        return;
      }

      // Delete
      if (key.name === 'delete') {
        if (cursor < input.length) {
          input = input.slice(0, cursor) + input.slice(cursor + 1);
          suggester.reset();
          render();
        }
        return;
      }

      // Printable character
      if (str && str.length === 1 && str.charCodeAt(0) >= 0x20) {
        input = input.slice(0, cursor) + str + input.slice(cursor);
        cursor += 1;
        suggester.reset();
        render();
        return;
      }
    }

    // ── Setup ──────────────────────────────────────────────────────────────────
    try {
      stdin.setRawMode?.(true);
    } catch {
      // Not a TTY, fall back to simple input
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    // Use 'keypress' when available (readline emits it)
    emitKeypressEvents(stdin);
    stdin.on('keypress', onKeypress);

    // Render initial prompt
    render();
  });
}
