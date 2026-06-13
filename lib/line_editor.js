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

export function visiblePrefix(str, maxWidth) {
  let out = '';
  let width = 0;
  for (const ch of str) {
    const nextWidth = visibleWidth(ch);
    if (width + nextWidth > maxWidth) break;
    out += ch;
    width += nextWidth;
  }
  return out;
}

export function promptLine(prompt) {
  const normalized = String(prompt ?? '').replace(/\r\n/g, '\n');
  return normalized.slice(normalized.lastIndexOf('\n') + 1);
}

export function cursorBackToLogicalCursor(trailingText, suggestion) {
  return visibleWidth(trailingText) + visibleWidth(suggestion);
}

export function normalizeInputKey(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Uint8Array) return Buffer.from(input).toString('utf8');
  return '';
}

export function isPrintableInput(input) {
  const text = normalizeInputKey(input);
  if (!text) return false;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || code === 0x1b) return false;
  }
  return true;
}

// ── Common commands for autocompletion ─────────────────────────────────────

const DEFAULT_COMMANDS = [
  { name: '/help', desc: 'Show this help' },
  { name: '/exit', desc: 'Quit' },
  { name: '/quit', desc: 'Quit' },
  { name: '/stats', desc: 'Show session token usage & cache stats' },
  { name: '/ask', desc: 'Enter read-only Q&A mode (no file writes or bash)' },
  { name: '/agent', desc: 'Return to agent mode (can modify files)' },
];

const TOOL_COMMANDS = [
  { name: 'read_file', desc: 'Read a file', group: 'tools' },
  { name: 'write_file', desc: 'Write a file', group: 'tools' },
  { name: 'list_dir', desc: 'List directory', group: 'tools' },
  { name: 'grep', desc: 'Search in files', group: 'tools' },
  { name: 'bash', desc: 'Run a command', group: 'tools' },
];

// ── Suggester (Autosuggestions) ────────────────────────────────────────────

export class Suggester {
  constructor(workspaceRoot = '') {
    this._history = [''];
    this._index = 0;
    this._workspaceRoot = workspaceRoot;
    this._reset();
  }

  _reset() {
    this._suggestionInput = null;
    this._suggestion = null;
    this._suggestionIndex = 0;
    this._prefix = '';
  }

  /**
   * Push a command to history (called on Enter). Resets the history index.
   */
  pushHistory(cmd) {
    if (!cmd) return;
    // Don't push duplicates of the last entry
    if (this._history.length > 1 && this._history[this._history.length - 1] === cmd) return;
    this._history[this._history.length - 1] = cmd;
    this._history.push('');
    this._index = this._history.length - 1;
    this._reset();
  }

  addEntry(cmd) {
    this.pushHistory(cmd);
  }

  setWorkspaceRoot(root) {
    this._workspaceRoot = root;
  }

  suggest(input) {
    if (DEFAULT_COMMANDS.some((command) => command.name === input)) return '';
    const lower = input.toLowerCase();
    for (let i = this._history.length - 1; i >= 0; i -= 1) {
      const entry = this._history[i];
      if (entry.toLowerCase().startsWith(lower) && entry !== input) return entry;
    }
    return '';
  }

  /**
   * Move in history by delta (+1 forward, -1 back). Returns the new entry or null.
   */
  moveHistory(delta) {
    const newIndex = this._index + delta;
    if (newIndex < 0 || newIndex >= this._history.length) return null;
    this._index = newIndex;
    this._reset();
    return this._history[this._index];
  }

  /**
   * Called when input changes to update the autosuggestion.
   */
  update(input, cursor) {
    if (this._suggestionInput === input) return;
    this._suggestionInput = input;
    this._prefix = input.slice(0, cursor);
    this._suggestion = this.suggest(input);
    this._suggestionIndex = this._prefix.length;
    if (this._suggestion && this._suggestionIndex < this._prefix.length) {
      this._suggestionIndex = this._prefix.length;
    }
    if (this._suggestion && this._suggestionIndex > this._suggestion.length) {
      this._suggestion = null;
    }
  }

  /**
   * Reset the suggester when input changes outside of suggestion logic.
   */
  reset() {
    this._reset();
  }

  /**
   * Accept the next character from the suggestion.
   * Returns the character to insert, or null.
   */
  acceptChar() {
    if (!this._suggestion) return null;
    if (this._suggestionIndex >= this._suggestion.length) return null;
    const ch = this._suggestion[this._suggestionIndex];
    this._suggestionIndex += 1;
    return ch;
  }

  /**
   * Accept the entire remaining suggestion.
   * Returns the remaining suffix to append, or null.
   */
  acceptAll() {
    if (!this._suggestion) return null;
    const remaining = this._suggestion.slice(this._suggestionIndex);
    this._suggestionIndex = this._suggestion.length;
    return remaining || null;
  }

  /**
   * Get the current suggestion suffix (for rendering).
   */
  getSuggestion() {
    if (!this._suggestion) return null;
    return this._suggestion.slice(this._suggestionIndex);
  }
}

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

export async function getCompletions(input, cursor, workspaceRoot) {
  const atToken = findAtToken(input, cursor);
  if (atToken && workspaceRoot) {
    const dirPart = path.dirname(atToken.partial);
    const base = path.basename(atToken.partial);
    const dir = path.join(workspaceRoot, dirPart === '.' ? '' : dirPart);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const completions = entries
      .filter((entry) => entry.name.startsWith(base))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => {
        const rel = path.relative(workspaceRoot, path.join(dir, entry.name));
        return rel + (entry.isDirectory() ? path.sep : ' ');
      });
    return {
      start: atToken.startIndex,
      end: completionReplacementEnd(input, atToken.endIndex, completions),
      completions,
    };
  }

  const beforeCursor = input.slice(0, cursor);
  const wordStart = beforeCursor.lastIndexOf(' ') + 1;
  const partial = beforeCursor.slice(wordStart);
  const completions = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS]
    .map((command) => command.name)
    .filter((name) => name.startsWith(partial))
    .map((name) => `${name} `);
  return { start: wordStart, end: cursor, completions };
}

// ── Completion Engine ──────────────────────────────────────────────────────

export class CompletionEngine {
  constructor(workspaceRoot = '') {
    this._list = [];
    this._index = 0;
    this._atToken = null;
    this._doubleTab = false;
    this._workspaceRoot = workspaceRoot;
    this._lastInput = '';
    this._lastCursor = 0;
  }

  setWorkspaceRoot(root) {
    this._workspaceRoot = root;
  }

  reset() {
    this._list = [];
    this._index = 0;
    this._atToken = null;
    this._doubleTab = false;
  }

  /**
   * Compute completions. Returns a state object or null if nothing to complete.
   */
  async compute(input, cursor) {
    const atIndex = input.lastIndexOf('@', cursor);
    if (atIndex !== -1 && (atIndex === 0 || /\s/.test(input[atIndex - 1]))) {
      return this._computeFileCompletions(input, cursor, atIndex);
    }
    return this._computeCommandCompletions(input, cursor);
  }

  async _computeFileCompletions(input, cursor, atIndex) {
    const afterAt = input.slice(atIndex + 1, cursor);
    const partial = afterAt.replace(/.*?([^/\\]*)$/, '$1');
    const dirPart = afterAt.slice(0, afterAt.length - partial.length);

    const searchDir = this._workspaceRoot
      ? path.resolve(this._workspaceRoot, dirPart || '.')
      : path.resolve(dirPart || '.');

    let entries = [];
    try {
      entries = await readdir(searchDir);
    } catch {
      return null;
    }

    const results = [];
    for (const entry of entries) {
      if (partial && !entry.toLowerCase().startsWith(partial.toLowerCase())) continue;
      let isDir = false;
      try {
        const s = await stat(path.join(searchDir, entry));
        isDir = s.isDirectory();
      } catch {
        // ignore
      }
      results.push({
        name: entry,
        isDir,
        full: dirPart + entry,
      });
    }

    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (results.length === 0) return null;

    this._list = results;
    this._index = -1;
    this._atToken = { atIndex, endIndex: cursor };
    this._doubleTab = false;
    this._lastInput = input;
    this._lastCursor = cursor;

    return { list: results, doubleTab: false };
  }

  async _computeCommandCompletions(input, cursor) {
    const before = input.slice(0, cursor);
    const tokens = before.split(/\s+/);
    const current = tokens[tokens.length - 1] || '';

    // Tab at start: complete commands
    const commands = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS];
    const results = commands.filter(c =>
      c.name.startsWith(current) && c.name !== current
    );

    if (results.length === 0) return null;

    this._list = results;
    this._index = -1;
    this._atToken = null;
    this._doubleTab = false;
    this._lastInput = input;
    this._lastCursor = cursor;

    return { list: results, doubleTab: false };
  }

  /**
   * Cycle to the next completion. Returns { input, cursor } or null.
   */
  next() {
    if (this._list.length === 0) return null;
    this._index = (this._index + 1) % this._list.length;
    const completion = this._list[this._index];
    return this._applyCompletion(completion);
  }

  _applyCompletion(completion) {
    if (this._atToken) {
      const at = this._atToken;
      const prefix = this._lastInput.slice(0, at.atIndex + 1);
      const suffix = this._lastInput.slice(at.endIndex);
      const name = completion.full || completion.name;
      const suffixStr = completion.suffix || (completion.isDir ? '' : ' ');
      return {
        input: prefix + name + suffixStr,
        cursor: (prefix + name).length,
      };
    }

    let prefix = this._lastInput.slice(0, this._lastCursor);
    let suffix = this._lastInput.slice(this._lastCursor);

    const atStart = this._lastCursor === 0 ||
      (this._lastCursor > 0 && /\s/.test(prefix[prefix.length - 1]));
    if (atStart) {
      prefix = prefix.replace(/\S*$/, '');
    } else {
      const tokens = prefix.split(/\s+/);
      tokens.pop();
      prefix = tokens.length > 0 ? tokens.join(' ') + ' ' : '';
    }

    const name = completion.full || completion.name;
    const suffixStr = completion.suffix || ' ';

    return {
      input: prefix + name + suffixStr + suffix,
      cursor: (prefix + name + suffixStr).length,
    };
  }

  formatList() {
    if (this._list.length === 0) return null;
    const lines = [];
    const chunkSize = 4;
    const cols = [''];

    if (this._atToken) {
      // File completions
      for (const item of this._list) {
        const display = item.isDir ? item.name + '/' : item.name;
        lines.push(display);
      }
    } else {
      // Command completions
      const cmdName = this._list[0]?.name || '';
      for (const item of this._list) {
        const display = item.desc ? `${item.name}  ${style.dim}${item.desc}${style.reset}` : item.name;
        lines.push(display);
      }
    }
    return lines;
  }
}

// ── Syntax Highlighting ────────────────────────────────────────────────────

const KNOWN_COMMANDS = new Set([
  'read_file', 'write_file', 'list_dir', 'grep', 'bash',
  '/help', '/exit', '/quit', '/stats', '/ask', '/agent',
]);

/**
 * Split `input` into segments with a `style` property for rendering.
 */
export function highlightInput(input) {
  if (!input) return [];
  const segments = [];

  // Check for leading @ (file-path completion indicator)
  if (input.startsWith('@')) {
    segments.push({ text: input, style: 'blue' });
    return segments;
  }

  const spaceIdx = input.indexOf(' ');
  if (spaceIdx === -1) {
    const rest = input;
    if (KNOWN_COMMANDS.has(rest)) {
      segments.push({ text: rest, style: 'green' });
    } else if (rest.startsWith('/')) {
      segments.push({ text: rest, style: 'red' });
    } else {
      const match = rest.match(/^([a-z]+:)/);
      if (match) {
        segments.push({ text: match[1], style: 'magenta' });
        const after = rest.slice(match[1].length);
        if (after) segments.push({ text: after, style: 'reset' });
      } else {
        segments.push({ text: rest, style: 'reset' });
      }
    }
    return segments;
  }

  // First token (command)
  const first = input.slice(0, spaceIdx);
  if (KNOWN_COMMANDS.has(first)) {
    segments.push({ text: first, style: 'green' });
  } else if (first.startsWith('/')) {
    segments.push({ text: first, style: 'red' });
  } else if (first.startsWith('@')) {
    segments.push({ text: first, style: 'blue' });
  } else {
    const match = first.match(/^([a-z]+:)/);
    if (match) {
      segments.push({ text: match[1], style: 'magenta' });
      const after = first.slice(match[1].length);
      if (after) segments.push({ text: after, style: 'reset' });
    } else {
      segments.push({ text: first, style: 'reset' });
    }
  }

  segments.push({ text: ' ', style: 'reset' });

  // Rest of input
  let rest = input.slice(spaceIdx + 1);
  if (!rest) return segments;

  if (rest.startsWith('@')) {
    // @ file path completion — highlight in blue
    const atEnd = rest.indexOf(' ', 1);
    if (atEnd === -1) {
      segments.push({ text: rest, style: 'blue' });
    } else {
      segments.push({ text: rest.slice(0, atEnd), style: 'blue' });
      segments.push({ text: rest.slice(atEnd), style: 'reset' });
    }
    return segments;
  }

  // Check for conventional commit prefix (e.g., "add:" / "fix:")
  const match = rest.match(/^([a-z]+:)/);
  if (match) {
    segments.push({ text: match[1], style: 'magenta' });
    const after = rest.slice(match[1].length);
    if (after) segments.push({ text: after, style: 'reset' });
  } else {
    segments.push({ text: rest, style: 'reset' });
  }

  return segments;
}

export function highlight(input) {
  return highlightInput(input).map((segment) => segment.text).join('');
}

// ── readLine — the main line-editing loop ──────────────────────────────────

/**
 * Read one line of input with fish-style autosuggestions,
 * Tab completion, history, and Emacs keybindings.
 *
 * @param {string} prompt  The prompt string (e.g. "> " or "ask> ")
 * @param {object} [opts]
 * @param {string} [opts.workspaceRoot]
 * @param {Suggester} [opts.suggester]  Shared suggester instance
 * @returns {Promise<string>}  The line entered (empty string on Ctrl+C/D)
 */
export async function readLine(prompt, opts = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const completionEngine = new CompletionEngine();
  completionEngine.setWorkspaceRoot(opts.workspaceRoot || '');

  const suggester = opts.suggester || new Suggester();

  let input = '';
  let cursor = 0;

  return new Promise((resolve) => {
    // ── Render ──────────────────────────────────────────────────────────────
    function render() {
      // Build the rendered line from input segments with syntax highlighting
      const segments = highlightInput(input);

      suggester.update(input, cursor);
      // Get suggestion
      const suggestion = suggester.getSuggestion();

      // ANSI colored prompt
      let rendered = `${prompt}`;

      // Syntax-highlighted input
      for (const seg of segments) {
        const s = style[seg.style] || style.reset;
        rendered += `${s}${seg.text}${style.reset}`;
      }

      // Dim grey suggestion
      if (suggestion) {
        rendered += `${style.dim}${suggestion}${style.reset}`;
      }

      const promptWidth = visibleWidth(prompt);
      const inputWidth = visibleWidth(input);
      const totalWidth = visibleWidth(rendered);

      // Determine cursor column
      const beforeCursor = input.slice(0, cursor);
      const cursorCol = promptWidth + visibleWidth(beforeCursor);

      // Clear and reprint
      stdout.write('\r' + eraseInLine(2));
      stdout.write(rendered);

      // Position cursor
      const currentWidth = totalWidth;
      if (cursorCol <= currentWidth) {
        stdout.write(`\r${csi}${cursorCol + 1}G`);
      } else if (cursorCol > currentWidth) {
        stdout.write(' '.repeat(cursorCol - currentWidth));
      }
    }

    // ── Paste detection state ───────────────────────────────────────────────
    let pasteTimer = null;
    let pasteBuffer = '';

    // Cleanup handler
    function cleanup() {
      if (pasteTimer) {
        clearTimeout(pasteTimer);
        pasteTimer = null;
      }
      stdin.setRawMode?.(false);
      stdin.removeListener('keypress', onKeypress);
      stdin.pause();
    }

    /**
     * Commit the current input as a single-line command.
     */
    function commitLine() {
      cleanup();
      stdout.write('\n');
      if (input) {
        suggester.pushHistory(input);
      }
      resolve(input);
    }

    /**
     * Commit text accumulated during paste.
     */
    function commitPaste(text) {
      pasteBuffer = '';
      if (pasteTimer) {
        clearTimeout(pasteTimer);
        pasteTimer = null;
      }
      if (input) {
        suggester.pushHistory(input);
      }
      if (text) {
        suggester.pushHistory(text);
      }
      input = text;
      cleanup();
      stdout.write('\n');
      resolve(text);
    }

    /**
     * Start or extend the paste debounce timer.
     */
    function extendPasteTimer() {
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        if (pasteBuffer.includes('\n')) {
          commitPaste(pasteBuffer);
        } else {
          commitLine();
        }
      }, 30);
    }

    /**
     * Called when a character arrives during paste accumulation.
     */
    function onPasteChar(ch) {
      pasteBuffer += ch;
      extendPasteTimer();
    }

    // ── Keypress handler ──────────────────────────────────────────────────────
    function onKeypress(str, key) {
      if (!key) key = {};

      // Ctrl+C / Ctrl+D
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        // If in paste mode, cancel paste and resolve
        if (pasteTimer) {
          clearTimeout(pasteTimer);
          pasteTimer = null;
          const text = pasteBuffer;
          pasteBuffer = '';
          if (text) {
            commitPaste(text);
          } else {
            commitLine();
          }
          return;
        }
        cleanup();
        resolve('');
        return;
      }

      // ── Paste mode handling ────────────────────────────────────────────────
      if (pasteTimer) {
        if (key.name === 'return' || key.name === 'enter') {
          // If another Enter arrives during paste debounce window, this is likely
          // a terminal sending \r\n as two separate keypress events.
          // Commit immediately instead of treating it as a paste newline.
          clearTimeout(pasteTimer);
          pasteTimer = null;
          commitLine();
          return;
        }
        if (key.name === 'escape') {
          return;
        }
        if (key.name === 'backspace') {
          return;
        }
        if (str && str.length === 1) {
          onPasteChar(str);
          return;
        }
        return;
      }

      // Enter — commit line normally, or start paste detection
      if (key.name === 'return' || key.name === 'enter') {
        pasteBuffer = input;
        extendPasteTimer();
        stdout.write('\n');
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

      // Left arrow — move cursor left
      if (key.name === 'left') {
        if (cursor > 0) {
          cursor -= 1;
          render();
        }
        return;
      }

      // Right arrow / Ctrl+F — accept suggestion character or move cursor right
      if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
        // If there's a suggestion, accept one character
        const ch = suggester.acceptChar();
        if (ch) {
          input = input.slice(0, cursor) + ch + input.slice(cursor);
          cursor += 1;
          render();
          return;
        }
        // Otherwise, move cursor right
        if (cursor < input.length) {
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
