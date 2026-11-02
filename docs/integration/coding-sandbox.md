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

## Mount descriptor experiment

On Omarchy, keeping host FileHandles open and binding
/proc/<host-pid>/fd/<fd> from bubblewrap inside the user unit fails with
Permission denied. A native experiment verified that the handles survive
pathname replacement, but 15 isolation tests failed before admission because
the supervised service cannot traverse those host proc descriptors. The
experiment was removed. A solution must transfer descriptors into the
supervised unit (or prepare immutable mount assets there); host proc paths
cannot be assumed usable. No qualification gate is relaxed by this result.

The next native experiment succeeded: a trusted Node bootstrap inside the
supervised unit opens mount sources and inherits those descriptors directly
into bubblewrap's --bind-fd/--ro-bind-fd. The supervisor now uses this bootstrap
and all 25 focused tests pass. Mount source pathname replacement after opening
cannot redirect those mounts. The fixed /dev/null mask remains a direct bind.
Qualification still needs to bind the opened descriptor contents to the
pre-approved identity, including the interval before the bootstrap opens them.

The bootstrap now compares each opened mount descriptor's device, inode,
mode, size and nanosecond modification/change times with host observations
captured before service creation. A regression exchanges a file after
bootstrap preparation and verifies refusal before bubblewrap starts.
This detects source replacement before opening; directory metadata alone
does not attest descendant contents, so content qualification still needs
a mounted-tree verification before command admission.

Bootstrap file sources (Node and standalone pnpm) are now SHA-256 checked
through their opened descriptors against host fingerprints before bubblewrap.
Descriptor metadata is rechecked after hashing. Replacement and in-place
rewrites after bootstrap preparation are rejected by regression tests.
The added hashing increased startup time, so the native timeout/cancellation
test uses one second instead of 200 ms to exercise an admitted worker.
Directory descendant attestation and protection against in-place modification
after hashing still need qualification.

Read-only file sources now use bubblewrap --ro-bind-data with preserved
permissions, producing private copies instead of live host inode mounts.
Hashing uses positional reads so the inherited descriptors remain at offset
zero. A native test modifies the host file after the sandbox announces
readiness and confirms that the sandbox still reads the original bytes.
Directory descendants and the copy-time interval remain open qualification
items.

Executable hashing now writes the same chunks to a private temporary copy
inside the supervised bootstrap. After matching the expected fingerprint, the
bootstrap keeps only a read-only descriptor to the copy and removes its path
before spawning bubblewrap. The copied bytes, rather than the mutable original
descriptor, feed --ro-bind-data. Native fault injection changes the original
immediately before bubblewrap spawn as well as after readiness and verifies
that the sandbox reads the qualified bytes. Abrupt interruption while staging
may leave an executable-only scratch directory; crash cleanup remains part of
the recovery gate.

Supervised units now own a mode-0700 RuntimeDirectory. Executable staging uses
that directory, so systemd removes bootstrap scratch when the unit terminates.
A native test verifies the unit runtime directory is absent after confirmed
cleanup. PrivateTmp was tested but does not fit task roots hosted under /tmp;
the runtime directory provides staging ownership without masking those roots.
Directory dependency snapshot qualification remains open.

Read-only dependency directory mounts now receive private copies in the
unit runtime directory. A shared bounded tree attestation hashes sorted paths,
modes, symlink text and regular file bytes without following symlinks. The host
records the expected digest before service creation; the bootstrap verifies
the copied tree before mounting its opened directory. The runtime directory
is outside the sandbox and copied roots retain relative pnpm links. Focused
native tests pass. Full Ocean dependency closure and cold preset measurements
must be repeated with this copying launcher before qualification is complete.

## Private-copy preset rerun

Cold typecheck, lint and build passed with copied dependencies. The first test
run failed with EPIPE: --ro-bind-data made Node report its executable as
"/node (deleted)", so child self-execution failed with ENOENT. Executable
copies now retain their paths in the unit runtime directory until shutdown
and use read-only descriptor mounts. A native self-execution regression passes.

The test rerun exited 0 in 5.79 s, observed memory.peak 1113550848 bytes and
pids.peak 184, with untruncated output and confirmed cleanup. The earlier
copied-dependency runs measured typecheck 3.30 s / 708128768 bytes / 56 tasks,
lint 6.67 s / 1174491136 bytes / 60 tasks, build 3.39 s / 707084288 bytes /
56 tasks. The original limits remain sufficient for these observations.
