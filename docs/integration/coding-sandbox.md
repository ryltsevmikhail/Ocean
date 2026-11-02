# Coding sandbox development checkpoint

Status: stage 3 prototype, not qualified or enabled in conversations.

Linux development and final qualification move to the owner's Omarchy x86_64
notebook. BigPC remains the source of the earlier development checkpoint.
Machine access and secrets are operational configuration, not repository assets.

## Implemented prototype

- Fixed bubblewrap namespace layout with private PID, network, proc, temporary
  directory and HOME. Only the task root is writable; OS tools are read-only.
- A supervised user systemd unit starts before project code. A readiness handshake
  lets the host record the cgroup before command dispatch.
- Detached descendants, timeout and cancellation are tested with real processes.
  Cleanup evidence reads the observed cgroup, not just the leader's exit status.
- Fixed filesystem worker preserves exact UTF-8 text, checks stale content and
  uses temporary-file replacement and directory fsync.
- Explicit read-only dependency mounts reject symlinks outside their declared
  closure. No full home or host root mount is accepted.
- Command evidence binds invocation, source hashes, exit status, retained output
  and cleanup. Only exact registered presets may use the backend.

## Verification at transfer

BigPC: seven focused tests passed with OCEAN_SANDBOX_NATIVE=1. They cover synthetic
host canaries, absent credential environment/user bus/cgroups, denied network and
OS writes, detached descendants, timeout, cancellation, bounded output, file
writes, stale content and unsupported task paths.

The ordinary suite passes 585 tests and skips five opt-in native tests;
typecheck, lint, build and formatting pass. This is a transfer checkpoint,
not completion of stage 3.

## Notebook transfer verification

The notebook uses Node 26.13.0 and pnpm 12.16.1. The frozen lockfile
installation, ordinary 586-test suite, typecheck, lint, build and formatting
passed. All seven focused native tests passed after replacing the assumed
/usr/bin/node with a read-only mount of the actual runtime executable at
/toolchain/node. No complete home directory is mounted.

The source checkout is now on the notebook; stages 3–7 continue there. These
checks do not yet qualify the dependency closure or complete stage 3.

A repeat run exposed registry initialization under an exclusive SQLite lock.
The busy timeout now takes effect before synchronous-mode initialization; a
real child-process lock regression failed before the fix and passed afterward.

## Open qualification work

- Repeat native tests on the target notebook, including all descendant and
  failure/uncertain cleanup cases.
- Prove the complete Ocean dependency and pnpm toolchain mount closure, offline
  frozen-lockfile preparation, and real test/typecheck/lint/build presets.
- Measure memory/process limits against those real presets. Current prototype
  ceilings are 2 GiB, 256 tasks, 60 seconds and 32 KiB retained command output.
- Harden observation failures, worker interruption and filesystem race cases.
- Complete review and native qualification before enabling capabilities.
- Stages 4–7 remain required for durable owner approvals, chat tools,
  review/application, recovery, complete backup and release acceptance.

No provider credentials or user conversation profiles are part of this transfer.
The released text-only installation is unchanged.
