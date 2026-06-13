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
  constructor() {
    this._history = [''];
    this._index = 0;
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
    if (cursor !== input.length) {
      // Only suggest when cursor is at end
      this._suggestion = null;
      return;
    }
    const trimmed = input.trimStart();
    if (!trimmed) { this._suggestion = null; return; }

    // Check conventional commit prefixes
    const ccPrefixes = ['add', 'fix', 'update', 'remove', 'refactor', 'docs', 'chore', 'feat'];
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1 && parts[0].includes(':')) {
      const prefix = parts[0].split(':')[0];
      if (ccPrefixes.some((p) => p.startsWith(prefix))) {
        for (const p of ccPrefixes) {
          if (p.startsWith(prefix) && p !== prefix) {
            this._suggestionInput = input;
            this._suggestion = p.slice(prefix.length) + ': ';
            this._prefix = prefix;
            this._suggestionIndex = 0;
            return;
          }
        }
      }
    }

    // Check history-based suggestion
    const lower = input.toLowerCase();
    const isPrefix = (entry) => entry.toLowerCase().startsWith(lower) && entry !== input;
    for (let i = this._history.length - 1; i >= 0; i--) {
      if (isPrefix(this._history[i])) {
        this._suggestionInput = input;
        this._suggestion = this._history[i].slice(input.length);
        this._prefix = input;
        this._suggestionIndex = 0;
        return;
      }
    }
    this._suggestion = null;
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

// ── @-completion helpers ───────────────────────────────────────────────────

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
    .filter((name) => name.startsWith(partial));
  return { start: wordStart, end: wordEnd, completions: completions.map((c) => `${c} `) };
}

// ── Completion Engine ──────────────────────────────────────────────────────

export class CompletionEngine {
  constructor() {
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
      const entries = await getPathCompletions(this._workspaceRoot, atToken);
      this._currentCompletions = entries;
      this._currentIndex = 0;
      this._doubleTab = doubleTab;
      return { doubleTab, completions: entries };
    }
    this._atToken = null;

    const beforeCursor = input.slice(0, cursor);
    const afterCursor = input.slice(cursor);
    const wordStart = beforeCursor.lastIndexOf(' ') + 1;
    const wordEnd = afterCursor.indexOf(' ') === -1 ? input.length : cursor + afterCursor.indexOf(' ');
    const partial = input.slice(wordStart, wordEnd);
    const completions = [...DEFAULT_COMMANDS, ...TOOL_COMMANDS]
      .map((cmd) => cmd)
      .filter((cmd) => cmd.name.startsWith(partial));
    this._currentCompletions = completions;
    this._currentIndex = 0;
    this._doubleTab = doubleTab;
    return { doubleTab, completions };
  }

  setWorkspaceRoot(root) {
    this._workspaceRoot = root;
  }

  /**
   * Get the next completion in rotation.
   * Returns { input, cursor } or null.
   */
  next() {
    if (this._currentCompletions.length === 0) return null;
    if (this._currentIndex >= this._currentCompletions.length) {
      this._currentIndex = 0;
    }

    const completion = this._currentCompletions[this._currentIndex];
    this._currentIndex += 1;

    // @-path completion
    if (this._atToken) {
      const at = this._atToken;
      const prefix = this._currentInput.slice(0, at.atIndex + 1);
      const suffix = this._currentInput.slice(at.endIndex);
      const name = completion.full || completion.name;
      const suffixStr = completion.suffix || (completion.isDir ? '' : ' ');
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

    const name = completion.name;
    const completionSuffix = ' ';
    const newInput = prefix + name + completionSuffix + suffix;
    const newCursor = (prefix + name + completionSuffix).length;
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
    if (spaceIdx === -1) {
      segments.push({ text: cmd, style: isKnown ? 'cyan' : 'red' });
    } else {
      segments.push({ text: cmd, style: isKnown ? 'cyan' : 'red' });
      segments.push({ text: rest.slice(spaceIdx), style: 'reset' });
    }
  } else if (rest.startsWith('@')) {
    segments.push({ text: rest, style: 'blue' });
  } else {
    // Check for conventional commit prefix (e.g., "add:" / "fix:")
    const match = rest.match(/^([a-z]+:)/);
    if (match) {
      segments.push({ text: match[1], style: 'green' });
      segments.push({ text: rest.slice(match[1].length), style: 'reset' });
    } else {
      segments.push({ text: rest, style: 'reset' });
    }
  }
  return segments;
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

      // Left arrow / Ctrl+B — move cursor left
      if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
        if (cursor > 0) {
          cursor -= 1;
          render();
        }
        return;
      }

      // Right arrow / Ctrl+F — accept one suggestion character, or move cursor right
      if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
        // If there's an active suggestion and cursor is at end, accept one char
        if (cursor === input.length) {
          const ch = suggester.acceptChar();
          if (ch) {
            input = input.slice(0, cursor) + ch + input.slice(cursor);
            cursor += 1;
            render();
            return;
          }
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
