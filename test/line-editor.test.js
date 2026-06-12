import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import {
  completionReplacementEnd,
  CompletionEngine,
  cursorBackToLogicalCursor,
  findAtToken,
  getCompletions,
  highlight,
  isPrintableInput,
  normalizeInputKey,
  promptLine,
  Suggester,
  visiblePrefix,
  visibleWidth,
} from '../lib/line_editor.js';

test('promptLine returns only the current physical prompt line', () => {
  assert.equal(promptLine('\n> '), '> ');
  assert.equal(promptLine('\r\nask> '), 'ask> ');
  assert.equal(promptLine('sek> '), 'sek> ');
});

test('cursorBackToLogicalCursor keeps cursor at end when there is no trailing text', () => {
  assert.equal(cursorBackToLogicalCursor('', ''), 0);
});

test('cursorBackToLogicalCursor moves back over text after the cursor', () => {
  assert.equal(cursorBackToLogicalCursor('cd', ''), 2);
});

test('cursorBackToLogicalCursor moves back over autosuggestion text', () => {
  assert.equal(cursorBackToLogicalCursor('', 'elp'), 3);
  assert.equal(cursorBackToLogicalCursor('x', 'elp'), 4);
});

test('visibleWidth ignores ANSI control sequences', () => {
  assert.equal(visibleWidth('\x1b[31mred\x1b[0m'), 3);
});

test('visiblePrefix clips text without exceeding display width', () => {
  assert.equal(visiblePrefix('abcdef', 3), 'abc');
  assert.equal(visiblePrefix('中文abc', 4), '中文');
  assert.equal(visiblePrefix('中文abc', 5), '中文a');
  assert.equal(visiblePrefix('abc', 0), '');
});

test('highlight keeps unknown plain text visible', () => {
  assert.equal(highlight('hello'), 'hello');
  assert.equal(highlight('hello world'), 'hello world');
});

test('normalizeInputKey converts data chunks to strings', () => {
  assert.equal(normalizeInputKey('a'), 'a');
  assert.equal(normalizeInputKey(Buffer.from('a')), 'a');
  assert.equal(normalizeInputKey(Buffer.from('中文')), '中文');
  assert.equal(normalizeInputKey(new Uint8Array(Buffer.from('\x1b[C'))), '\x1b[C');
  assert.equal(normalizeInputKey({}), '');
});

test('isPrintableInput accepts Unicode IME chunks and rejects controls', () => {
  assert.equal(isPrintableInput('a'), true);
  assert.equal(isPrintableInput('中文'), true);
  assert.equal(isPrintableInput('你好 world'), true);
  assert.equal(isPrintableInput('\x1b[C'), false);
  assert.equal(isPrintableInput('\r'), false);
  assert.equal(isPrintableInput('\x7f'), false);
});

test('completionReplacementEnd consumes an existing separator space', () => {
  assert.equal(completionReplacementEnd('read @src/file next', 'read @src/file'.length, ['src/file ']), 'read @src/file '.length);
  assert.equal(completionReplacementEnd('read @src/file,next', 'read @src/file'.length, ['src/file ']), 'read @src/file'.length);
});

test('CompletionEngine completes command objects without requiring full path field', async () => {
  const engine = new CompletionEngine(process.cwd());

  await engine.compute('/he', '/he'.length);
  const result = engine.next();

  assert.deepEqual(result, {
    input: '/help ',
    cursor: '/help '.length,
  });
});

test('Suggester does not extend exact built-in commands', () => {
  const suggester = new Suggester();
  suggester.addEntry('/exit after this task');

  assert.equal(suggester.suggest('/exit'), '');
  assert.equal(suggester.suggest('/ex'), '/exit after this task');
});

test('Suggester setWorkspaceRoot stores the root', () => {
  const suggester = new Suggester();
  suggester.setWorkspaceRoot('/tmp');
  assert.equal(suggester._workspaceRoot, '/tmp');
});

test('findAtToken identifies active @ path token bounds', () => {
  const input = 'read @src/index.js now';
  const token = findAtToken(input, 'read @src/in'.length);

  assert.deepEqual(token, {
    atIndex: 5,
    startIndex: 6,
    endIndex: 18,
    partial: 'src/in',
  });
  assert.equal(findAtToken('read @src/file more', 'read @src/file more'.length), null);
});

test('getCompletions replaces the whole @ path token when cursor is in the middle', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sek-test-'));
  try {
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'index.js'), '// test');

    const input = 'read @src/inx.js please';
    const cursor = 'read @src/in'.length;
    const completions = await getCompletions(input, cursor, tmpDir);
    const completed =
      input.slice(0, completions.start) +
      completions.completions[0] +
      input.slice(completions.end);

    assert.equal(completions.start, 'read @'.length);
    assert.equal(completions.end, 'read @src/inx.js '.length);
    assert.deepEqual(completions.completions, [`src${path.sep}index.js `]);
    assert.equal(completed, `read @src${path.sep}index.js please`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
