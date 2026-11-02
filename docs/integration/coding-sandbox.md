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

## Notebook follow-up

Cancellation during asynchronous mount inventory previously allowed the command
to run. The supervisor now checks the signal again immediately before spawning
the service, with no await before installing its abort listener. A native test
reproduced the unwanted successful dispatch and now verifies that the workspace
marker is absent.

A fresh archive of 570c584 installed all 151 dependencies from the notebook's
existing pnpm store with zero downloads. The host-side experiment used
`pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir <store-base> --package-import-method=copy`.
The explicit store is necessary on tmpfs. The resulting dependency roots were
the top-level node_modules, apps/cli/node_modules and node_modules under
packages/{application,provider-core,provider-deepseek,store,store-sqlite,tools-node}.
The installed pnpm is a standalone executable. This inventory still requires
read-only worker verification with all four real presets.

With those eight dependency roots and a separate directory containing only
bin/pnpm mounted read-only, the supervised worker executed typecheck, lint and
build with exit 0 and confirmed cgroup cleanup. Build reused typecheck output.
Plain pnpm test failed during Vite configuration loading because node_modules
is read-only. The exact invocation
`pnpm --config.verify-deps-before-run=false test --configLoader native`
completed with exit 0, untruncated output and confirmed cleanup in the same
network-isolated worker. These exploratory runs do not establish peak usage,
source stability, or production-safe mount admission.

## Cold preset measurements on Omarchy

A new source archive of 51c6d9c was used for each preset, without dist or
incremental compiler state. All four used the same frozen offline dependency
copy. Dependency mounts now require the matching node_modules path in the
declared dependency project and reject multiply linked files. Only the
standalone executable is bound to /toolchain/pnpm/bin/pnpm. The OS /usr and
current Node executable remain read-only. Commands used
`pnpm --config.verify-deps-before-run=false <preset>`, adding
`--configLoader native` for test.

| Preset    | Elapsed (s) | Observed memory.peak (bytes) | Observed pids.peak |
| --------- | ----------: | ---------------------------: | -----------------: |
| test      |        6.69 |                    768421888 |                169 |
| typecheck |        2.80 |                    353157120 |                 49 |
| lint      |        5.77 |                    814325760 |                 53 |
| build     |        2.41 |                    360546304 |                 49 |

Elapsed time includes inventory and supervision. The host sampled kernel peak
counters at 5 ms intervals and matched each unit to the returned cgroup. Each
exited 0 with untruncated output and confirmed cleanup. These observations
support retaining the prototype limits for subsequent qualification.

## Observation and file worker review

The supervisor now requires a populated cgroup for the exact generated unit
before transferring the request over stdin. Missing, contradictory or
unreadable final observations leave cleanup uncertain. Removal of an observed
cgroup is checked against its readable parent. Native fault-injection tests
cover both sides of dispatch. Another test kills the worker while a detached
descendant is writing and verifies that writes cease after confirmed cleanup.

The fixed file worker receives approved contents through private stdin. An
exact 128 KiB replacement with a 128 KiB preimage previously exceeded Linux's
single-argument limit. The regression also verifies preservation of mode 0777
across replacement. Missing task mountpoints are refused before bubblewrap
can create them during a read. Failures after installation are uncertain.

Independent review still requires end-to-end file cancellation, parent
directory race protection, content-bound toolchain/dependency identity and
stronger native canaries before the qualification gate closes.

A subsequent native regression exercised cancellation through WorkspaceTools,
the prepared write, the sandbox backend and filesystem inventory. Cancellation
before dispatch now leaves the target absent. File operations open parent
components with O_DIRECTORY and O_NOFOLLOW, retain a directory descriptor, and
stage, install and clean up relative to that descriptor. Directory identity is
checked before installation and again before reporting success. A deterministic
native test exchanges the parent immediately after staging, creates colliding
names in its replacement, and verifies refusal and cleanup in the original
directory. Mutation still requires exclusive task ownership; file-content
comparison and rename do not form a kernel-level compare-and-swap against
arbitrary concurrent writers. Isolation tests now create and verify readable
synthetic host key, profile, backup and SSH files before testing worker denial.

Dependency inventory now returns a deterministic SHA-256 digest covering paths,
modes, file bytes and symlink text. File reads use O_NOFOLLOW and compare
descriptor metadata before and after hashing. Command evidence includes that
digest in its invocation hash and verifies it again after execution. Changed
dependencies make the command result an error. A regression replaces package
contents at the same path and verifies a different digest. Binding the running
Node binary and the qualification lifetime still remains open.

Backend qualification now records the content identity of the current Node
executable and declared dependency/toolchain mounts before the probe, verifies
it after the probe, and checks it before every read/list/write/command. Changed
inputs require a new backend qualification. A native regression replaces a
dependency after qualification and verifies refusal before the write marker
is created. This still requires closing the interval between verification and
mount creation before declaring the complete qualification gate passed.

Supervisor input validation also refuses nonfinite, fractional, zero and
negative retained-output limits before starting a service. Five regression
cases previously dispatched a worker rather than rejecting invalid limits.
The verification-to-mount race remains open and prevents stage-3 completion.
