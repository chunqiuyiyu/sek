import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Agent,
  SYSTEM_PROMPT,
  formatTurnStats,
  formatToolUsageStats,
  emptyUsage,
  accumulateUsage,
  shouldContinueForPromisedToolUse,
} from '../lib/agent.js';

test('Agent starts conversations with sek system prompt', () => {
  const agent = new Agent({}, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxStepsPerTurn: 40,
    verbose: false,
  });

  assert.deepEqual(agent.messages[0], {
    role: 'system',
    content: SYSTEM_PROMPT,
  });
  assert.match(SYSTEM_PROMPT, /You are sek/);
  assert.match(SYSTEM_PROMPT, /Do not claim to be Claude/);
  assert.doesNotMatch(SYSTEM_PROMPT, /can do anything/);
  assert.match(SYSTEM_PROMPT, /use the available tools/);
  assert.match(SYSTEM_PROMPT, /Root cause:/);
  assert.match(SYSTEM_PROMPT, /Files:/);
  assert.match(SYSTEM_PROMPT, /Plan:/);
  assert.match(SYSTEM_PROMPT, /Verification:/);
  assert.match(SYSTEM_PROMPT, /If the root cause is not established, do not edit files/);
});

test('shouldContinueForPromisedToolUse detects scan promises without tools', () => {
  assert.equal(shouldContinueForPromisedToolUse('让我先扫描一下项目。'), true);
  assert.equal(shouldContinueForPromisedToolUse('I will inspect the repository first.'), true);
  assert.equal(shouldContinueForPromisedToolUse('可以，通过 readline 实现。'), false);
});

test('Agent continues when assistant promises tool use without calling tools', async () => {
  const calls = [];
  const client = {
    async query(messages) {
      calls.push(messages.map((message) => ({ role: message.role, content: message.content })));
      if (calls.length === 1) {
        return {
          content: '有的。让我先扫描一下项目。',
          tool_calls: [],
          usage: emptyUsage(),
        };
      }
      return {
        content: '扫描后可以通过 line_editor 的 suggest 逻辑实现。',
        tool_calls: [],
        usage: emptyUsage(),
      };
    },
  };
  const agent = new Agent(client, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxStepsPerTurn: 4,
    verbose: false,
  });

  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await agent.handleUserMessage('有办法实现对用户输入智能感知并提示吗？', false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1).role, 'user');
  assert.match(calls[1].at(-1).content, /appropriate tool calls/);
});

test('Agent returns malformed tool arguments as tool result instead of throwing', async () => {
  const calls = [];
  const client = {
    async query(messages) {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          content: null,
          tool_calls: [{
            id: 'call_bad_json',
            name: 'bash',
            arguments: '{"command":"unterminated',
          }],
          usage: emptyUsage(),
        };
      }
      return {
        content: 'Recovered after bad tool JSON.',
        tool_calls: [],
        usage: emptyUsage(),
      };
    },
  };
  const agent = new Agent(client, { root: 'C:\\repo', bashNeedsApproval: () => false }, {
    maxOutput: 8192,
    maxStepsPerTurn: 4,
    verbose: false,
  });

  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await agent.handleUserMessage('run malformed tool', false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  const toolMessage = agent.messages.find((message) => message.role === 'tool');
  assert.equal(calls.length, 2);
  assert.equal(toolMessage.tool_call_id, 'call_bad_json');
  assert.match(toolMessage.content, /Invalid tool arguments JSON/);
});

test('Agent reports max step limit and can continue the same turn', async () => {
  const calls = [];
  const client = {
    async query(messages) {
      calls.push(messages.map((message) => ({ role: message.role, content: message.content })));
      if (calls.length <= 2) {
        return {
          content: 'phase 1: I will continue.',
          tool_calls: [],
          usage: emptyUsage(),
        };
      }
      return {
        content: 'finished',
        tool_calls: [],
        usage: emptyUsage(),
      };
    },
  };
  const agent = new Agent(client, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxStepsPerTurn: 2,
    verbose: false,
  });

  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  let first;
  let second;
  try {
    first = await agent.handleUserMessage('large task', false);
    second = await agent.continueTurn(false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  assert.equal(first.reachedMaxSteps, true);
  assert.equal(first.steps, 2);
  assert.equal(second.reachedMaxSteps, false);
  assert.equal(agent.messages.filter((message) => message.role === 'user' && message.content === 'large task').length, 1);
  assert.equal(calls.length, 3);
});

test('Agent compacts large tool output before storing it in history', () => {
  const agent = new Agent({}, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxToolHistoryBytes: 600,
    maxStepsPerTurn: 40,
    verbose: false,
  });
  const out = agent.truncateToolHistory('a'.repeat(2000), {
    name: 'bash',
    arguments: JSON.stringify({ command: 'rg -n "needle" .' }),
  });

  assert.match(out, /tool output compacted for history: bash/);
  assert.match(out, /middle omitted/);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 650);
});

test('Agent compacts old messages into a session summary', () => {
  const agent = new Agent({}, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxToolHistoryBytes: 4096,
    maxHistoryMessages: 10,
    maxStepsPerTurn: 40,
    verbose: false,
  });

  for (let i = 0; i < 16; i += 1) {
    agent.messages.push({ role: 'user', content: `old request ${i}` });
  }
  agent.messages.push({ role: 'user', content: 'current request' });
  agent.compactHistory();

  assert.equal(agent.messages[0].role, 'system');
  assert.equal(agent.messages[1].role, 'system');
  assert.match(agent.messages[1].content, /\[sek session summary\]/);
  assert.match(agent.messages[1].content, /earlier message/);
  assert.equal(agent.messages.at(-1).content, 'current request');
});

test('Agent compactHistory does not leave orphan tool messages', () => {
  const agent = new Agent({}, { root: 'C:\\repo' }, {
    maxOutput: 8192,
    maxToolHistoryBytes: 4096,
    maxHistoryMessages: 5,
    maxStepsPerTurn: 40,
    verbose: false,
  });

  agent.messages.push({ role: 'user', content: 'old request' });
  agent.messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' },
      { id: 'call_3', name: 'read_file', arguments: '{"path":"c"}' },
    ],
  });
  agent.messages.push({ role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'a' });
  agent.messages.push({ role: 'tool', tool_call_id: 'call_2', name: 'read_file', content: 'b' });
  agent.messages.push({ role: 'tool', tool_call_id: 'call_3', name: 'read_file', content: 'c' });
  agent.messages.push({ role: 'assistant', content: 'done' });
  agent.messages.push({ role: 'user', content: 'current request' });

  agent.compactHistory();

  for (let i = 0; i < agent.messages.length; i += 1) {
    const message = agent.messages[i];
    if (message.role !== 'tool') continue;

    const previous = agent.messages[i - 1];
    assert.equal(previous?.role, 'assistant');
    assert.ok(previous.tool_calls?.some((call) => call.id === message.tool_call_id));
  }
  assert.equal(agent.messages.at(-1).content, 'current request');
});

test('formatTurnStats renders compact one-line metadata', () => {
  const out = formatTurnStats({
    prompt_tokens: 12,
    prompt_cache_hit_tokens: 8,
    prompt_cache_miss_tokens: 2,
    completion_tokens: 4,
  }, 3);

  assert.ok(out.startsWith('\x1b[2m\x1b[90m'));
  assert.ok(out.endsWith('\x1b[0m'));
  assert.match(out, /steps 3/);
  assert.match(out, /tokens 16/);
  assert.match(out, /cache hit 80\.0%/);
  assert.doesNotMatch(out, /\n/);
  assert.doesNotMatch(out, /cache_miss/);
});

test('formatToolUsageStats shows per-tool breakdown', () => {
  const toolUsage = {
    read_file: {
      prompt_tokens: 400,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 100,
      total_tokens: 450,
    },
    bash: {
      prompt_tokens: 200,
      completion_tokens: 30,
      prompt_cache_hit_tokens: 150,
      prompt_cache_miss_tokens: 50,
      total_tokens: 230,
    },
  };

  const out = formatToolUsageStats(toolUsage);

  assert.match(out, /bash/);
  assert.match(out, /read_file/);
  assert.match(out, /prompt\s+400/);
  assert.match(out, /completion\s+50/);
  assert.match(out, /cache_hit\s+300 \(75\.0%\)/);
  assert.match(out, /prompt\s+200/);
});

test('formatToolUsageStats returns placeholder for empty data', () => {
  const out = formatToolUsageStats({});
  assert.match(out, /no tool usage recorded/);
});

test('accumulateUsage adds values correctly', () => {
  const total = emptyUsage();
  accumulateUsage(total, {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40,
    total_tokens: 120,
  });
  assert.equal(total.prompt_tokens, 100);
  assert.equal(total.completion_tokens, 20);
  assert.equal(total.total_tokens, 120);

  accumulateUsage(total, {
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
  });
  assert.equal(total.prompt_tokens, 150);
  assert.equal(total.completion_tokens, 30);
  assert.equal(total.total_tokens, 180);
});
