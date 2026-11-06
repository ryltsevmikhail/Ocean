# C18.5.2 exact service confirmations

Status: **DONE_WITH_CONCERNS**. Exact service confirmations are implemented and committed. Final gates retain only the explicitly protected catalog3/format2 debt; no new failure remains. Acceptance requires the controller's independent review of `4545011e558f0eeab3f5d047e0a5454cdd4b9b94..HEAD` before C18.5.3.

## Scope and implementation

Worktree `/home/ryltsevmg/Projects/Ocean-stable`, branch `codex/ocean11-stable`; BASE `4545011e558f0eeab3f5d047e0a5454cdd4b9b94`. The canonical brief was read first. No helper agent, reviewer, push, merge, new permission engine, second owner instance, decision/receipt database, SDK wrapper, lifecycle engine, credential-store change, legacy conversion, Executor removal or GUI change was made.

The public application API adds optional trusted `ServiceCallAdmissionOptions.confirmation: ServiceCallConfirmationPort`; CLI composition exposes `RuntimeServicesInput.confirmation` and `RuntimeOptions.serviceConfirmation`. Its runtime-only method is `confirm(operation, signal, current): Promise<DecisionOutcome>`. `openOceanProfile` carries the trusted option into `composeRuntimeServices`. The normal host's closure calls `RuntimeDecisions.service` after profile composition, sharing the existing single `RuntimeOwnerDecisions.owner` with coding/review/restoration/finalization. No wire/model flag supplies confirmation authority.

The descriptor owns a structured clone before recursive freeze. It contains the request with only `catalogId` omitted, full frozen `configuration`, full frozen tool `definition` including provenance, and full exact `ToolEffectAdmission` with only `binding.catalogId` and `binding.configRevision` removed. Scope, effectKind, grant reference, resolved GitHub IDs, payloadBytes, trust/credential revisions and all remaining binding fields stay present. Credential material, handles/references and model-provided permit flags do not enter the descriptor. Private connection facts, including credential reference/binding and trust facts, are compared privately rather than exposed in the preview.

`service-admission-prepare.ts` extracts the existing C3 checks without replacing them. Autonomous calls retain their original single synchronous prepare+claim transaction and no owner card. A confirm call validates first, captures canonical semantic/private-authority strings before awaiting the owner, then waits outside any SQLite transaction. `current()` performs fresh synchronous admission inside its own short transaction. After an allowed live response, the claim transaction selects the current published catalog only if every captured semantic/private authority fact still matches. It builds request and admission together from that current tuple and passes the full admission to the existing claim. Its journal admission and fingerprint therefore bind the actual catalog/configuration snapshot. An unchanged-definition metadata refresh may succeed before claim; route/trust/credential/full-definition/scope/resolved-ID/grant changes invalidate. Missing trusted port returns `confirmation_required`, with zero claim/send.

The canonical strings are captured once. A late correction was required because recomputing the original side from aliased classifier output could follow an in-place resolved-ID/resource mutation. Both mutations were reproduced before the correction; the final comparison uses the captured immutable descriptor and private-facts strings. Adapter-owned maps/resources remain mutable, while the operation shown to the owner stays frozen and unchanged. The existing final SDK dispatch guard checks journal ownership, run/attempt, grant limits, current authority and conflicts; confirmed calls additionally compare full semantic facts. Existing autonomous and postclaim metadata-refresh refusal behavior remains. A claim-refused result remains uncertain in the model-facing tool layer; earlier possibly sent effects are never labeled not_started or retried.

Owner IDs are `service-` plus SHA256 of JSON `[workspaceId, roomId, taskRunId, attemptId, invocationId]`. The model's raw/truncated ID is not used as a durable owner decision ID. Existing `ownerPreview` preserves reversible controls, stores the entire operation and derives `bindingDigest` from the entire preview. Owner `createdAt` uses the existing owner clock and `expiresAt = createdAt + 300000`. The business timer (default 30000 ms) starts after approval and claim. An injected 20 ms business deadline test waits 30 ms for approval and still dispatches after a coherent unchanged-definition refresh. No discovery occurs inside confirmation or business invocation.

The existing durable insertion, live waiter, version/digest checks, CAS/current check, abort and drain paths remain the only decision authority. Duplicate ID insertion cannot replace a preview or install a second waiter. Stored allowed/interrupted cards after restart remain facts and cannot reconstruct a live permit. Client detach leaves the waiting operation live. Stop/abort retire a waiting operation through the existing owning run signal.

## Capability and client compatibility

`OwnerDecision` and validated `LocalDecision` add `service-call`; `LOCAL_SERVICE_CONFIRMATIONS = 'decisions.service-v1'` is advertised by the current shared `LocalRuntimeClient`. The server negotiates it independently of plugin, model and service-settings features, masks identity/status for historical clients, and carries `serviceConfirmations` in the existing immutable runtime wire context to decision dispatch. Historical list/get/preview/resolve explicitly return `service_confirmation_upgrade_required` when their result/operation would expose a service card. They do not coerce a kind or return a false empty list. Old kinds keep the existing methods and behavior.

Existing shared full-preview chunk/SHA256 validation accepts the new kind through the updated contract. The normal-host proof reads identical previews larger than 32768 characters from two authenticated clients, including reversible bidi escapes. The current TUI's generic complete-preview panel needs no new UI; its affected tests pass. Desktop still exposes pending IDs and its UI/IPC remains C18.5.3; this is not GUI acceptance. Cohesive settings dispatch moved into the existing `settings-hosts.ts` to leave `host.ts` at 297 physical lines.

## Behavioral evidence

All test executions and root gates used the unchanged private runner: `python3 .superpowers/sdd/2026-11-04-ocean-platform/run-private.py ...`. It creates private HOME/all XDG/TMP with a minimal environment and removes those synthetic roots afterward. Intermediate static TypeScript/ESLint/Prettier commands also ran directly; they do not execute profiles. Node `v26.13.0`, pinned pnpm `12.16.1`. Evidence root: `/home/ryltsevmg/Projects/Ocean-artifacts/c18.5.2`; failure history is retained, not overwritten or sealed.

| Evidence                                                       | Command after private-runner prefix                                                                                      | Actual result                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial admission RED, before production edits                 | `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/service-call-confirmation.test.ts`      | `red-admission.log`: 1 failed; expected observed, received undefined because original confirm gate refuses. The shell wrapper then printed the log and exited 0; this is not a test pass.                                                                            |
| Initial admission GREEN                                        | same admission file plus `packages/store-sqlite/src/service-call-admission.test.ts`                                      | `green-admission.log`: 11 passed/2 files. The following intermediate TypeScript build in the same shell initially failed on incomplete host wiring and was subsequently fixed.                                                                                       |
| Normal-host GREEN                                              | `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-confirmation.test.ts`          | `green-socket.log`, start 06:57:06: 2 passed, autonomous and confirm.                                                                                                                                                                                                |
| Hosted negative control, after implementation                  | same host file with `-t 'normal host confirm'`                                                                           | `red-socket.log`, start 06:57:18, exit 1: no pending card after removing only the trusted host `serviceConfirmation` wiring. Exact bytes were saved as `host-green.ts` and restored. This is an unwiring negative control, not an initial before-implementation RED. |
| Owner failure/race controls                                    | admission, host confirmation, host controls and client compatibility files                                               | `green-controls.log`: 39 passed/4 files; two actual owner clients, identical full descriptor/preview/digest and concurrent reply winner; stale digest/version and wrong room/run refuse.                                                                             |
| Identity/replay controls                                       | `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-confirmation-identity.test.ts` | `identity-first.log`: 2 passed. Exact-repeat returns one live promise/card/claim; changed same model-ID payload refuses; duplicate waiter insertion preserves original preview; allowed/interrupted stored rows create no permit.                                    |
| Affected source integration, before immutable-alias correction | explicit 15 files listed below                                                                                           | `final-scoped-source-green.log`: 84 passed/15 files, exit 0. This is a prior source pin, not the final aggregate.                                                                                                                                                    |
| In-place resolved-ID RED                                       | admission file with `-t 'rechecks resolved-ids'`                                                                         | `red-resolved-ids-behavior.log`: exit 1, current incorrectly true after in-place ID mutation. `red-resolved-ids.log` is an earlier missing-fixture-declaration error, not behavioral RED.                                                                            |
| In-place otherwise-allowed scope RED                           | `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/service-confirmation-mutable.test.ts`   | `red-mutable-scope.log`: exit 1, current incorrectly true after alpha→beta mutation; original cloned preview/digest stayed unchanged and adapter facts were not frozen.                                                                                              |
| Immutable-facts and compatibility GREEN                        | admission, mutable scope, model negotiation, plugin compatibility and tools-node plugin hello compatibility files        | `green-immutable-and-compatibility.log`: exit 0, 27 passed/5 files. Both mutable-fact controls now refuse with zero claims/sends.                                                                                                                                    |
| First affected crash process proof                             | `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-confirmation-process.test.ts` | `process-first.log`: 1 passed/1 file, exit 0; prior source pin.                                                                                                                                                                                                      |

The 15-file source command expanded: `packages/store-sqlite/src/{service-call-confirmation,service-call-admission,service-allowance,service-eligibility,service-resource-admission,service-task-scope}.test.ts`, `apps/cli/src/local-runtime/{service-confirmation,service-confirmation-controls,service-confirmation-identity,service-owner-runtime,client-compatibility,decision-boundaries,decision-stores}.test.ts`, `packages/tools-node/src/local-decision-client.test.ts`, `apps/cli/src/ocean/room-tui-decisions.test.ts`, all passed to `pnpm exec vitest run --config vitest.source.config.ts`. The 5-file correction command used `packages/store-sqlite/src/{service-call-confirmation,service-confirmation-mutable}.test.ts`, `apps/cli/src/local-runtime/{model-negotiation,plugin-compatibility}.test.ts`, `packages/tools-node/src/local-plugin-compatibility.test.ts` with the same source config.

Failure controls cover absent port, deny, expiry, invalidation, interruption, abort, stop, grant revoke/limits, route/trust/credential/definition/provenance/scope/resolved-ID changes, same-definition refresh success, and allow then revoke during actual SDK preparation. They assert zero sends on refusal and distinguish zero preclaim rows from the one claimed/not_started preparation case. Request `allowed`/`confirmation`/`owner`/`permit` fields are invalid input and produce zero card/claim. The positive scripted provider parses actual returned `structuredContent.version === 'alpha'` before producing its one answer; a tool error cannot emit a fixed success.

Development failures remain in `socket-first.log` (strict expectedVersions fixture), `socket-second.log` (history author field assertion), `controls-first.log` (route trust revision fixture and cancelRun method), and `final-scoped-source.log` (attempted parsing of an already hashed journal fingerprint). Those fixture/assertion errors were corrected without relaxing production rules. The journal test independently hashes the current request and actual admission and verifies the catalog/config/trust/credential tuple.

## Root attempt provenance and final gates

The first broad root attempt began before the immutable-alias correction. Production bytes stayed fixed for its lifetime, but test files were edited while it was in flight; this is mixed test-WIP/pre-alias-production evidence, not an exact final revision aggregate. `root-check.log` exited 1 after production/test typechecks and lint: 3724 passed/18 failed/44 skipped, 555 passing files/5 failing/17 skipped. Failures were protected catalog3, ten transient missing-declaration fixture errors in the newly edited control, and five compatibility expectation updates for the negotiated new capability. `root-build.log` exited 0. `root-format.log` exited 1 only for protected foreign2. No failure is masked as accepted debt. The final frozen-byte gates below supersede that attempt after both immutable-facts REDs and the compatibility corrections.

All four final commands used the private-runner prefix and the unchanged source hashes listed below:

| Final command                                                                                                                                                                     | Exit and result                                                                                                                                                | Evidence                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm check`                                                                                                                                                                      | **1**, production typecheck, both test typechecks and lint pass; **3740 passing/3 protected failing/44 skipped tests**, 560 passing/1 failing/17 skipped files | `root-check-final.log`, `root-check-final.exit`; source start 07:09:15, duration 124.13s |
| `pnpm build`                                                                                                                                                                      | **0**                                                                                                                                                          | `root-build-final.log`, `root-build-final.exit`                                          |
| `pnpm format:check`                                                                                                                                                               | **1**, exactly the two protected foreign files                                                                                                                 | `root-format-final.log`, `root-format-final.exit`                                        |
| `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-confirmation-process.test.ts apps/cli/src/local-runtime/service-owner-process.test.ts` | **0**, **2 passing tests/2 files**                                                                                                                             | `process-final.log`, `process-final.exit`; start 07:11:32                                |

Root process stage was unreachable because `pnpm check` stops at the three protected source failures; both affected process controls were therefore run separately after the final successful build. No tests were skipped/excluded to obtain those results. The existing configured skips are reported as 44. `git diff --check` passed. Final source hashes, physical line counts, protected SHA256 bytes and empty pre-staging state were checked before the source commit. Only the 31 owned source files were staged; foreign bytes/index states remained unchanged.

## Interprocess effect and recovery boundary

`service-confirmation-process.test.ts` keeps the same observing synthetic HTTP peer alive across both real owner child processes. The peer's tools/call handler reads SQLite before handling the accepted effect and sees exactly one `started` claim. Metadata requests are counted separately from business requests/effects. Its response stays held while the first owner is SIGKILLed after one accepted effect and before result settlement. The parent records actual exit `{ code: null, signal: 'SIGKILL' }` and `confirmedStop: false`; no first-owner stop response is invented.

After restart, two new authenticated clients see the original decision ID, full preview/digest, receipt/run/attempt/invocation journal identity and uncertain run/journal outcome. Re-resolving the original allowed card, including cancel choice, preserves that factual allowed row and creates no new permit/effect/model request or confirmed cancellation. Re-submitting the original request returns its original receipt. Final counters: one business request, one accepted effect, one model request; two metadata listings (one for initial enrollment and one startup refresh). The second owner reports its actual stop response `state: stopped, outcome: complete`; this does not change the earlier external outcome from uncertain.

Actual final process evidence, from `process-final.log`:

```json
{
  "scenario": "service-confirmation-sigkill",
  "firstOwner": {
    "code": null,
    "signal": "SIGKILL",
    "confirmedStop": false
  },
  "secondOwner": {
    "stop": {
      "instanceId": "fde814ad-05ed-4acc-b3c9-e198af0a1ac5",
      "state": "stopped",
      "outcome": "complete"
    }
  },
  "decisionId": "service-c7f38d0740dc155acdc1eed8b41c2634655b40f8fb8c1c30515bd595f6b6fd6b",
  "runId": "tr_ffd38fdd92084dd9babee7cb999006f7",
  "journalIdentity": {
    "id": "service_e1bcd944a710aff7925c11bca830f4fa07db28176d0dea934ad901d095391738",
    "taskRunId": "tr_ffd38fdd92084dd9babee7cb999006f7",
    "attemptId": "tr_ffd38fdd92084dd9babee7cb999006f7_at_0001"
  },
  "peerClaimAtRequest": "started-before-response-and-effect",
  "businessRequests": 1,
  "acceptedEffects": 1,
  "metadataRequests": 2,
  "modelRequests": 1,
  "recoveredOutcome": "uncertain"
}
```

The second affected process control also passed its independent client/lost-reply/owner-restart receipt proof: `{"scenario":"owner-receipt-restart","receipts":1,"connections":1,"replayed":true}`.

## Protected state and limits

Foreign files and staging are preserved:

| File                                           | SHA256                                                             | Original state                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/cli/test-fixtures/github-session-rig.ts` | `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` | modified unstaged; index `b3ff4f26b9f1fd0a66ce72776474eccd81867b34` |
| `apps/cli/src/plugin-catalog-lifetime.test.ts` | `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3` | untracked, no index                                                 |

Runner SHA256 stays `adc3adf372fa77a694f4a4272a5f13e615646886356e1db0045767dad0d228a3`. No stash/reset/clean, foreign staging change, default Ocean/design worktree change, released installation/profile/launcher/unit change, credential read or real external provider/model/service use occurred. LICENSE and NOTICE are unchanged. Linux x86_64/Omarchy remains the target; native/ready-server/live/current installed/package/GUI qualification is deferred to 18.6/F. OpenAI/Anthropic live use remains explicitly deferred. No unchanged native/ready-server/live/GUI matrix was repeated.

The three protected catalog tests remain deferred to 18.6: “uses the published catalog beyond the SDK TTL without automatic discovery”, “does not refresh an explicitly stale SDK catalog outside owner discovery”, and “cannot let a delayed stale refresh outlive the foreground invocation”. The formatter debt is exactly the two protected files above. Source stays strict, application imports domain/public ports only, adapters and CLI access package public entries, and all 31 owned TypeScript files are at most 297 physical lines. Source hashes were frozen before the final gates in `final-source-pins.json` and verified again afterward.

## Owned source pins and commits

| Owned TypeScript file                                              | Physical lines | SHA256                                                             |
| ------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------ |
| `apps/cli/src/local-runtime/capabilities.ts`                       | 46             | `9c5eb778430d102db3124f5b1faa186e2d7d186110cecda054bc9c058b056d59` |
| `apps/cli/src/local-runtime/client-compatibility.test.ts`          | 116            | `1aee65604549d4cefab3e152b94ed7e4173fc2b27f96c88056221ee78ba0a9c2` |
| `apps/cli/src/local-runtime/client-compatibility.ts`               | 45             | `cc933abd87d25d4c21ff241ddc502f850f6e5baba67da2e80c93597049c3561a` |
| `apps/cli/src/local-runtime/decisions.ts`                          | 219            | `206428446dc5a9de454b8a253cd02d3370f47293a313a77c4b781783feb2abb3` |
| `apps/cli/src/local-runtime/host.ts`                               | 297            | `5d9009405f0ed97d2e2c266802dc1359d45ca4cabed402c66a3b250db4dcf5cd` |
| `apps/cli/src/local-runtime/model-negotiation.test.ts`             | 31             | `976fc164491c609624c097d7f530b779ff7d972d7ee89fd9017510f44111fa71` |
| `apps/cli/src/local-runtime/plugin-compatibility.test.ts`          | 21             | `039752fd239af20b339d17f53ceb357c73df38713ef1072a1d2edbcd20258432` |
| `apps/cli/src/local-runtime/server.ts`                             | 194            | `0f9d2379f1b307b74e6fa192076ec556b7612a3d11b6054c207d1b32420517dd` |
| `apps/cli/src/local-runtime/service-confirmation-controls.test.ts` | 139            | `60ee679b1ee6a2783a5002a65e0e29dd6e168481d19161940974138e543e0d12` |
| `apps/cli/src/local-runtime/service-confirmation-identity.test.ts` | 143            | `f145ef92f49694b08a161cb330779747f24726218bdd06da534e34728c7285f2` |
| `apps/cli/src/local-runtime/service-confirmation-process.test.ts`  | 150            | `f989f169a559dd5ffd013df32473dcf6da6a0b7ae0b60edab69bdeefbfb791c0` |
| `apps/cli/src/local-runtime/service-confirmation.test.ts`          | 113            | `d2010b8a40ffc6a06e1e7a836a91093c67d31d870bc6eda569e87342f0e6efd9` |
| `apps/cli/src/local-runtime/settings-hosts.ts`                     | 87             | `8ac4f6dc136b7d36f9f6106e96be255832be3368a686ebbe5ac4d25d9ae5d15e` |
| `apps/cli/src/ocean/profile.ts`                                    | 59             | `81d6b1a038d3f7a9f3eada87e44d08dd519dced9ecc8cbb2a086131200f35445` |
| `apps/cli/src/runtime-services.ts`                                 | 244            | `89730dfb48f6e352bf34290d554d7de2c94a316ce4ed1c08c33463d743cf8b69` |
| `apps/cli/src/runtime-types.ts`                                    | 123            | `c478e0b109d30233e83e6130af5f578d729fb0256e48a0f3ad86264817a99dff` |
| `apps/cli/src/runtime.ts`                                          | 292            | `177945ca969c4f7dbea37e1c0569e8affc4f785f672686178da32f7dd3df5d93` |
| `apps/cli/test-fixtures/service-confirmation-owner.ts`             | 37             | `de31c514d27cd6c1ce64438586bd8fcb17fd27ebcca115e29732cd0231a66429` |
| `apps/cli/test-fixtures/service-confirmation-rig.ts`               | 115            | `4fbad1ccb02f7b2b527d93a8910bdfb7dba867a2f15e756d0b6fa8dc534a989f` |
| `packages/application/src/owner-decisions.ts`                      | 191            | `1c072f45a113eae7db15ddd564b00cde3f5807378dae491172c0f7918a7fd7ef` |
| `packages/application/src/service-admission-prepare.ts`            | 126            | `3739fb02225fc24d191fa671da8a5d7ffa3c3a0dd1c1807a6680f188f97556c0` |
| `packages/application/src/service-admission-types.ts`              | 79             | `5a07daad59d1fa48dbd23a2d134a9b4a78f1fe403424715665e731942dea8098` |
| `packages/application/src/service-admission.ts`                    | 186            | `8612a22a1f3366c57a2960cfdd8f4ac75d98b79adc72d5760af76708ae831aa6` |
| `packages/application/src/service-confirmation.ts`                 | 77             | `9760e046c4f4c8ec28a01b1827b4341a93335a637f3890098b9de474967e300f` |
| `packages/contracts/src/local-runtime-decisions.ts`                | 167            | `7048fcd8caabcf42685a8dea01662c8b10e5b683b17eb57b311973c70c2b6df9` |
| `packages/integrations-mcp/src/prototype-http-fixture.ts`          | 227            | `a233853b9ce3261e24eb39602189f130843e8261f6a4571b8ce655aaea73c2fa` |
| `packages/store-sqlite/src/service-call-confirmation.test.ts`      | 288            | `3d439c99e2a2f39488993c57b9d66756fc2c4b147cb1b0aa1ba8f2c0265a9946` |
| `packages/store-sqlite/src/service-confirmation-mutable.test.ts`   | 82             | `b565efec29879558c3fcc646fee930d18b151815bb8dcad0e5394b68b212aa21` |
| `packages/store-sqlite/test-fixtures/service-call-rig.ts`          | 95             | `3efe015e63434b30f630d0d9a9f000e0f7d0276f65e6d989d013f9a87d93699a` |
| `packages/tools-node/src/local-plugin-compatibility.test.ts`       | 85             | `db9329add79535aa1a1c919acf6d5442480d7d94dd87b8738443bf25d20ff63a` |
| `packages/tools-node/src/local-runtime-client.ts`                  | 258            | `701d3811c0b1c1ab6a31636054382dc335ee7854ca85c1307b41d6f610fac3c0` |

Source commit: `7b95d5830b075d6a7855609f389f3466a37281d5` — `feat: confirm exact service calls through durable owner decisions`. It owns all 31 TypeScript files above and no protected file. The complete review interval begins at BASE, not HEAD~1.

Report commit is the following dedicated documentation commit; no push/merge was performed. Controller independent review and task acceptance remain pending.
