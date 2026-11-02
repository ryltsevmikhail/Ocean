#!/usr/bin/env node
/**
 * RunneTS CLI entry point.
 *
 * Commands are intentionally small: the CLI is a host that composes domain,
 * application, and store adapters. It owns no domain logic of its own.
 */

import { runDemo } from './lifecycle.js';
import { renderEvents, renderJson, renderState } from './render.js';
import { CLI_VERSION, isVersionRequest } from './version.js';

const HELP = `runne ${CLI_VERSION} — RunneTS command line

Usage:
  runne                 open TUI in the current directory
  runne demo [--json]   run a scripted TaskRun lifecycle and print the result
  runne acp             serve the runtime as an ACP agent over stdio
                        (DEEPSEEK_API_KEY enables real model turns)
  runne task [--cwd dir] "prompt"  execute a coding task with tool approvals
  runne tui [--cwd dir]  full-screen terminal UI for TaskRuns and prompts
                        Enter send · PgUp/PgDn scroll · F2 tasks · F3 events
                        F4 details · F5 reasoning · Esc cancel · /quit exit
  runne status [taskRunId] inspect retained runs and unresolved effects
  runne --version       print the CLI version
  runne help            show this message

Exit codes: 0 success, 1 runtime failure, 2 usage error.
`;

export async function main(argv: readonly string[]): Promise<number> {
  if (isVersionRequest(argv)) {
    process.stdout.write(`runne ${CLI_VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = argv;

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === 'status') {
    const { runStatus } = await import('./status.js');
    return runStatus(rest);
  }

  if (command === 'acp') {
    const { runAcp } = await import('./acp/run.js');
    return runAcp();
  }

  if (command === 'task') {
    const { runTask } = await import('./task.js');
    return runTask(rest);
  }

  if (command === undefined || command === 'tui') {
    const { runTui } = await import('./tui/run.js');
    if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--cwd' || rest[1] === undefined)) {
      process.stderr.write('Usage: runne tui [--cwd directory]\n');
      return 2;
    }
    return runTui({ workspace: rest[1] });
  }

  if (command === 'demo') {
    const json = rest.includes('--json');
    const run = await runDemo();

    if (json) {
      process.stdout.write(
        `${renderJson({
          taskRunId: run.taskRunId,
          status: run.state.status,
          version: run.state.version,
          events: run.receipts.flatMap((receipt) => receipt.events),
        })}\n`,
      );
      return 0;
    }

    process.stdout.write(`events:\n${renderEvents(run.receipts)}\n\n`);
    process.stdout.write(`${renderState(run.state)}\n`);
    return 0;
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
