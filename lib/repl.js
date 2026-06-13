import process from 'node:process';
import { readLine, Suggester } from './line_editor.js';
import { formatDuration } from './timer.js';
import { formatToolUsageStats } from './agent.js';
import { confirmDefaultYes } from './approve.js';

export async function runRepl(agent) {
  console.error(`sek - coding agent (DeepSeek V4 Flash)
Project: ${agent.workspaceRoot()}
Type a task, /ask for read-only Q&A, or /help /exit
`);

  let askMode = false;
  const suggester = new Suggester();

  try {
    while (true) {
      const prompt = askMode ? 'ask> ' : '> ';
      const line = await readLine(prompt, {
        workspaceRoot: agent.workspaceRoot(),
        suggester,
      });

      // Ctrl+C / Ctrl+D — exit
      if (line === '') break;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/help') {
        printHelp();
        continue;
      }
      if (trimmed === '/stats') {
        printStats(agent);
        continue;
      }
      if (trimmed === '/ask') {
        askMode = true;
        console.error('(read-only ask mode - /agent to switch back)');
        continue;
      }
      if (trimmed === '/agent') {
        askMode = false;
        console.error('(agent mode)');
        continue;
      }
      if (trimmed.startsWith('/ask ')) {
        const question = trimmed.slice('/ask '.length).trim();
        if (question.length === 0) {
          console.error('Usage: /ask <question>');
          continue;
        }
        await runWithStepContinuation(agent, () => agent.handleUserMessage(question, true), true);
        continue;
      }

      await runWithStepContinuation(agent, () => agent.handleUserMessage(trimmed, askMode), askMode);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      // Ctrl+D or signal
    } else {
      throw error;
    }
  }

  // Log usage stats on exit
  printStats(agent);

  // Ensure the process exits cleanly
  process.exit(0);
}

export async function runWithStepContinuation(agent, startTurn, askMode) {
  let result = await startTurn();
  while (result?.reachedMaxSteps) {
    const steps = agent.config?.maxStepsPerTurn ?? 80;
    const ok = await confirmDefaultYes(`Reached max steps (${steps}). Continue for another ${steps} steps?`);
    if (!ok) break;
    result = await agent.continueTurn(askMode);
  }
  return result;
}

function printHelp() {
  console.error(`Commands:
  /help     Show this help
  /exit     Quit
  /stats    Show session token usage & cache stats
  /ask      Enter read-only Q&A mode (no file writes or bash)
  /ask <q>  One-shot read-only question
  /agent    Return to agent mode (can modify files)

Tools:
  read_file  Read a UTF-8 text file in the workspace.
             Args: path (required), offset (optional, 1-based start line),
                   limit (optional, max lines, default 200)
             Ask mode: allowed

  write_file Write or overwrite a UTF-8 text file in the workspace.
             Args: path (required), content (required)
             Ask mode: blocked

  list_dir   List files and directories.
             Args: path (required)
             Ask mode: allowed

  grep       Search for a literal substring in files under a directory.
             Args: pattern (required), path (required)
             Ask mode: allowed

  bash       Run a shell command with cwd set to the project root.
             Args: command (required)
             Ask mode: blocked

  Actions outside the workspace or network access require [y/n] approval.

Line editing:
  Tab          Complete command / file path (press twice for list)
  @            Trigger file path completion (press Tab to complete)
  Up/Down      History navigation
  Ctrl+F / →   Accept suggestion character
  Ctrl+E / End Accept full suggestion
  Ctrl+A / Home Go to line start
  Ctrl+U       Delete whole line
  Ctrl+W       Delete word before cursor
  Ctrl+K       Delete after cursor

Step limit:
  Enter        Continue another max-steps chunk when prompted
`);
}

function printStats(agent) {
  const u = agent.stats.usage;
  const cacheTotal = u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens;
  const hitRate = cacheTotal > 0 ? (u.prompt_cache_hit_tokens * 100) / cacheTotal : 0;
  const outputTokens = u.completion_tokens;
  const total = u.total_tokens;
  console.error(`-- session end: tokens=${total} (output=${outputTokens}), cache hit rate=${hitRate.toFixed(1)}% --`);
}
