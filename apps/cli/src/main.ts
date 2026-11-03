#!/usr/bin/env node
/**
 * Ocean CLI entry point.
 *
 * Commands are intentionally small: the CLI is a host that composes domain,
 * application, and store adapters. It owns no domain logic of its own.
 */

import { runDemo } from './lifecycle.js';
import { renderEvents, renderJson, renderState } from './render.js';
import { CLI_VERSION, isVersionRequest } from './version.js';

const HELP = `ocean ${CLI_VERSION} — Ocean command line

Usage:
  ocean install --archive /archive --sha256 HASH --prefix /user/prefix
  ocean runtime start|restore|status|stop --profile /path [--json]
  ocean rebind inspect|preview|confirm|result --config /selection.json --profile /path
  ocean doctor [--static] [--profile /path] [--json]
  ocean backup --to /new/snapshot --profile /path
  ocean restore --from /snapshot --profile /new/profile
  ocean init --workspace dir [--profile /path]
  ocean bot add --handle dev --name Developer --role "Your role"
  ocean bot list | ocean room direct --bot dev
  ocean room group --name Team --bot dev --bot review
  ocean room list | ocean room members roomId
  ocean send roomId --text "message" [--to dev] [--request-id id] [--json]
  ocean history roomId | ocean tui --room roomId
  ocean run list | ocean run review taskRunId
  ocean run acknowledge taskRunId --text-only --review-version token --reason "..."
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

Exit codes: 0 success, 1 runtime failure, 2 invalid input/security, 3 unavailable/maintenance, 4 operation refusal/incomplete.
Interrupted shared send: 130 SIGINT, 143 SIGTERM.
`;

export async function main(argv: readonly string[]): Promise<number> {
  if (isVersionRequest(argv)) {
    process.stdout.write(`ocean ${CLI_VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (
    command === '--profile' ||
    command === '--json' ||
    [
      'runtime',
      'rebind',
      'coding',
      'project',
      'init',
      'bot',
      'room',
      'send',
      'history',
      'run',
      'doctor',
      'backup',
      'restore',
    ].includes(command ?? '') ||
    (command === 'tui' && rest.includes('--room'))
  ) {
    const { runOceanCommand } = await import('./ocean/command.js');
    return runOceanCommand(argv);
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === 'install') {
    const { installCommand } = await import('./release/installer.js');
    return installCommand(rest);
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

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  // Legacy RUNNE_DB hosts have no local-runtime wire envelope.
  if (error instanceof Error && 'code' in error && error.code === 'endpoint_exists') {
    process.stderr.write('endpoint_exists\n');
    return 3;
  }
  throw error;
});
