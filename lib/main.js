import process from 'node:process';
import { Agent } from './agent.js';
import { Client } from './deepseek.js';
import { runRepl } from './repl.js';

const usageText = `sek - coding agent CLI (DeepSeek V4 Flash)

Usage:
  sek [options]              Start interactive REPL
  sek [options] "prompt"     REPL with initial task

Options:
  --cwd <path>       Project root (default: current directory)
  --max-output <n>   Truncate tool output to n bytes (default: 8192)
  --max-steps <n>    Max agent steps per user message (default: 40)
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
    maxStepsPerTurn: parsed.maxSteps,
    verbose: parsed.verbose,
  });

  if (parsed.initialParts.length > 0) {
    await agent.handleUserMessage(parsed.initialParts.join(' '), false);
  }

  await runRepl(agent);
}

function parseArgs(args) {
  const parsed = {
    cwd: null,
    maxOutput: 8192,
    maxSteps: 40,
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
