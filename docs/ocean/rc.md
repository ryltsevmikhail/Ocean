# Ocean 1.0 RC qualification

Qualified on BigPC on 2026-11-02. Q01–Q12 passed for the local Linux terminal product. The accepted candidate is **1.0.0-rc.3**. RC.1 and RC.2 are superseded by installer fixes. This is a release candidate acceptance record, not publication or production installation of 1.0.

## Immutable candidate

| Field                           | Value                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Source revision                 | `4417c38ae6c9474cb0c35e9d64ca7f327ac812bd`                                                   |
| Archive                         | `ocean-1.0.0-rc.3-linux-x64.tar.gz`                                                          |
| Archive SHA-256                 | `1a6f413b1d501a61bbeeb635c7d3bf24c29a06fbea509d86bdfd602c604d5dbc`                           |
| Lockfile SHA-256                | `6a10947f2e09cd54f75495f7d9bd49cd6d432f575606c8049e0f73cf6dc1ea1d`                           |
| Platform                        | Linux x86_64, kernel 7.2.9-arch1-1, local filesystem                                         |
| Node / build pnpm               | v26.11.1 / 12.16.1                                                                           |
| SQLite schema / snapshot format | 5 / 1; no schema change during RC                                                            |
| Source checks                   | 533 tests, typecheck, lint, build, formatting                                                |
| Installed contracts             | 527 tests in 85 files, including six real SIGKILL boundaries                                 |
| Live provider                   | DeepSeek, deepseek-flash; 15 short synthetic requests across RC rounds                       |
| Operator                        | Codex on BigPC; owner supplied a temporary test credential and authorized the request budget |

The archive and standalone installer are retained outside Git in `~/Projects/Ocean-artifacts/1.0.0-rc.3/`. The documentation commit containing this record follows the frozen source revision; it does not change the accepted archive.

## Gate results

| Gate | Result | Evidence and exercised behavior                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q01  | PASS   | Standalone installer into a fresh prefix under umask 077, outside checkout; exact version, offline demo, missing-profile doctor, initialization, doctor without a key, send without a provider refused without a fabricated answer.                                                                                                                                                         |
| Q02  | PASS   | Two persistent private rooms with distinct synthetic codes; separate CLI processes and real PTY TUI recover their own context. Installed context contracts verify the actual provider input excludes the other room.                                                                                                                                                                        |
| Q03  | PASS   | Live developer/reviewer handoff in a persistent group, shared note without dispatch, attributed replies, unknown recipient and conflicting recipient refused. An @mention in a bot response stays text and does not start another run.                                                                                                                                                      |
| Q04  | PASS   | Identical send returns the original receipt, changed send conflicts; real separate owner process causes CLI and backup to return owner_busy, doctor reports unavailable data. Installed admission contracts also exercise held rooms.                                                                                                                                                       |
| Q05  | PASS   | Installed child processes killed at accepted, dispatch, before claim, after claim, prepared, and publication boundaries. Recovery does not repeat dispatch; unresolved claim remains; complete long prepared answer survives without summary substitution. Claim injection is synthetic; conversation tools remain disabled.                                                                |
| Q06  | PASS   | Installed pre-dispatch and stream cancellation contracts, real-pipe cancellation while waiting for approval, unknown provider cancellation retained as refusal/cancelling rather than cancelled. Native pre-cancelled command creates no effect; an escaped descendant remains observable and the result stays uncertain. Test descendant is then explicitly cleaned up.                    |
| Q07  | PASS   | Installed SQLite contracts cover fresh, frozen older, future and corrupt databases, legacy claims, foreign keys, migration rollback and reopen after failure.                                                                                                                                                                                                                               |
| Q08  | PASS   | Installed room/admission/tool contracts cover foreign rooms, protected paths, links, stale previews, terminal control sequences, containment refusal and legacy restore entry points. Added profile-hardlink rejection. Live profile/backup and doctor checked for credential/canary absence; native child environment excludes provider/canary variables.                                  |
| Q09  | PASS   | Actual stdin/stdout JSON-RPC v1 client against installed CLI: handshake, session and streamed offline prompt. Installed agent in a separate process with a scripted provider: denied edit, approval cancellation and stream cancellation. All stdout frames parse as JSON-RPC; no denied edit executes. This qualifies the v1 protocol, not a separate desktop client binary.               |
| Q10  | PASS   | Clean installation, exact repeat, update, rollback to 0.1.0-m5.1 and update back to RC.3 using installed launchers under umask 077. Program switching leaves profile bytes unchanged. Verified restore, guard, live contextual text continuation in earlier rounds and final PTY-confirmed local note without a provider dispatch. 10,000-message restore preserves all snapshot positions. |
| Q11  | PASS   | 10,000 messages, cursor after 9950 returns exactly 50, 20 warmups and 100 timed storage queries; p95 **0.099 ms**, threshold 200 ms; database **5,537,792 bytes**. Context overflow refused before provider dispatch.                                                                                                                                                                       |
| Q12  | PASS   | Real DeepSeek private and group turns, CLI restarts, live TUI and final-candidate recheck. Usage persisted; final live profile has 13 usage records, zero unexpected tool calls. Final RC.3 used three newly authorized live requests; total across rounds remained 15.                                                                                                                     |

The 527 installed tests execute immutable compiled modules from RC.3. Tests and frozen fixtures are drivers from the checkout; runtime module imports and SIGKILL workers resolve to the installed release. Six source-only installer fixture tests run in the 533-test source gate. Fault injection uses scripted providers; real DeepSeek is used for the conversation and context gates, not repeated uncertain external effects.

## Backup and recovery measurements

On the 10,000-message synthetic database, backup → restore → doctor took **0.259 s**, with **zero missing messages relative to the snapshot** and final sequence 10000. A smaller live test profile took approximately 0.238 s. These measurements pass the test-set RTO target of 30 minutes; they are not a guarantee for arbitrary user data, hardware failures or a lost interval after a snapshot.

A restored profile remains restricted. Ordinary send, TUI and legacy task/ACP execution remain blocked; a new text-only CLI operation requires explicit TTY confirmation. An unknown earlier outcome is not cleared, replayed or certified stopped. Native process-tree containment is not qualified.

## Defects fixed during RC

- Live profile ownership now produces the documented CLI owner_busy/exit 3 while preserving the adapter's existing explanatory error.
- Profile checks reject hardlinked regular files before recovery.
- Packaging removes source-map references when maps are not shipped.
- Installer sets manifest program permissions independently of umask. Fully verified legacy private modes are normalized before switching, allowing subsequent rollback/update through older installed launchers. Modified content, broader permissions and unrelated launchers remain rejected.

Each behavior fix has a regression test. Earlier failed rounds are retained in private evidence; only RC.3 is accepted.

## Evidence and release decision

Private evidence and synthetic test profiles are retained on BigPC under `~/.local/share/ocean-rc/2026-11-02/`. The evidence directory contains the summary, installed-contract log, raw Q11 timings, operation timings and stdio/native outcomes. Neither credentials nor transcripts are committed. The temporary credential file was deleted after the final live requests.

**Decision: RC gates passed; ready for the owner's 1.0 release decision.** No production deployment, public release tag or 1.0 distribution was performed. To release, preserve this exact artifact and checksum, follow [operations](operations.md), record the actual installation and smoke result, and obtain the owner's release authorization.
