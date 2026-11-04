# Live DeepSeek release-candidate qualification

Workpackage 7.14 qualified the installed Linux CLI release candidate and one
packaged Desktop text-attachment turn on 2026-11-04 (local time). This is evidence
for `1.1.0-rc.1`, not publication or acceptance of a final 1.1.0 release. Independent
review, the remaining Desktop audit and final whole-branch release gates remain
separate.

## Frozen candidate and transport

The existing release packager built a clean
`0333f8c3fcdd53d23e0be559731449f27dd0ab43` checkout with Node `v26.13.0` and pnpm
`12.16.1`. Archive `ocean-1.1.0-rc.1-linux-x64.tar.gz` has SHA256
`52167fe7f660221b65de42fcb89932ee441cd254ff1427e2f7acade3e9b6ccf8`; all 478 installed
manifest entries retained their hashes and modes after qualification. The
installation, full temporary Ocean clone, profiles, task worktree, evidence and
GUI userData were private. Existing installations and user profiles were not used.

The installed CLI entry point constructed the production `DeepSeekProvider`,
using the configured default `deepseek-flash`. A qualification-only fetch shim
forwarded its exact request body over SSH to an ephemeral Python stdlib HTTPS
process. That process contacted only the fixed official DeepSeek endpoint,
read the preauthorized remote key in memory, and returned genuine SSE bytes.
No real key was copied to the local machine, GUI, sandbox or repository. The
local provider received a dummy transport credential. This qualifies that
explicit transport configuration; it does not qualify the stock saved-key path
or remote cancellation. No live response was replaced with a deterministic fixture.

The shim and offline protocol tests live in `apps/desktop/qa/live-deepseek-*`.
They are never imported by production automatically. Their environment contract
is an explicit private canonical `OCEAN_LIVE_EVIDENCE` directory and absolute
`OCEAN_LIVE_SSH_CONFIG`; the configured SSH account is `bigpc`, and the remote key
path is fixed at `~/.config/ocean/deepseek.key`. Start the installed CLI with
`node --import /absolute/path/to/live-deepseek-transport.mjs /absolute/installed/launch.js ...`
and the dummy `DEEPSEEK_API_KEY=bridge-placeholder-only` only in that isolated
owner process. The evidence contains request/response text and must remain private.
The live SSH children used an environment containing only PATH. Final harness
review tightened this to explicitly include the same private HOME/XDG/TMP paths;
an actual child-process regression and credential-free SSH handshake verified
that change without another inference request. Provider and SSH-agent credentials
are excluded from the child environment.
There is no automatic retry. An observer abort is not remote cancellation;
the existing SSH response is drained for accounting, without a second request.

## Observed live acceptance

- An actual installed TUI turn detached normally and the public SDK recovered the
  same run and persisted answer with one provider dispatch. A local gate held
  delivery of genuine response bytes; upstream HTTP had finished while runtime
  delivery remained pending. This does not claim a remotely active paid request
  survived forced process termination.
- A group submit lost its already-committed acknowledgement. Receipt lookup and
  identical request ID/payload recovered the same run; a changed payload was
  refused. Group provider context excluded the private direct-room canary.
- Real dev tools read a full temporary Ocean clone. The owner denied one exact
  write and one exact test request; neither entered the effect journal. A new
  approved focused test failed on the initial unimplemented fixture. Two
  independent owner clients resolved that shared decision once.
- The dev then wrote a deliberately incorrect absolute-value addition function
  and positive-only regression. The registered test passed in the network-disabled
  qualified worker. Independent immutable review found the negative/mixed-sign bug
  and missing test cases with valid source/test anchors, without dev history or tools.
- The dev repaired the function and added signed-input regression cases under new
  exact approvals. The fresh test passed, the changeset/tree/evidence changed, and
  the old review became stale. Applying with it was refused before confirmation.
  A fresh real review approved the repaired artifact. Owner denial left the original
  clone clean; a separate owner confirmation applied the exact two reviewed files,
  preserving HEAD and index. Both file receipts completed with no pending effect.
- The already qualified packaged Desktop used that same installed owner and private
  profile for a genuine text attachment. Exact attachment text reached DeepSeek;
  the displayed reply, SDK result and genuine SSE text matched. The attachment
  preview worked. Native sandbox/context-isolation and private userData were
  observed, and the owned GUI process group and runtime were closed. This is text
  attachment qualification, not image vision.

All 22 real inference requests returned HTTP 200, complete SSE and usage. Provider
usage was 55,894 input tokens plus 7,534 output tokens, totaling 63,428; the 22 durable
usage events match exactly. These totals include every dev tool round and denial
continuation as well as both reviewer calls. There were zero unknown outcomes and
no retries of an unknown request or effect.

The one live preset was intentionally focused:

```text
pnpm --config.verifyDepsBeforeRun=false run test packages/domain/src/rc-add.test.ts --configLoader native --no-cache --no-color --maxWorkers 1
```

It retained the accepted read-only dependencies, network isolation, 60-second,
2-GiB, 256-task and 32-KiB-output limits. Every completed test reported confirmed
cleanup, unchanged dependencies and untruncated output. This is not full-suite
coverage; the earlier complete Ocean workload and crash qualification remain
separately attributed to workpackages 7.11/7.12. Compared with installed 7.12H,
current RC JavaScript differs only in `ocean/room-connection.js`; provider, shared
owner, persistence and coding-effect bytes are unchanged. No paid request was
killed and replayed to repeat the crash matrix.

## Reproducible offline checks

Run the protocol tests without credentials or network access:

```sh
node --test apps/desktop/qa/live-deepseek-transport.test.mjs
python3 -B apps/desktop/qa/live-deepseek-remote.test.py
```

They cover fixed routing and byte preservation, private evidence custody,
refusal before dispatch, secret-bearing exception redaction, incomplete response
classification, no retries, held-delivery lifetime and local abort with remote
response drainage. Root contributor gates are `pnpm check`, `pnpm build` and
`pnpm format:check`; native qualification remains separately reported. Private
full commands, identities, approval previews, usage, immutable artifacts and
receipts are retained in the workpackage report rather than committed transcripts.
