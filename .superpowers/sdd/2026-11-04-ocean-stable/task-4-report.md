# Task 4 — GitHub discovery, session authority and live read acceptance

Status: **DONE — implementation and live read acceptance passed; ready for controller independent review.**
Workspace: `/home/ryltsevmg/Projects/Ocean-stable`, branch `codex/ocean11-stable`.
Accepted base: `b5ac3fcaacb4f727e18f2679a1a8f7770eae7cb2`.
Sole implementer; no subagents or independent review performed here. Controller
review follows the implementation handoff. No push, merge, installation, owner
service/profile changes or GitHub writes were performed.

## Defects and repair

1. The GitHub descriptor lacked the fixed upstream catalog controls. The trusted
   host now sends `X-MCP-Tools: list_issues,issue_read` and `X-MCP-Readonly: true`
   at the exact shipped endpoint. Exact catalog validation still rejects extra
   and duplicate tools, and now also rejects a missing declared tool. No manifest
   widening, subset filtering or model-selected headers were introduced.
2. A connection change previously bumped generation/revoked grants while keeping
   the published schema, tools and identity. The existing transactional change
   now clears that authority and discovery consent too. Regrant without fresh
   exact-generation discovery is refused.
3. The SDK provisioning cache reused an old account after credentials changed,
   and SDK state vanished on restart while durable grants appeared executable.
   Each consented discovery now creates an isolated SDK host with an immutable
   credential snapshot and exact target binding. Published authority selects that
   exact context; invocation never provisions or discovers. Runtime startup and
   changed raw environment values make unproven authority unavailable.
4. The live driver synchronously spawned a CLI while owning the runtime event
   loop, and its provider fabricated a fixture-specific answer. Child CLI calls
   are now asynchronous. The deterministic provider uses actual approved tool
   arguments and returns actual tool content, including `issue_read.method=get`.
5. Real endpoint counters exposed two SDK recovery paths: modern
   `HEADER_MISMATCH` refreshes metadata/replays a call, and a warm HTTP 404 creates
   a new connection and repeats the request. Public `versionNegotiation=legacy`
   configuration avoids modern mirroring recovery. A generic adapter HTTP guard
   independently forbids invocation-time catalog requests and any second
   `tools/call`. Known 4xx refusals stay observed failures; lost/5xx replies stay
   uncertain. Only a proven zero-business-request guard refusal is not_started.

Official fixed-header documentation:
[GitHub server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md),
[remote endpoint](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
The prior owner-approved fixed-header probe remains separate prospect evidence;
this task exercised the shipped host composition and application path.

## Architecture rulings and costs

- **No persistent secret/revision storage.** Schema **19** and Task 2's accepted
  migration/backup/restore behavior are preserved. Fresh SDK sessions have no
  continuity proof. Under exclusive runtime ownership, one existing SQLite
  transaction increments the generation, clears schema/tools/identity/consent
  and revokes grants before business use. Cost: after a full runtime boot the
  owner enables the plugin if needed, explicitly consents, discovers and grants
  again. Client detach/reconnect does not revoke authority. Plugin CLI commands
  require the live owner; offline read composition does not repeatedly reset it.
- **Publication order.** Application ports expose synchronous readiness and
  opaque discovery receipts. The application validates the entire catalog and
  target, commits publication/revocation with the generation CAS, and only then
  activates the candidate SDK context under the resulting generation. A failed
  CAS or mid-discovery credential change cannot activate a candidate against old
  grants. Same-session grant preservation requires exact immutable target and
  raw credential continuity. Identity is never fabricated as verified.
- **Immutable admitted route.** Credentials live only in memory. A dispatched
  call keeps its original SDK host even while another account is discovered.
  Hosts are retained until runtime transport shutdown so a new discovery cannot
  close or retarget an admitted call; this costs one host per discovery pass.
- **Typed boundaries.** Domain remains pure, application uses plain typed ports,
  and SDK/Effect/AsyncLocalStorage/HTTP behavior stays in the adapter. No vendor
  SDK fork, package installation or lockfile change was made. The existing pinned
  SDK patch qualification remains intact.
- **Compatibility ruling.** The new `plugin.session-authority-v1` hello capability
  is a semantic requirement for plugin-capable owners. New shipped SDK clients
  reject an older plugin owner at hello before any commands. The capability
  bound is 65; the frozen shipped RC2 validator (bound 64) rejects the new owner's
  65-capability hello. Minimal non-plugin protocol-1 peers remain compatible;
  ACP is unchanged. Cost: upgrade shipped clients/runtime together. This is not
  a claim that all third-party clients reject the new owner.
- **MCP policy ruling.** The trusted descriptor explicitly selects the supported
  legacy negotiation option through a generic typed provision field. Initialize,
  initialized notification and stream setup are protocol setup; tools/list and
  server/discover are restricted to consented discovery. Modern-only servers
  needing discovery during invoke fail before business. The generic guard bounds
  SDK replay instead of silently relaxing one-attempt semantics. Future reuse of
  existing MCP servers remains the intent; general catalog import and qualification
  of other services are not implemented by this GitHub pilot.

## Regression evidence

- Initial focused RED reproduced missing headers, retained stale schema, raw
  same-reference credential swap and fresh-runtime stale readiness.
- Real loopback HTTP/SQLite/production-host tests cover account A → B, generation
  changes before/after discovery, direct regrant refusal, changed raw environment
  credentials, restart with zero automatic network, explicit recovery, concurrent
  generation/credential changes, schema publication's final generation, old
  in-flight account A while new B is admitted, identical rediscovery preserving
  grants only with continuity, invalid catalogs and scope denials.
- Reversible RED of the two hidden SDK paths proved actual duplicate business
  counters: modern HEADER_MISMATCH = **2** requests for one call; warm 404 = **2**
  requests for the failed call (3 with the successful warmup). Restored fixes:
  **29/29** focused tests passed across session authority, one-dispatch, real MCP
  counter and guard outcome/concurrency tests. No invocation metadata refresh.
- Earlier focused adapter/application/store/contracts checks: **128/128** passed;
  compatibility hello tests **4/4** and Desktop/TUI checks **9/9** passed.
- Self-review added an immediate same-reference credential swap during the first
  provisioning await. RED published a new account as ready under generation 1
  with zero revoked grants. Snapshotting before the first await, revalidating
  before SDK network and checking existing-session continuity fixed it. The
  regression proves zero metadata/business requests on that refusal and fresh
  consent/regrant recovery to account B. Final focused session/dispatch/crash
  check: **20/20** passed.
- QA driver/provider tests verify asynchronous child execution, byte-body request
  counting and real tool-derived answers: **3/3** passed.
- Strict test compilation remains the exact inherited **80** diagnostics, with
  zero added or removed diagnostics compared by path/code/message. This is not a
  clean full test-typecheck claim; the old debt is Task 4b. Production `tsc -b`
  passed. All changed source files remain at or below 300 physical lines.
- Final root gates: all passed; exact counts and commands are recorded below.

The first two root attempts exposed two old one-tool catalog fixtures (normal chat and
the process crash profile). Both now declare the full two-tool shipped catalog,
while granting only list_issues as before. The chat **3/3** and crash **2/2**
checks passed after that fixture correction; exact missing-tool refusal remains
enforced in production.

## Real GitHub acceptance

External evidence directory:
`/home/ryltsevmg/Projects/Ocean-artifacts/1.1.0-stable-evidence/github-task4`.
Passing report: `live-report.json`; sanitized stdout/stderr: `driver.log`.
Synthetic profile root: `/tmp/ogh-_0sv5_60/tmp/ogl-0LcDK1`.
All external evidence directories/files are 0700/0600. No real profile or
transcript is committed. Token values were read only into memory from the
owner-approved dedicated token file and supplied via the named environment
reference; gh credentials were never reused.

The passing run exercised the normal runtime owner, CLI plugin commands, grant,
ordinary room chat, durable operation journal and fresh-runtime recovery at the
actual `https://api.githubcopilot.com/mcp/` endpoint. Approved repository:
`ryltsevmikhail/Ocean`; existing issue **5**, marker **coral-lighthouse-11**.
Only list/read tools were dispatched; no GitHub writes.

| Case                                           | Actual business requests | Result                                             |
| ---------------------------------------------- | -----------------------: | -------------------------------------------------- |
| List issues                                    |                        1 | Actual response contained fixture marker           |
| Read issue 5                                   |                        1 | Actual response contained fixture marker           |
| Wrong repository                               |                        0 | Denied locally                                     |
| Wrong bot                                      |                        0 | No granted route                                   |
| Wrong room                                     |                        0 | No granted route                                   |
| Ungranted issue_read                           |                        0 | Denied locally                                     |
| After restart before owner recovery            |                        0 | discovery_required; schema cleared, grants revoked |
| Read issue 5 after new consent/discovery/grant |                        1 | Actual response contained fixture marker           |

Total **3 tools/call**, all HTTP 200, matching **3 durable observed/ok operations**
(generation 1, 1, 2). Two explicit discovery passes produced exactly the two
declared tools and identical digest
`66bfb58fa0cce6adfc9d568bd8bfd53058a5cc2e3c8b29a7d89209b8322c3036`.
There were **4 tools/list** requests across those two passes. Legacy setup used
**6 initialize**, **6 initialized notifications**, **6 optional stream GETs**
(GET returned 405). Startup and restart emitted **zero automatic requests**;
no invocation tools/list/server/discover or hidden business replay occurred in
the passing trace. Every request carried fixed tool/read-only headers.

SQLite `quick_check=ok`, no foreign-key violations. The restart view truthfully
showed `discovery_required`, no schema/tools/identity and revoked grants before
explicit recovery. Identity remained **unverified** throughout.

The repaired driver records two earlier failed fresh-profile attempts separately:
`attempt-1` had an observer bug (byte bodies were not counted) after one successful
read; `attempt-2` correctly exposed the SDK's 400 → metadata refresh → replay
(2 business attempts for 1 journal operation). Neither failure is counted as a
pass. Further live traffic stopped until local one-attempt regressions passed.
No unknown business outcome was retried by the driver. The earlier passing
run is retained in `attempt-3`; a new private-profile run after the credential
snapshot repair passed the same three-read matrix. A final local guard regression
also makes a pre-dispatch catalog refusal sticky, preventing SDK fallback from
sending a first business call afterward (RED/GREEN, 9/9 focused checks). That
refused recovery path was never taken by the passing legacy live trace.

Usage: **13 deterministic local provider requests**, **zero external model
requests/tokens/cost**. The approved GitHub token was the only external service
credential used. Exact secret scans found no token in generated profile files,
external evidence or process output. Source/Git scan and final gate logs are
recorded at finalization below.

## Limits and handoff

Actual CLI/runtime/chat path is qualified here. Desktop readiness/contract and
TUI formatting have source-level tests; installed GUI/TUI acceptance on a frozen
artifact is a separate controller gate. Genuine DeepSeek smoke is also separate.
No universal MCP server/catalog claim is made, and no account verification was
inferred from a successful token. The legacy negotiation/setup cost and required
manual recovery after runtime boot are explicit product limits.

Issue 5 stays unchanged by this implementer; the authorized operator may close
it after acceptance. Controller independent review is required before release.

## Finalization

Implementation commit: `ba778ee3f82c0df5176c1960e6d64e9009ace18e`
(`fix(plugins): bind GitHub authority to immutable SDK sessions`). This report is
committed immediately afterward as a separate documentation-only commit; both
commit IDs are returned in the controller handoff.

Required workspace-root gates were run sequentially under synthetic HOME and all
XDG directories, short TMPDIR, child umask 022, with no other heavy suite:

| Command                       | Result                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                  | Exit 0: typecheck + lint; source 2,212 passed / 44 skipped (384 passing files); process 129 passed / 35 skipped (35 passing files) |
| `pnpm build`                  | Exit 0                                                                                                                             |
| `pnpm format:check`           | Exit 0                                                                                                                             |
| Strict test-type comparison   | Exit 2 as inherited: exactly 80 old diagnostics, zero added/removed                                                                |
| QA Node driver/provider tests | 3 passed                                                                                                                           |
| Source line bound             | All changed source <=300 lines; maximum 297                                                                                        |
| `git diff --cached --check`   | Passed                                                                                                                             |

Logs: `root-check.log`, `root-build.log`, `root-format.log`, `test-typing.json`
and `test-typing.log` in the external evidence directory. Earlier failed gate
attempts are retained as `root-check-attempt-1.log` and
`root-check-attempt-2.log`; neither is presented as a pass. Native opt-in skips
remain skips, not qualified passes.

The final exact-secret scan covered 1,300 source/report files plus the complete
staged implementation patch; all results were false. `source-secret-scan.json`
records the counts. Generated profile/evidence/output scans also found no exact
token; directories/files are 0700/0600. The report is scanned again when staged.

Across four explicitly consented fresh-profile live runs, nine read requests
reached the endpoint: one in the observer-defective run, two in the SDK retry
exposure, three in the initial passing run and three after the snapshot repair.
Eight returned successful results and the SDK retry exposure included one known
400 refusal. All external model usage remained zero. No automatic retry was
introduced by the driver and no GitHub write was performed.

Outstanding release work belongs to the controller: independent review, frozen
artifact installed GUI/TUI qualification, genuine DeepSeek smoke and authorized
operator closure of issue 5. No implementation blocker is being waived.
