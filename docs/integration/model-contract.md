# Model settings contract (development source)

The shared local runtime implements the model connection, exact bot binding,
room policy and run evidence APIs below. Clients use the authenticated private
Unix socket; the runtime owns canonical SQLite, credentials and execution.
Desktop controls and installed/native/live-provider qualification remain separate
release gates. These APIs do not create another agent loop or select one model
for every bot.

## Negotiation and methods

The SDK advertises `model.connections-v1` in hello. The runtime negotiates it
independently of `plugin.session-authority-v1` on each socket. A socket without
the model marker receives `model_runtime_upgrade_required` for each model
method. Every SDK model wrapper also refuses locally with that code before
validation or sending a command when its host lacks the marker.

| Wire method                       | Public `@runnets/tools-node` client method |
| --------------------------------- | ------------------------------------------ |
| `modelConnections.list`           | `listModelConnections`                     |
| `modelConnections.set`            | `setModelConnection`                       |
| `modelConnections.check`          | `checkModelConnection`                     |
| `modelConnections.disconnect`     | `disconnectModelConnection`                |
| `modelConnections.removeSavedKey` | `removeModelConnectionKey`                 |
| `bots.createBound`                | `createBoundBot`                           |
| `bots.setModelBinding`            | `setBotModelBinding`                       |
| `bots.listBound`                  | `listBoundBots`                            |
| `runs.modelExecution`             | `getRunModelExecution`                     |
| `rooms.getModelPolicy`            | `getRoomModelPolicy`                       |
| `rooms.setModelPolicy`            | `setRoomModelPolicy`                       |

The full current identity has 66 capabilities. A plugin-aware socket without
model support has 65; the frozen legacy projection has 45 and stays within its
64-capability bound. Unknown features enable neither family. A host advertising
plugin operations without the session-authority marker still fails SDK connect
with `plugin_runtime_upgrade_required`. Unknown methods return `method_not_found`.
Capability support grants no mutation permission: restore, disabled and injected
provider restrictions still apply.

## Reads, pagination and updates

`listModelConnections` accepts optional `workspaceId`, `after` and `limit`.
`listBoundBots` requires `workspaceId`, with optional `roomId`, `after`, `limit`.
Both default to 50 entries and accept at most 200, ordered by connection ID or
bot ID respectively. Follow the returned `nextAfter` until null; each page is
validated, but multiple pages do not promise one shared snapshot.

Connection metadata records configuration intent, saved-reference presence,
registered model catalog, historical check, local qualification, restrictions
and recovery facts. It performs no credential lookup, activation, probe or
inference. Saved-reference presence and an old successful check do not establish
current health. An explicit `checkModelConnection` performs the bounded check.
Its SDK timeout is 12 seconds around the application probe's 10-second deadline.
No key, private reference or private request digest is returned.

Connection set uses `expectedRevision:null` for creation or a numeric revision
for replacement. Revision operations require numeric CAS. Bound bot results
pair the exact binding with its bot `profileVersion` in one page item;
`setBotModelBinding` requires `expectedProfileVersion`. Changing a connection's
default model or disconnecting it does not rewrite existing bot bindings.

`getRoomModelPolicy` returns the stored revision and cloud-transfer policy; it
does not initialize or repair missing policy. `setRoomModelPolicy` uses that
revision and a retained request ID. After a stale-revision refusal, reconnect or
restart, refresh with get before issuing a new intent. Policy and binding changes
remain scoped to their workspace and owning rooms.

## Explicit recovery and historical receipts

A key publication first commits a pending row with a keyless original envelope.
The envelope preserves method family, request ID, descriptor and original CAS:
new connection creation uses null, rotation/removal uses a number, and historic
`provider.set` omits the guard. `keyWasSupplied` and `requiresKeyResupply` describe
whether an explicit retry needs the same retained key. Set-to-auth-none removal
can retain a set envelope with `keyWasSupplied:false`.

Startup never resumes private publication. The owner explicitly repeats the
original method and exact input, including the same key where originally supplied.
There is no credential export, receipt-discovery or refill/resume API. Changed
input/key/family returns `request_conflict`; a new request ID cannot supersede
an unresolved publication and returns `provider_unverified`. Malformed wire
inputs return `invalid_params`. Other scoped/revision refusals retain their
specific application codes. Historical rows without a reconstructable envelope
report `original_input_required` or `explicit_key_repair_required`; clients must
not invent missing intent.

Pending already contains revision R+1. Activation clears pending fields without
incrementing again. Two authorized clients retrying the same pending operation
receive the same original receipt, with one publication in that recovery wave.
A failure before delegate publication totals two attempts and one publication
across the original and replacement owner. A failure after publication can total
two attempts and two successful delegate publications of the same explicitly
reauthorized local operation. This does not authorize replay of an unrelated
unknown external effect.

After activation and receipt commit, an actually lost success reply can be
retried with the client's retained original input, including after owner SIGKILL
and restart. Completed replays return the original historical result and add no
private publication, probe or model dispatch. Disconnect does not cancel work;
cancellation does not establish cleanup.

## Run evidence and older clients

`getRunModelExecution` returns one committed `runVersion` and the admitted
connection revision, bot profile version and model identity, or an explicitly
host-supplied identity. Later connection rotation/rebinding does not rewrite
historical execution. Scope is checked before exporting run evidence.

`usage.requestCounts` separates actual, estimated, unavailable and pending
requests. Actual zero can be complete; estimated zero and unavailable usage
remain incomplete. A later actual request in the same run does not erase an
earlier estimate. Unknown reconstruction uses null counts. No recorded model
execution returns `execution:null`, never fabricated zero usage. Known token
scope includes the legacy run-ledger prefix; category counts cover recorded
model requests.

Legacy/A3 `runs.events` pagination preserves each physical sequence and position.
Model-only rows become restricted redacted placeholders, with no omission,
renumbering, new cursor or journal mutation. Current model-aware clients retain
the supported model start/settlement metadata.

## Reproducing process acceptance

From the workspace root with pinned pnpm and Node supporting TypeScript stripping:

```sh
pnpm build
pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/model-compatibility-process.test.ts apps/cli/src/local-runtime/model-recovery-process.test.ts apps/cli/src/local-runtime/model-evidence-process.test.ts
pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/own-engine-process.test.ts apps/cli/src/local-runtime/lost-receipt-process.test.ts apps/cli/src/local-runtime/restart-process.test.ts apps/cli/src/local-runtime/broadcast-process.test.ts
```

The model suites launch plain Node owners/SDK clients over real private sockets,
SQLite and temporary synthetic credential storage. Faults are fixture-only
secret/HTTP ports and correlated reply suppression. One case launches the actual
built CLI runtime entry point. The real engine's held HTTP stream proves pending
then actual-zero snapshots. Additional category examples are explicitly synthetic
journals seeded through public commands, not vendor parsing evidence.

These suites qualify Linux child-process/socket/restart behavior with synthetic
keys/services and synthetic frozen-protocol clients. They do not qualify live
cloud services, an actual local backend, historical installed binaries, GUI,
system service deployment, arbitrary multi-user ownership, or filesystem power-loss
durability. Root check/build/format and native/live gates remain separately
reported; a source baseline failure must not be described as global green.
