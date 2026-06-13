import { tools } from './tools.js';

const defaultBaseUrl = 'https://api.deepseek.com/chat/completions';

export class Client {
  constructor({ apiKey, baseUrl = defaultBaseUrl, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error('apiKey is required');
    if (!fetchImpl) throw new Error('fetch is not available in this Node.js runtime');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async query(messages, _options = {}) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.doQuery(messages);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableQueryError(error)) throw error;
        console.error(`(network error, retry ${attempt}/${maxAttempts})...`);
      }
    }
    throw new Error('unreachable');
  }

  async doQuery(messages) {
    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: buildRequestBody(messages),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek API ${response.status}: ${body.slice(0, 8192)}`);
    }

    return parseResponse(body);
  }
}

export function buildRequestBody(messages) {
  return JSON.stringify({
    model: 'deepseek-v4-flash',
    stream: false,
    thinking: { type: 'disabled' },
    tool_choice: 'auto',
    tools,
    messages: messages.map(writeMessage),
  });
}

function writeMessage(message) {
  const out = {
    role: message.role,
  };
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls?.length > 0) {
    out.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
    out.content = message.content ?? null;
  } else if (message.content !== undefined) {
    out.content = message.content;
  }
  return out;
}

export function parseResponse(body) {
  const parsed = JSON.parse(body);
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error('EmptyResponse');

  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function?.name,
    arguments: call.function?.arguments ?? '{}',
  }));
  const content = message.content ?? null;
  if (content == null && toolCalls.length === 0) throw new Error('EmptyResponse');

  const usage = parsed.usage ?? {};
  return {
    content,
    tool_calls: toolCalls,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

function isRetryableQueryError(error) {
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(error?.code);
}
