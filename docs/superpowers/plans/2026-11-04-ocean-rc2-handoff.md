# Ocean RC2 — handoff for a fresh session

Snapshot: 2026-11-04, Europe/Moscow. This is a continuation, not a restart of Ocean 1.1.

## Binding entry points

- Repository: `/home/ryltsevmg/Projects/Ocean`, remote `https://github.com/ryltsevmikhail/Ocean`.
- Working branch: `codex/ocean11-sandbox`; use clean isolated `codex/*` worktrees for implementation.
- Last implementation/acceptance checkpoint before these planning docs: `640fb2aff9a3353ecff1d3f578a2707cc5dca065`.
- Read actual `git status`, history, worktrees and remote refs before acting. Do not assume the planning commit or current local commits are pushed.
- Spec: `docs/superpowers/specs/2026-11-04-ocean-rc2-design.md`.
- Plan: `docs/superpowers/plans/2026-11-04-ocean-rc2.md`.
- Contributor rules: `AGENTS.md`; original Ocean scope/history: `docs/ocean/v1.1.md` and `docs/superpowers/plans/2026-11-02-ocean-1.1.md`.

## Approved RC2 priorities

1. UI provider connection: key management/check, model selection and real status.
2. Everyone: one answer from every participant, no automatic bot-to-bot rounds. Separate Note.
3. Actual images: photo/diagram/screenshot understanding through DeepSeek Flash; OCR is not the requested substitute.
4. Executor + shipped GitHub plugin + named connection + bot/room/repository grants + read issues in normal chat.
5. Ready Desktop audit 4–6; composer at 1024 must remain accessible.
6. Whole-branch review, consolidated fixes, checks, artifacts and safe installed RC2 update.

GitHub comment writes, OAuth/PKCE and a second service remain later plugin stages. Do not silently describe the whole plugin roadmap as complete after a read-only pilot.

## Already accepted — do not restart

Ocean 1.1 stages 1–6 are implemented. Linux sandbox, task authority/worktrees, immutable changesets, exact approvals, review/application and recovery/backup have extensive independent/native qualification. Task history and precise accepted commits are in the original implementation plan.

- 7.9 restored-profile rebind/format-2 lineage: accepted `f6d2159`.
- 7.10 task finalization/lease release: accepted `0c086b4`.
- 7.11 crash-boundary matrix/signal non-pass fix: accepted `04b1ed3`.
- 7.12 installed Linux: accepted private revision `68ed6cc`, integrated product tree `249ce41`; artifact H SHA `c4d89b62808fd506c96275b8571d0003dbddeafb0b2358db879614ea368b82db`. Whole native source suite qualified through three bounded, separately approved presets with proven coverage; one-shot whole-suite attempts remain nonpassing. Do not weaken 60 s / 2 GiB / 256 tasks / 32 KiB limits.
- Desktop audit parts 1–3: `0bc29c5`, `d3c4ab6`, `e4901e1`, integrated merge `1f56b08`.
- Green check/reconnect fix: `387a29c`. Only connect-phase `endpoint_exists` is retried; no added operation replay. Heavy recovery tests have measured finite outer budgets.
- 7.13 actual current Desktop and independent standalone Linux binary: `bab99d9`, reviewed startup-failure cleanup fix `17fcbc7`, acceptance note `0333f8c`.
- 7.14 real DeepSeek: `4076171`, acceptance note `640fb2a`, independent review clean, no findings. Exact RC1 archive comes from clean `0333f8c`, not the later QA-only commit.

RC1 live results: 22 genuine API calls, all HTTP 200/SSE complete; 55,894 input + 7,534 output = 63,428 tokens match all 22 durable usage events, unknown 0. Full Ocean clone: exact denials, real sandbox failed/pass tests, real seeded review finding, repair, stale-review refusal, fresh approval, separate denied/confirmed application and actual packaged Desktop text attachment. Initial SSH transport kept the key on BigPC; this is accurately scoped, not a native saved-key claim.

Final clean tracked RC1 gates: source 1610 passed /42 skipped; process 109 passed /35 skipped; build/format passed. Nine local transport tests passed. Original working-tree configuration adds 73 private atlas tests (1683 source passes in the earlier original-tree check); never copy or stage that private config to inflate release coverage. Native skips are not passes.

The final whole-branch review has NOT run. A package was prepared before RC2 was requested, but no reviewer was dispatched. Run the actual final review after RC2 tasks, not a redundant RC1 final-review wave now.

## Current installation — real user state, not a disposable fixture

The owner explicitly requested installation, then explicitly requested adding the DeepSeek key locally.

- Menu: **Ocean RC**; launcher: `/home/ryltsevmg/.local/bin/ocean-rc`.
- Installed root: `/home/ryltsevmg/.local/opt/ocean-rc/releases/1.1.0-rc.1`, with `current` symlink.
- Standalone ASAR SHA: `2479327c2b3d400edc547e634472b5e4fc1b2296444be6b7e4acb88e6ccdb0ee`; pinned local Node26.13.0 copied into release.
- CLI RC1 archive SHA: `52167fe7f660221b65de42fcb89932ee441cd254ff1427e2f7acade3e9b6ccf8`; runtime source `0333f8c`.
- Persistent user profile: `/home/ryltsevmg/.local/share/ocean-rc/profile`; Desktop userData: adjacent `desktop`.
- User service: `ocean-rc-runtime.service`, config `/home/ryltsevmg/.config/systemd/user/ocean-rc-runtime.service`, Restart=no. It stays independent of window closure.
- Private runtime IPC directory: `/run/user/1000/ocean-rc`.
- Local key source: `/home/ryltsevmg/.config/ocean-rc/deepseek.env`, mode0600, parent0700. Do NOT print/read into tool output, commit, copy into a profile/backup or ask the owner to paste the key. Systemd passes it to the stock production provider via EnvironmentFile.
- Stock direct HTTPS is active: no SSH transport is needed by the installed app. The additional installation smoke completed `tr_4f93133de7394009a768ddca6da97985`; it is one separate call, not part of the 22 RC qualification calls.
- Evidence/metadata: `/home/ryltsevmg/ocean-rc-install-evidence` (private, not Git). Never read `/proc/*/environ` or secret-file contents into logs while inspecting the installation.

The application and runtime were left open for the user. PIDs may have changed: inspect exact owned identity instead of reusing old PIDs. Do not stop/kill/reset/recreate the profile for tests. Before update, prove quiescence through public status/runs/decisions and a confirmed public stop; preserve unknown state and any user work. Prove compatible data rollback on disposable profiles before migration. Ocean1.0 and existing DSH Ocean remain separate and untouched.

## Protected original working-tree positions

These eight positions predate the current work. Preserve them byte-for-byte, never stage/reset/stash/clean/format them automatically:

- `tsconfig.json`
- `vitest.config.ts`
- `Ocean.pen`
- `design-assets/`
- `docs/ocean/executor-research.md`
- `docs/ocean/plugins-dsh-code-review.md`
- `docs/ocean/plugins-research.md`
- `docs/superpowers/plans/2026-11-02-ocean-service-plugins.md`

Their 70-file SHA manifest is `/home/ryltsevmg/ocean-pre-design-merge-yy589w06/hashes.json`. Preserve new unrelated changes too. The plugin plan and supporting research are intentionally untracked owner documents: read the original absolute paths when isolated worktrees do not contain them. Do not automatically add them to Git.

## Desktop audit ownership

Branch `design/desktop-audit-fixes`, worktree `/home/ryltsevmg/Projects/Ocean-design-fixes`. Last observed HEAD `e4901e1`, clean; parts4–6 not yet present. Inspect actual state because another session owns that flow. Keep its branch/worktree. Merge only ready commits; preserve runtime-recovery plus status/error fields on conflict. Do not replay parts1–3 or redesign the separate audit.

## Publication and authorization

The owner already authorized local commits, push/main merge, release preparation and unrestricted DeepSeek requests. Do not ask for these again. This authorizes scoped work, not arbitrary use of another app's credentials or unrelated GitHub writes.

- Verified GitHub main: `c4fb94f167dc9204048e3089f488de5ef1550bd8`, PR3 merged with head387a29c. Newer local accepted QA/docs are not assumed pushed.
- Active gh account Ryltsevmg previously had no push permission. Existing locally stored owner account ryltsevmikhail has push/admin and was used successfully. Do not switch global auth or copy credentials from another machine.
- Use owner token only in subprocess memory: `gh auth token --user ryltsevmikhail`, captured without printing; child GH_TOKEN; Git credential helper `gh auth git-credential`. Never print tokens or environment. GitHub connector create-PR returned integration403, so authenticated local gh is the known working fallback.
- Merge with expected head SHA; verify remote merged state and fetched commit/tree. No force push, silent branch deletion or unstated release claim.
- No development on BigPC. Existing SSH alias bigpc is available, but the installed app now has its explicitly requested local key. The original remote key remains unchanged.

## Evidence boundaries and final-review carryover

Prior private qualification directories remain retained, including unknown effects. Never delete them merely to free space or force a backup. Earlier six failed GUI fixtures were relocated without a pre-copy manifest; they are forensic-only, not identity/alias proof. Final accepted GUI fixtures were fresh, unmoved disk-backed roots.

Root native tests have filesystem assumptions: a disk-backed TMPDIR produced EXDEV/binder/timestamp fixture failures; the same focused43 tests and full final gates passed in a short private tmpfs directory. Keep HOME/all XDG synthetic for tests, use a new owned short `/tmp` fixture for those gates, and leave actual GUI/live data on disk. No global /tmp cleanup or OS modification.

Before final review carry all deferred decisions/minors, not just the latest task report. The RC2-owned scratch dossier `rc1-review-carryover.md` contains the chronological extract. Known items include two 305/304-line test files, broad test-typing errors still requiring classification against v1.0.0, historical planned/implemented docs, native diagnostic noise, cleanup helpers/provenance and finalization/crash test minors. A task-local “pre-existing” label is not a waiver for a defect introduced somewhere in the complete branch.

Final review uses `v1.0.0..RC2`, most capable model, one consolidated fix wave and one scoped re-review; record all residual rulings and their cost honestly. Current notes and test matrices are available in committed docs. Do not infer power-loss or remote-cancellation proof from happy-path acceptance.

## Fresh-session instruction

Read this handoff, spec, plan, AGENTS and the supplied plugin plan. Reconcile actual state, then execute the approved RC2 plan using subagent-driven development, one implementer followed by task review. Do not spend the night rediscovering accepted RC1 work or asking for already given permissions. Continue independent useful work around an external blocker; preserve and report it rather than bypassing authority, isolation or uncertainty.
