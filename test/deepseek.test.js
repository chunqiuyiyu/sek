import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody, parseResponse } from '../lib/deepseek.js';

test('buildRequestBody includes tools when needsTools is true', () => {
  const body = buildRequestBody([{ role: 'system', content: 'test' }], true);
  assert.match(body, /"read_file"/);
  assert.match(body, /"disabled"/);
});

test('buildRequestBody always includes tools (needsTools is a no-op)', () => {
  const body = buildRequestBody([{ role: 'system', content: 'test' }], false);
  assert.match(body, /"read_file"/);
  assert.match(body, /"tools"/);
});

test('buildRequestBody tool call arguments are a JSON string', () => {
  const body = buildRequestBody([
    { role: 'system', content: 'test' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/main.zig"}' }],
    },
  ], true);
  assert.match(body, /"arguments":"\{\\\"path\\\":\\\"src\/main\.zig\\\"\}"/);
  assert.doesNotMatch(body, /"arguments":\{"path"/);
});

test('parseResponse extracts content, tool calls, and usage', () => {
  const result = parseResponse(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'list_dir', arguments: '{"path":"."}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );

  assert.equal(result.tool_calls[0].name, 'list_dir');
  assert.equal(result.usage.total_tokens, 3);
});
