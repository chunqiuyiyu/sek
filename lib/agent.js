import process from 'node:process';
import path from 'node:path';
import { formatDuration, formatTokens } from './timer.js';
import { dispatch, approvalFor, approvalPrompt, isReadOnlyTool } from './tools.js';
import { printBeautified } from './format.js';
import { confirm } from './approve.js';
import { Workspace } from './workspace.js';

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
};

const ansi = {
  step: '\x1b[38;5;75m',
  toolName: '\x1b[38;5;78m',   // greenish teal
  toolArg: '\x1b[38;5;215m',   // warm yellow
  reset: color.reset,
  bold: color.bold,
  statsDim: '\x1b[2m\x1b[90m',
};

export const SYSTEM_PROMPT = [
  'You are sek, a coding agent CLI powered by DeepSeek V4 Flash.',
  "You help with coding tasks in the user's local workspace.",
  'When repository context is needed, use the available tools before giving the final answer.',
  'Do not say you will inspect files, scan the project, or run a search unless you make the corresponding tool call in the same response.',
  'If asked who you are, say you are sek.',
  'Do not claim to be Claude, Anthropic, ChatGPT, or OpenAI.',
].join('\n');

const SUMMARY_MARKER = '[sek session summary]';

export class Agent {
  static async create(client, config = {}) {
    const workdir = path.resolve(config.workdir || process.cwd());
    const workspace = await Workspace.open(workdir);
    return new Agent(client, workspace, {
      maxOutput: config.maxOutput ?? 8192,
      maxToolHistoryBytes: config.maxToolHistoryBytes ?? 4096,
      maxHistoryMessages: config.maxHistoryMessages ?? 40,
      maxStepsPerTurn: config.maxStepsPerTurn ?? 40,
      verbose: config.verbose ?? false,
    });
  }

  constructor(client, workspace, config = {}) {
    this.client = client;
    this.workspace = workspace;
    this.config = config;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.stats = {
      steps: 0,
      toolTime: 0,
      usage: emptyUsage(),
      toolUsage: {},
    };
    // Provide shell config for the bash tool (execute function)
    this.shell = {
      cwd: workspace.root,
      maxObservationBytes: config.maxObservationBytes ?? 8192,
    };
  }

  workspaceRoot() {
    return this.workspace.root;
  }

  async handleUserMessage(input, askMode) {
    this.messages.push({ role: 'user', content: input });
    this.compactHistory();
    const startUsage = { ...this.stats.usage };
    const startToolTime = this.stats.toolTime;

    let turnStep = 0;
    let completedSteps = 0;
    for (; turnStep < this.config.maxStepsPerTurn; turnStep += 1) {
      this.stats.steps += 1;
      const stepNum = turnStep + 1;
      completedSteps = stepNum;
      const result = await this.client.query(this.messages);

      accumulateUsage(this.stats.usage, result.usage);

      if (result.tool_calls.length === 0) {
        if (shouldContinueForPromisedToolUse(result.content)) {
          this.messages.push({ role: 'assistant', content: result.content });
          this.messages.push({
            role: 'user',
            content: 'Proceed now by using the appropriate tool calls, then provide the answer.',
          });
          continue;
        }

        const thinkMs = this.stats.toolTime - startToolTime;
        if (this.config.verbose) {
          console.error(
            `${ansi.step}->${ansi.reset} ${ansi.bold}step ${stepNum}${ansi.reset}: ${formatDuration(thinkMs)} \u00b7 ` +
            `prompt=${formatTokens(result.usage.prompt_tokens)} completion=${formatTokens(result.usage.completion_tokens)}`
          );
        } else {
          const stepTokens = result.usage.prompt_tokens + result.usage.completion_tokens;
          console.error(`${ansi.step}->${ansi.reset} ${ansi.bold}step ${stepNum}${ansi.reset} ${formatDuration(thinkMs)} \u00b7 ${formatTokens(stepTokens)} tokens`);
        }

        printBeautified(result.content);
        this.messages.push({ role: 'assistant', content: result.content });
        break;
      }

      const thinkMs = this.stats.toolTime - startToolTime;
      const toolNames = result.tool_calls.map((c) => c.name).join(', ');
      if (this.config.verbose) {
        console.error(
          `${ansi.step}->${ansi.reset} ${ansi.bold}step ${stepNum}${ansi.reset}: ${formatDuration(thinkMs)} \u00b7 ` +
          `${result.tool_calls.length} tool call(s): ${ansi.toolName}${toolNames}${ansi.reset} \u00b7 ` +
          `prompt=${formatTokens(result.usage.prompt_tokens)} completion=${formatTokens(result.usage.completion_tokens)}`
        );
      } else {
        const stepTokens = result.usage.prompt_tokens + result.usage.completion_tokens;
        console.error(
          `${ansi.step}->${ansi.reset} ${ansi.bold}step ${stepNum}${ansi.reset} ${formatDuration(thinkMs)} \u00b7 ${formatTokens(stepTokens)} tokens \u00b7 ` +
          `${ansi.toolName}${toolNames}${ansi.reset}`
        );
      }

      this.messages.push({ role: 'assistant', content: result.content, tool_calls: result.tool_calls });

      for (const call of result.tool_calls) {
        const toolMs = await this.runTool(call, askMode);
        this.stats.toolTime += toolMs;
        if (!this.stats.toolUsage[call.name]) {
          this.stats.toolUsage[call.name] = emptyUsage();
        }
        const perToolUsage = { ...result.usage };
        accumulateUsage(this.stats.toolUsage[call.name], perToolUsage);
      }
    }

    const turnSteps = completedSteps;
    this.printTurnStats(startUsage, turnSteps);
  }

  async runTool(call, askMode) {
    const start = Date.now();
    const isReadOnly = isReadOnlyTool(call.name);
    if (askMode && !isReadOnly) {
      const result = `Blocked: tool '${call.name}' is not allowed in read-only ask mode.`;
      this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
      return 0;
    }

    let result;
    try {
      const approval = await approvalFor(this, call.name, call.arguments);
      if (approval === 'on_request') {
        const prompt = approvalPrompt(call.name, call.arguments);
        const ok = await confirm(prompt);
        if (!ok) {
          this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'User denied this action.' });
          return Date.now() - start;
        }
      }

      // Print tool call invocation (both verbose and non-verbose)
      const argSummary = summarizeArgs(call.name, parseJsonObject(call.arguments));
      console.error(
        `  ${ansi.toolName}\u2514 ${call.name}${ansi.reset} ${ansi.toolArg}${argSummary}${ansi.reset}`
      );

      result = await dispatch(this, call.name, call.arguments);
    } catch (error) {
      result = `Error: ${error?.message || error}`;
    }
    const elapsed = Date.now() - start;

    result = String(result);
    result = this.truncateOutput(result);
    const historyResult = this.truncateToolHistory(result, call);

    this.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: historyResult });
    return elapsed;
  }

  truncateOutput(outputStr) {
    if (outputStr.length <= this.config.maxOutput) return outputStr;
    const front = this.config.maxOutput - 500;
    const back = 300;
    return outputStr.slice(0, front) + '\n\n...[truncated]...\n\n' + outputStr.slice(-back);
  }

  truncateToolHistory(outputStr, call) {
    const maxBytes = this.config.maxToolHistoryBytes ?? this.config.maxOutput;
    if (Buffer.byteLength(outputStr, 'utf8') <= maxBytes) return outputStr;

    const argSummary = truncateText(summarizeArgs(call.name, parseJsonObject(call.arguments)), 120);
    const header = [
      `[tool output compacted for history: ${call.name}${argSummary ? ` ${argSummary}` : ''}]`,
      `original_bytes=${Buffer.byteLength(outputStr, 'utf8')} kept_bytes<=${maxBytes}`,
    ].join('\n');
    const omitted = '...[middle omitted from conversation history]...';
    const overhead = Buffer.byteLength(`${header}\n${omitted}\n`, 'utf8');
    const available = Math.max(0, maxBytes - overhead);
    if (available < 200) return header;

    const headBytes = Math.floor(available * 0.7);
    const tailBytes = available - headBytes;
    const head = sliceUtf8(outputStr, 0, headBytes);
    const tail = sliceUtf8(outputStr, -tailBytes);
    return [
      header,
      head,
      omitted,
      tail,
    ].join('\n');
  }

  compactHistory() {
    const maxMessages = this.config.maxHistoryMessages ?? 40;
    if (this.messages.length <= maxMessages) return;

    const system = this.messages[0];
    const summaryIndex = this.messages.findIndex((message, index) => (
      index > 0 &&
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.startsWith(SUMMARY_MARKER)
    ));
    const previousSummary = summaryIndex === -1 ? null : this.messages[summaryIndex];
    const startIndex = previousSummary ? summaryIndex + 1 : 1;
    const recentCount = Math.max(8, Math.floor(maxMessages / 2));
    let recentStart = Math.max(startIndex, this.messages.length - recentCount);
    while (recentStart < this.messages.length && this.messages[recentStart].role === 'tool') {
      recentStart += 1;
    }

    const oldMessages = this.messages.slice(startIndex, recentStart);
    if (oldMessages.length === 0) return;

    const summary = buildHistorySummary(previousSummary?.content, oldMessages);
    this.messages = [
      system,
      { role: 'system', content: summary },
      ...this.messages.slice(recentStart),
    ];
  }

  printTurnStats(startUsage, turnSteps) {
    const u = this.stats.usage;
    const d = diffUsage(u, startUsage);
    console.error(formatTurnStats(d, turnSteps));
  }
}

export function formatTurnStats(diff, steps) {
  const cacheTotal = diff.prompt_cache_hit_tokens + diff.prompt_cache_miss_tokens;
  const hitRate = cacheTotal > 0 ? (diff.prompt_cache_hit_tokens * 100) / cacheTotal : 0;
  const dim = '\x1b[2m\x1b[90m';
  const reset = '\x1b[0m';
  return `${dim}steps ${steps} | tokens ${diff.prompt_tokens + diff.completion_tokens} | cache hit ${hitRate.toFixed(1)}%${reset}`;
}

export function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  };
}

export function accumulateUsage(target, src) {
  target.prompt_tokens += src.prompt_tokens || 0;
  target.completion_tokens += src.completion_tokens || 0;
  target.total_tokens += src.total_tokens || 0;
  target.prompt_cache_hit_tokens += src.prompt_cache_hit_tokens || 0;
  target.prompt_cache_miss_tokens += src.prompt_cache_miss_tokens || 0;
}

function diffUsage(current, start) {
  return {
    prompt_tokens: current.prompt_tokens - start.prompt_tokens,
    completion_tokens: current.completion_tokens - start.completion_tokens,
    total_tokens: current.total_tokens - start.total_tokens,
    prompt_cache_hit_tokens: current.prompt_cache_hit_tokens - start.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: current.prompt_cache_miss_tokens - start.prompt_cache_miss_tokens,
  };
}

function buildHistorySummary(previousSummary, messages) {
  const lines = previousSummary && previousSummary.startsWith(SUMMARY_MARKER)
    ? previousSummary.split('\n').slice(0, 30)
    : [SUMMARY_MARKER];

  lines.push(`Compacted ${messages.length} older messages.`);
  for (const message of messages) {
    lines.push(`- ${message.role}: ${summarizeMessageForHistory(message)}`);
    if (lines.length >= 60) break;
  }

  return lines.join('\n');
}

function summarizeMessageForHistory(message) {
  if (message.role === 'assistant' && message.tool_calls?.length > 0) {
    const names = message.tool_calls.map((call) => call.name).join(', ');
    return `requested tools: ${names}`;
  }
  if (message.role === 'tool') {
    const firstLine = String(message.content ?? '').split(/\r?\n/, 1)[0];
    return truncateText(`${message.name || 'tool'} result: ${firstLine}`, 240);
  }
  return truncateText(String(message.content ?? ''), 240);
}

function truncateText(text, maxLength) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 15)}...[truncated]`;
}

function sliceUtf8(text, start, byteLength) {
  const buffer = Buffer.from(text, 'utf8');
  const slice = start < 0
    ? buffer.subarray(Math.max(0, buffer.length + start))
    : buffer.subarray(start, Math.min(buffer.length, start + byteLength));
  return slice.toString('utf8').replace(/\uFFFD/g, '');
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function shouldContinueForPromisedToolUse(content) {
  const text = String(content ?? '').trim();
  if (!text) return false;
  return [
    /让我先.*(扫描|查看|检查|搜索|看一下|读一下)/,
    /我先.*(扫描|查看|检查|搜索|看一下|读一下)/,
    /先.*(扫描|查看|检查|搜索).*项目/,
    /let me (first )?(scan|inspect|check|search|look at|read)/i,
    /i'?ll (scan|inspect|check|search|look at|read)/i,
  ].some((pattern) => pattern.test(text));
}

function summarizeArgs(name, args) {
  if (name === 'write_file') return args.path || '';
  if (name === 'read_file') {
    let s = args.path || '';
    if (args.offset) s += `:${args.offset}`;
    if (args.limit) s += `-${args.limit}`;
    return s;
  }
  if (name === 'grep') {
    let s = '';
    if (args.pattern) s += `'${args.pattern}'`;
    if (args.path) s += ` ${args.path}`;
    return s;
  }
  if (name === 'bash') {
    const cmd = args.command || '';
    const nl = cmd.indexOf('\n');
    return nl === -1 ? cmd : cmd.slice(0, nl) + '...';
  }
  return '';
}

export function formatToolUsageStats(stats) {
  const lines = [];
  if (Object.keys(stats).length === 0) {
    return '(no tool usage recorded)';
  }
  for (const [name, usage] of Object.entries(stats)) {
    lines.push(`${name}: prompt ${usage.prompt_tokens} | cache_hit ${usage.prompt_cache_hit_tokens} (${usage.prompt_cache_hit_tokens > 0 ? ((usage.prompt_cache_hit_tokens * 100) / (usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens)).toFixed(1) : '0.0'}%) | cache_miss ${usage.prompt_cache_miss_tokens} | completion ${usage.completion_tokens}`);
  }
  return lines.join(', ');
}
