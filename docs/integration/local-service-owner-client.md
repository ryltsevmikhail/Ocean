# Shared service owner settings client

The existing authenticated `LocalRuntimeClient` now provides
`serviceConnections()`, `serviceGrants()`, `serviceReceipt({requestId})`,
`setServiceConnection(request)`, `disconnectServiceConnection(request)`,
`refreshServiceConnection(request)`, `setOwnerScopeGrant(request)`,
`revokeOwnerScopeGrant(request)` and `listServiceOwnerOperations(query)`.
Import `connectLocalRuntime` from the public
`@runnets/tools-node/local-runtime-client` entry. The hello advertises
`service.authority-v2`; each call checks the host's advertised method support.
A host without `service.owner-operations` produces
`service_operations_upgrade_required` locally. Existing decisions.service-v1,
old clients and ACP retain their existing behavior. Current-source Desktop consumes these APIs through its existing Plugins toolbar;
see [Desktop service settings](desktop-service-settings.md) for scope and limits.

Build and initialize a **new synthetic profile** from the checkout, then run the
owner in one terminal and the independent read-only example in another:

```sh
pnpm build
mkdir -p /tmp/ocean-owner-example-workspace
pnpm ocean init --workspace /tmp/ocean-owner-example-workspace --profile /tmp/ocean-owner-example-profile
pnpm ocean runtime start --profile /tmp/ocean-owner-example-profile
```

```sh
node examples/local-service-owner-read.mjs /tmp/ocean-owner-example-profile
# Optional opaque cursor from operations.next:
node examples/local-service-owner-read.mjs /tmp/ocean-owner-example-profile REQUEST_ID
pnpm ocean runtime stop --profile /tmp/ocean-owner-example-profile
```

The example connects to the existing same-user authenticated socket; it never
opens SQLite, starts an owner, discovers metadata or sends mutations. Its output
contains owner-scoped connection/grant metadata, one operation-history page and
an original receipt snapshot. Use a private profile if output is sensitive.

`service.owner-operations` accepts exactly `{after?,limit?,state?}`. `after` is
an opaque request ID, `limit` defaults to 50 (1..100), and `state` is absent,
`prepared` or `completed`. `{items,next}` is ordered by request ID and filtered
by the runtime owner before SQL limit/record expansion. `next` is the last
returned ID only when further matching rows may exist. Pages use a 400000
canonical-character budget inside the existing 2 MiB frame. History is settings
intent, separate from business ToolEffect history; reading it cannot execute or
retry anything. Connections/grants return at most 100 rows within the same
character bound, with owner filtering and limit in SQL before record expansion.

Operation items expose `requestId`, `method`, `state`, `recovery`, `targetId` and
`operation`. Newly persisted set/refresh intents capture their exact original
request ID, target and expected versions before the private/external effect.
Set intent excludes `key` and records `requiresKey`; refresh intent records
`requiresKey:false`. Old receipts without intent return `operation:null` and
unknown prepared targets remain `targetId:null`. Private receipt references are
never included in operation history. Existing `service.receipt` replies retain
their original shape and keyless result snapshot even after later edits.

A prepared effect remains `prepared` with `explicit_recovery_required` across
restart and exact replay. Reads and startup do not resubmit it. Changed payloads
using the same request ID are refused. Recovery requires a new explicit request,
current versions and any required material; the old prepared fact remains intact.
No history input is execution authority.

Connections add `tools` and readiness: `ready`, `disconnected`,
`metadata_required`, `unavailable` or `unknown`. Readiness uses the owner's
current transport/session and lifecycle; durable `active` alone is insufficient.
An older authority-v2 reply lacking readiness normalizes to `unknown`. Readiness
provides no discovery, claim or permission: actual C3 admission still decides
execution using current authority.

These are source/runtime contracts qualified by synthetic local tests. Installed
packages, GUI/native behavior and live external services remain separate gates.
