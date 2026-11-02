# Local runtime lifecycle

The lifecycle subset is implemented on Linux: one foreground process owns one
canonical private profile, its existing SQLite runtime and recovery. Only
`hello`, `status` and `stop` are available over the socket. Conversation, run,
approval, TUI, ACP bridging and desktop routing through this endpoint remain
planned in [the shared-runtime design](../ocean/shared-runtime.md). Existing
commands retain their current offline behavior and report `owner_busy` if they
try to own an active profile. This delivery does not install a service or spawn
one automatically.

After initializing an isolated profile, run:

```sh
pnpm ocean runtime start --profile /absolute/private/profile --json
```

Start stays in the foreground and emits a ready status only after exclusive
SQLite ownership and existing conversation, coding-apply and effect-journal
recovery succeed. It never reads provider keys or dispatches a provider. A
restored profile refuses `restore_restricted` before publishing an endpoint;
existing offline restored reads and freshly confirmed text-only behavior are
unchanged.

In separate terminals:

```sh
pnpm ocean runtime status --profile /absolute/private/profile --json
pnpm ocean runtime stop --profile /absolute/private/profile --json
```

Status and stop authenticate through the socket without opening SQLite. Success
returns the existing CLI envelope `{version:1,ok:true,data:...}`. Status includes
protocol, canonical profile identity, instance identity, capabilities and state.
Stop returns `state: "stopped", outcome: "complete"` only after settlement and
runtime close. Closing a client merely detaches it. SIGINT and SIGTERM request
the same shutdown as explicit stop. No cancellation or work-submission method is
implemented in this subset.

A host-only drain seam must settle future execution before database close. An
uncertain/rejected drain returns `state: "stop_incomplete", outcome: "uncertain"`,
retains the owner and listening endpoint, and never claims cancellation. The
default drain deadline is 29 seconds; expiry also reports incomplete stop without
closing SQLite under unsettled work. The failed stop result is retained; repeated
stop requests do not retry effects.
Clients receive exit 4 for an incomplete stop. `owner_busy`, `runtime_absent`,
`runtime_unreachable` and `endpoint_exists` use exit 3. Other invalid input or
security refusals use exit 2, except inherited `restore_restricted` (exit 4).

## Endpoint and independent clients

The canonical profile must be an owned 0700 directory without symlink ancestors.
The existing database privacy checks also apply. The profile identity is SHA-256
of that canonical absolute path; the runtime instance is a fresh UUID.

Endpoint discovery uses an owned 0700 `XDG_RUNTIME_DIR`, or an owned 0700
`/tmp/ocean-UID` fallback. An overlong XDG path selects the verified short fallback.
A profile-specific `ocean-<24 hex digits>` directory contains `runtime.sock` (0600)
and `connection.json` (0600). The descriptor is published without replacement,
after recovery and listening, and binds protocol 1, profile, instance, endpoint
and a fresh 256-bit capability. It is private credential material: do not print,
copy into transcripts, commit or expose it or the endpoint to model workers.
All clients must use the same runtime-directory environment.

The public Node client is exported by `@runnets/tools-node`:

```js
import { connectLocalRuntime } from '@runnets/tools-node';
const client = await connectLocalRuntime({ profile: '/absolute/private/profile' });
try {
  console.log(await client.status());
} finally {
  client.close();
}
```

A desktop or independent process can implement the same newline-delimited UTF-8
JSON framing using `@runnets/contracts` without importing application internals.
Each request is `{id,method,params}`, with a nonempty string ID up to 128
characters. First send `hello` with `protocol:1`, `profileId`, `instanceId` and
`capability` from the verified descriptor. Success returns identity plus
`capabilities:["status","stop"]`. Subsequent `status` and `stop` accept empty
params. Responses are `{id,result}` or `{id,error:{code}}`. Unknown methods refuse;
there are no placeholder handlers for future methods. Wrong authentication,
profile and instance return `authentication_failed`; incompatible protocol returns
`protocol_mismatch`; requests before hello return `authentication_required`.

Each frame is at most 2MiB excluding the newline. Malformed/invalid UTF-8 and
oversized frames terminate that connection. The server bounds connections to 64,
requires hello within five seconds and drops observers whose pending output
exceeds 2MiB. The Node client bounds pending requests to 128 with five-second
transport timeouts (30 seconds for stop). Contract limits of 200 items per page and 30-second waits are
reserved for later methods; lifecycle has no lists or waits. No peer-credential
API is claimed: filesystem privacy plus the random capability provide the local
boundary. Same-UID processes with access to those credentials are trusted.

## Safety and qualification limits

Existing descriptor/socket entries, including stale, foreign and symlink paths,
are never automatically removed or stolen. A clean stop removes only its pinned
owned descriptor and socket; foreign descriptor replacement is preserved. Node
closes and unlinks Unix listener paths, so a replaced socket causes incomplete
stop and retains the owner. Ownership is checked immediately before close;
concurrent same-UID filesystem mutation remains inside the trusted-process
boundary.

SIGKILL leaves stale endpoint evidence: status reports unreachable and a new
start refuses `endpoint_exists`. **Real crash restart and two-client reattachment
are still an open lifecycle acceptance gate.** No manual deletion is counted as
restart qualification. Safe predecessor reclamation or an explicit verified
maintenance procedure must be delivered before that acceptance gate closes.

The Linux process suite exercises separate owner/status/stop processes, second
owner refusal, recovery before ready, clean restart, SIGTERM, SIGKILL stale refusal,
uncertain drain and foreign-socket preservation. Socket tests cover two clients,
authentication/profile/version/instance binding, modes, symlinks, short fallback,
fragmentation, oversized frames and foreign descriptor preservation. This is
headless lifecycle evidence only: no provider, active-turn cancellation, TUI,
GUI shared-runtime, external-service or full Ocean 1.1 qualification is claimed.
