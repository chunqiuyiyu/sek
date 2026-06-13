import process from 'node:process';
import { Agent } from './agent.js';
import { Client } from './deepseek.js';
import { runRepl, runWithStepContinuation } from './repl.js';

const usageText = `sek - coding agent CLI (DeepSeek V4 Flash)

Usage:
  sek [options]              Start interactive REPL
  sek [options] "prompt"     REPL with initial task

Options:
  --cwd <path>       Project root (default: current directory)
  --max-output <n>   Truncate tool output to n bytes (default: 8192)
  --max-tool-history <n>
                     Keep at most n bytes of each tool result in history (default: 4096)
  --max-history-messages <n>
                     Compact older conversation history above n messages (default: 40)
  --max-steps <n>    Max agent steps per user message (default: 80)
  --verbose          Print token/cache usage each step
  --help             Show this help

Environment:
  DEEPSEEK_API_KEY   Required API key
  DEEPSEEK_API_URL   Optional chat completions URL
`;

export async function main(argv = process.argv, env = process.env) {
  const parsed = parseArgs(argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usageText);
    return;
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY is not set');
    process.exitCode = 1;
    return;
  }

  const workdir = parsed.cwd || process.cwd();
  const client = new Client({
    apiKey,
    baseUrl: env.DEEPSEEK_API_URL,
  });
  const agent = await Agent.create(client, {
    workdir,
    maxOutput: parsed.maxOutput,
    maxToolHistoryBytes: parsed.maxToolHistoryBytes,
    maxHistoryMessages: parsed.maxHistoryMessages,
    maxStepsPerTurn: parsed.maxSteps,
    verbose: parsed.verbose,
  });

  if (parsed.initialParts.length > 0) {
    await runWithStepContinuation(
      agent,
      () => agent.handleUserMessage(parsed.initialParts.join(' '), false),
      false,
    );
  }

  await runRepl(agent);
}

function parseArgs(args) {
  const parsed = {
    cwd: null,
    maxOutput: 8192,
    maxToolHistoryBytes: 4096,
    maxHistoryMessages: 40,
    maxSteps: 80,
    verbose: false,
    help: false,
    initialParts: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      return parsed;
    }
    if (arg === '--cwd') {
      i += 1;
      if (i >= args.length) throw new Error('--cwd requires a path');
      parsed.cwd = args[i];
      continue;
    }
    if (arg === '--max-output') {
      i += 1;
      if (i >= args.length) throw new Error('--max-output requires a number');
      parsed.maxOutput = parsePositiveInteger(args[i], '--max-output');
      continue;
    }
    if (arg === '--max-tool-history') {
      i += 1;
      if (i >= args.length) throw new Error('--max-tool-history requires a number');
      parsed.maxToolHistoryBytes = parsePositiveInteger(args[i], '--max-tool-history');
      continue;
    }
    if (arg === '--max-history-messages') {
      i += 1;
      if (i >= args.length) throw new Error('--max-history-messages requires a number');
      parsed.maxHistoryMessages = parsePositiveInteger(args[i], '--max-history-messages');
      continue;
    }
    if (arg === '--max-steps') {
      i += 1;
      if (i >= args.length) throw new Error('--max-steps requires a number');
      parsed.maxSteps = parsePositiveInteger(args[i], '--max-steps');
      continue;
    }
    if (arg === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (arg === '--') {
      parsed.initialParts.push(...args.slice(i + 1));
      break;
    }
    parsed.initialParts.push(arg);
  }

  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return parsed;
}
