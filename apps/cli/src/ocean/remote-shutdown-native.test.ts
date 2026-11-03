import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { codingWorkflowFixture, initialMath } from './coding-workflow-fixture.js';
import { registerCodingProject } from './coding-projects.js';
import { profileCli } from '../../test-fixtures/profile-cli.test.js';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1').each(['pending', 'descendant'])(
  'retains truthful shutdown evidence with active %s',
  async (phase) => {
    const f = await codingWorkflowFixture('direct'),
      profile = f.directory,
      scope = { workspaceId: 'ws_ocean', roomId: f.room },
      run = join(profile, 'r');
    try {
      const selected = f.runtime.coding.inspect('ws_ocean', 'task');
      if (!selected.ok) throw Error('fixture');
      await registerCodingProject(
        profile,
        {
          id: 'fixture',
          root: f.project,
          mounts: [],
          testPresets: selected.value.policy.testPresets,
        },
        async () => true,
      );
      writeFileSync(
        join(f.worktree, 'math.cjs'),
        `require('node:child_process').spawn('/toolchain/node',['-e',"setInterval(()=>require('node:fs').appendFileSync('/workspace/ticks','x'),20)"],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},100);module.exports=()=>5;`,
      );
      f.runtime.close();
      chmodSync(join(profile, 'runtime.sqlite'), 0o600);
      mkdirSync(run, { mode: 0o700 });
      vi.stubEnv('XDG_RUNTIME_DIR', run);
      const program = `import {startLocalRuntime} from './apps/cli/dist/local-runtime/host.js';
 let round=0;const provider={id:'fixture',models:['fixture'],capabilities:{streaming:true,usage:true,toolCalls:true},async *stream(){
 if(round++===0){yield {type:'tool_call',call:{id:'check',name:'run_test',arguments:'{"presetId":"test"}'}};yield {type:'usage',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};yield {type:'completed',stopReason:'tool_calls',rawStopReason:'tool_calls'};}
 else{yield {type:'text_delta',text:'done'};yield {type:'usage',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};yield {type:'completed',stopReason:'stop',rawStopReason:'stop'};}}};
 const host=await startLocalRuntime({profile:process.argv[1],provider,drainDeadlineMs:process.argv[2]==='pending'?5000:5});console.log('ready');await host.closed;`;
      const owner = spawn(
        process.execPath,
        ['--input-type=module', '-e', program, profile, phase],
        {
          env: {
            ...Object.fromEntries(
              [
                'HOME',
                'XDG_RUNTIME_DIR',
                'XDG_CONFIG_HOME',
                'XDG_DATA_HOME',
                'XDG_STATE_HOME',
                'XDG_CACHE_HOME',
                'TMPDIR',
              ].map((key) => [key, process.env[key]]),
            ),
            PATH: process.env['PATH'],
            HOME: process.env['HOME'],
            XDG_RUNTIME_DIR: run,
            DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'],
          },
        },
      );
      const exited = new Promise((r) => owner.once('close', r));
      let log = '';
      owner.stdout.on('data', (b) => {
        log += b;
      });
      owner.stderr.on('data', (b) => {
        log += b;
      });
      try {
        await vi.waitFor(() => expect(log).toContain('ready'), { timeout: 5000 });
        const cli = profileCli(profile, run),
          c = await connectLocalRuntime({ profile });
        try {
          const args = [
            'send',
            f.room,
            '--task',
            'task',
            '--text',
            'check',
            '--request-id',
            'task-request',
          ];
          const botArgs = [
            'bot',
            'add',
            '--handle',
            'replay',
            '--name',
            'Replay',
            '--role',
            'r',
            '--request-id',
            'bot-replay',
          ];
          const bot = await cli(...botArgs);
          expect(bot.code).toBe(0);
          const admission = await cli(...args);
          expect(admission).toMatchObject({
            code: 0,
            reply: { data: { runId: expect.any(String), status: 'admitted' } },
          });
          const card = await vi.waitFor(
            async () => {
              const a = (await c.listDecisions(scope))[0];
              expect(a?.kind).toBe('test');
              return a!;
            },
            { timeout: 10000 },
          );
          expect(card.runId).toBe(admission.reply.data.runId);
          const ticks = join(f.worktree, 'ticks');
          if (phase === 'descendant') {
            const ref = { ...scope, runId: card.runId, decisionId: card.decisionId };
            await c.decisionPreview(ref);
            await c.resolveDecision({
              ...ref,
              choice: 'allow-once',
              expectedVersion: card.version,
              bindingDigest: card.bindingDigest,
            });
            await vi.waitFor(() => expect(existsSync(ticks)).toBe(true), { timeout: 10000 });
          }
          const stop = await cli('runtime', 'stop');
          if (phase === 'descendant') {
            expect(stop).toMatchObject({
              code: 4,
              reply: { data: { outcome: 'uncertain', state: 'stop_incomplete' } },
            });
            expect(
              (await cli('bot', 'add', '--handle', 'extra', '--role', 'r', '--name', 'n')).reply
                .error.code,
            ).toBe('runtime_draining');
            expect((await cli(...args)).reply.data).toEqual(admission.reply.data);
            expect(await cli(...botArgs)).toEqual(bot);
            const changed = [...botArgs];
            changed[7] = 'changed';
            expect((await cli(...changed)).reply.error.code).toBe('request_conflict');
            expect((await cli('runtime', 'start')).reply.error.code).toBe('owner_busy');
            await vi.waitFor(
              async () => {
                const before = readFileSync(ticks, 'utf8');
                await new Promise((r) => setTimeout(r, 120));
                expect(readFileSync(ticks, 'utf8')).toBe(before);
              },
              { timeout: 5000 },
            );
          } else {
            expect(existsSync(ticks)).toBe(false);
            expect(stop.reply.data.outcome).toBe('complete');
          }
          expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
        } finally {
          c.close();
        }
      } finally {
        owner.kill('SIGKILL');
        await exited;
      }
    } finally {
      vi.unstubAllEnvs();
      f.close();
    }
  },
  30000,
);
