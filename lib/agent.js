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
  '',
  '## Think-Execute Separation',
  '',
  'For any non-trivial task, follow this two-phase approach:',
  '',
  '**Phase 1 — Think**: First, analyze the task and produce a clear plan.',
  '  - Read relevant files, search the codebase, understand the structure.',
  '  - Output your analysis and step-by-step plan as text BEFORE calling modification tools.',
  '  - During this phase, use read-only tools (read_file, list_dir, grep).',
  '',
  '**Phase 2 — Execute**: Once you have a complete understanding, execute the plan.',
  '  - Use write_file, bash and other modification tools.',
  '  - After each modification, verify the result if needed.',
  '',
  '**Important**: Always output your thinking/analysis/plan as text first,',
  'then proceed with the corresponding tool calls. Do not skip to tools without explaining your reasoning.',
  '',
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
      maxToolHistoryBytes: config.maxToolHistoryBytes ?? 2048,
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
          `${ansi.step}->${ansi.reset} ${ansi.bold}step ${stepNum}${ansi.reset} ${formatDuration(thinkMs)} \u00b7 ${formatTokens(stepTokens)} tokens` +
          (toolNames ? ` \u00b7 ${ansi.toolName}${toolNames}${ansi.reset}` : '')
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
    if (this.messages.length <= this.config.maxHistoryMessages) return;

    // Find first non-system message index
    const firstNonSystem = this.messages.findIndex((m) => m.role !== 'system');
    if (firstNonSystem < 0) return;

    // Keep system messages + recent messages within limit
    const maxMessages = this.config.maxHistoryMessages;
    const excludeSystem = this.messages.filter((m) => m.role === 'system');
    const nonSystem = this.messages.filter((m) => m.role !== 'system');

    // Determine how many of the later messages to keep
    const keep = Math.max(2, maxMessages - excludeSystem.length); // at least the last user+assistant
    const keepSlice = dropLeadingOrphanToolMessages(nonSystem.slice(-keep));

    // Summarize the omitted middle portion
    const omittedCount = nonSystem.length - keepSlice.length;
    if (omittedCount > 0) {
      const summary = buildSummary(omittedCount);
      this.messages = [...excludeSystem, summary, ...keepSlice];
    } else {
      this.messages = [...excludeSystem, ...keepSlice];
    }
  }

  printTurnStats(startUsage, turnSteps) {
    const u = this.stats.usage;
    const turnTokens = {
      prompt: u.prompt_tokens - startUsage.prompt_tokens,
      completion: u.completion_tokens - startUsage.completion_tokens,
      total: u.total_tokens - startUsage.total_tokens,
      cacheHit: u.prompt_cache_hit_tokens - startUsage.prompt_cache_hit_tokens,
      cacheMiss: u.prompt_cache_miss_tokens - startUsage.prompt_cache_miss_tokens,
    };

    const cacheTotal = turnTokens.cacheHit + turnTokens.cacheMiss;
    const cacheHitRate = cacheTotal > 0 ? (turnTokens.cacheHit * 100) / cacheTotal : 0;

    // Show per-tool stats in verbose mode
    let toolStatsStr = '';
    if (this.config.verbose) {
      const parts = [];
      for (const [name, usage] of Object.entries(this.stats.toolUsage)) {
        parts.push(`${name}=${formatTokens(usage.completion_tokens)}`);
      }
      if (parts.length > 0) toolStatsStr = ` \u00b7 ${parts.join(' ')}`;
    }

    console.error(
      `${ansi.statsDim}  (turn: ${turnSteps} step(s), ` +
      `prompt ${formatTokens(turnTokens.prompt)}, ` +
      `completion ${formatTokens(turnTokens.completion)}, ` +
      `cache ${cacheHitRate.toFixed(0)}% hit)${toolStatsStr}${ansi.reset}`
    );
  }
}

export function shouldContinueForPromisedToolUse(content) {
  const text = String(content ?? '').trim();
  if (!text) return false;

  // Check if the content ends with a plan/analysis section that suggests
  // the model will proceed with tool calls in the next step
  const lower = text.toLowerCase();

  // Patterns that indicate the model is in "think phase" and will call tools next
  const thinkPhasePatterns = [
    // Chinese patterns
    /让我先.*(扫描|查看|检查|搜索|看一下|读一下|分析|了解|理解)/,
    /我先.*(扫描|查看|检查|搜索|看一下|读一下|分析|了解|理解)/,
    /先.*(扫描|查看|检查|搜索).*项目/,
    /接下来.*(我会|我准备|开始|执行|动手)/,
    /计划.*(如下|如下|是|：)/,
    /方案.*(是|如下|：)/,
    /分析.*完毕.*接下来/,
    /分析.*完成.*开始/,
    /理解.*(需求|问题|任务).*开始/,
    /思路.*(如下|是|：)/,
    /步骤.*(如下|是|：)/,
    /总结.*(一下|如下).*接下来/,
    /让我(先)?.*(梳理|整理|理清)/,
    /以下.*我的.*(计划|方案|思路|分析)/,
    /我(计划|打算|准备|将).*分.*步/,
    /首先.*(读取|查看|查看|搜索|检查).*然后/,

    // English patterns
    /let me (first )?(analyze|plan|think|understand|examine|review|study|outline)/i,
    /i'?ll (first )?(analyze|plan|think|understand|examine|review|study|outline)/i,
    /here('?s| is) my (plan|analysis|approach|strategy|outline)/i,
    /my (plan|analysis|approach) (is|will be|involves)/i,
    /let me start by (analyzing|examining|reviewing|checking|reading)/i,
    /first,.*(i'?ll|i will|let me).*(analyze|read|check|examine|review|understand|look)/i,
    /i will proceed (in|with|by)/i,
    /proposed (plan|approach|solution)/i,
    /step(-| )?1/i,
    /phase 1/i,
    /think.*execute/i,

    // Task-completion patterns that need more steps
    /task.*complete.*but.*(need|should|must|still)/i,
    /finished.*(main|primary).*(task|change).*(need|still|remaining)/i,
  ];

  if (thinkPhasePatterns.some((pattern) => pattern.test(lower))) {
    return true;
  }

  // Fallback: if content has substantial text (analysis/plan) and
  // ends with a clear intent to proceed
  if (text.length > 200) {
    // Check if it ends with indications of continuing
    const endLines = text.split('\n').slice(-3).join('\n').toLowerCase();
    const endPatterns = [
      /proceed/i,
      /continue/i,
      /next/i,
      /开始/i,
      /继续/i,
      /下一步/i,
      /执行/i,
      /implement/i,
      /now .*(can|will|let)/i,
    ];
    if (endPatterns.some((p) => p.test(endLines))) {
      return true;
    }
  }

  return false;
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

export function formatToolUsageStats(toolUsage) {
  const parts = Object.entries(toolUsage)
    .sort((a, b) => b[1].completion_tokens - a[1].completion_tokens)
    .map(([name, usage]) => `${name}: ${formatTokens(usage.completion_tokens)}`);
  return parts.length > 0 ? parts.join(', ') : '';
}



export function formatTurnStats(usage, steps) {
  const total = usage.prompt_tokens + usage.completion_tokens;
  const cacheTotal = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  const cacheHitRate = cacheTotal > 0
    ? `cache hit ${(usage.prompt_cache_hit_tokens / cacheTotal * 100).toFixed(1)}%`
    : '';
  const dim = ansi.statsDim;
  const reset = color.reset;
  let out = `${dim}steps ${steps}`;
  out += `  ${cacheHitRate ? cacheHitRate + '  ' : ''}tokens ${formatTokens(total)}${reset}`;
  return out;
}
function parseJsonObject(str) {
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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

export function accumulateUsage(target, source) {
  target.prompt_tokens += source.prompt_tokens;
  target.completion_tokens += source.completion_tokens;
  target.total_tokens += source.total_tokens;
  target.prompt_cache_hit_tokens += source.prompt_cache_hit_tokens;
  target.prompt_cache_miss_tokens += source.prompt_cache_miss_tokens;
}

function dropLeadingOrphanToolMessages(messages) {
  let firstValid = 0;
  while (firstValid < messages.length && messages[firstValid].role === 'tool') {
    firstValid += 1;
  }
  return firstValid === 0 ? messages : messages.slice(firstValid);
}

function buildSummary(omittedCount) {
  return {
    role: 'system',
    content: `[sek session summary] ${omittedCount} earlier message(s) omitted for context length. Continue with the conversation.`,
  };
}

function truncateText(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '...';
}

function sliceUtf8(buf, offset, length) {
  const str = typeof buf === 'string' ? buf : String(buf);
  if (offset >= 0) {
    return str.slice(0, offset);
  }
  return str.slice(offset);
}
