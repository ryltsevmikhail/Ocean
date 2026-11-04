# Runtime-owned Desktop asset capture (7.7)

The original 7.7 subgraph was implemented after accepted 7.6 (`ce482d5`).
Public full-format-2 backup/quarantine restore followed in 7.8 and explicit owner
rebind in 7.9. Installed Linux qualification is accepted through 7.12. The current
7.13 real GUI gate and its retained evidence are described in
[Desktop integration](desktop-client.md#current-installed-runtime-gui-qualification-713);
independent acceptance of that gate remains with the controller.

## Trust and ownership

Electron main authenticates the existing public local runtime client, validates
its profile identity using `profile-assets.ts`, and uses the shared
`DesktopAttachmentClient`. The renderer cannot enroll roots or obtain runtime
credentials. The authenticated same-UID native host supplies explicit `userData`;
model tools have no enrollment operation or owner credential.

The runtime recomputes the imported namespace: the default canonical profile
`<userData>/conversation/profile` maps to
`<userData>/conversation/attachments`; another profile maps to
`<userData>/conversation/profiles/<sha256(canonicalProfile)>/attachments`.
It never scans HOME, selects a root from a marker, or enrolls the old directory in
place. Under authoritative runtime/SQLite ownership it freezes room, message and
exact durable send-request records, records an enrollment intent, preflights and
captures the exact legacy root, independently verifies its archive, and restores
a new private `<profile>/desktop-<uuid>/tree`. Original private witnesses are
rechecked after the last consumer. One SQLite transaction switches the binding
and adopts every fully validated final preparation receipt, including unsent
requests, with its exact room/request/body/recipient/IDs/result binding. Exact
retries return that result; conflicting retries refuse without sending. Partial
receipts do not become completed operations. Original roots remain untouched and inert;
continued old-client writes cannot alter canonical bytes or create associations.

Schema 12 adds operation, upload and adopted-message tables transactionally.
`meta.desktop_assets_binding` records the authenticated profile hash, canonical
root/device/inode/mount/private identity, and original root as provenance.
Relocated profiles refuse the old binding before reading its source; the owner
must use the explicit maintenance rebind flow. An admitted but unfinished enrollment remains
`desktop_outcome_unknown`, with evidence retained and no automatic retry/repair.

Every reachable Desktop publication now executes synchronously in the owner
through `DesktopAssetService` and the tools-node filesystem adapter. The old raw
writer is retained only as a test fixture. Connection loss cannot leave a client
filesystem writer. Maintenance snapshots refuse `owner_busy` while the runtime
exists; a snapshot holds ownership through the full capture callback and excludes
runtime startup. This is offline maintenance, not an online snapshot promise.

## Protocol and evidence

Local protocol v1 adds authenticated `desktop.assets` with strict `op` variants:
`enroll`, `begin`, `chunk`, `commit`, `read`, `prepare`, `receipt`.
The public SDK validates commands/replies. JSON frames remain capped at 2 MiB;
raw chunks are at most 256 KiB, encoded chunks at most 349,528 characters, and
one file at most 10 MiB. Preparation accepts one to four unique file UUIDs.
Uploads bind UUID, room, original name, exact size and digest; offset retries
must match existing bytes. Staging is private authoritative SQLite data (bounded
at 128 MiB/10,000 upload rows), and commit validates exact bytes before admitting
filesystem publication. Incomplete upload commit refuses `upload_incomplete`.

Publication/preparation intent is durable before filesystem effects. Exact
completed retries return the committed result; started outcomes remain unknown
and never auto-replay. Preparation binds room/request UUID, ordered attachment
IDs, original body, recipient, full prepared body and its SHA-256. Actual send
admission checks an existing preparation's body/recipient binding. A raw v1
marker remains text unless exact owner preparation and frozen message/request
records prove its association. No send is replayed by capture or materialization.
Native image rendering, preview, four-file selection and export remain host
operations; save writes the exact authorized read bytes.

### RC2 marker hardening and inert unbound markers

The runtime refuses any marker-bearing submit body that does not decode or has no
completed `prepare:<room>:<requestId>` operation for the same room and request id
before the message/turn/batch is written (`image_unavailable`; a started
preparation is `desktop_outcome_unknown`; a body/recipient mismatch is
`request_conflict`). Broadcast submission checks this before the batch exists;
direct turns check it in admission. A Note keeps its no-model semantics and is
prepared with `to: null`, so it follows the same binding. The offline CLI composes
the same resolver and admission checks but does not replicate the runtime's
pre-write prepared-`to` refusal: it refuses the turn at admission with zero
provider dispatch.

History reconstruction no longer poisons a room on a marker persisted before this
hardening. A marker body with no durable preparation, or with no receipt/adoption
binding to that exact message, is inert display text: the resolver reports it as
unbound and everything from the marker onward is stripped. A genuine image message
whose authority exists but whose blob, metadata or header is missing, replaced,
corrupt or oversized still fails closed with zero bytes sent. The accepted
`desktop-assets.test.ts` migration case seeds such a pre-fix row directly, and the
`image-binding.test.ts` regression proves the room stays usable (a later turn completes with the
marker inert, no image part, no provider request for the forged bytes).

`snapshotCodingDatabase(path, destination, callback)` now also supplies a bounded
`DesktopAssetInventory` as the callback's second argument, independently of coding
task count. `readDesktopBackupInventory` reads a frozen, non-owned database only.
The original copied SQLite digest is rechecked after the callback's final consumer.
Inventory preserves exact send binding/reply, preparation operations and partial
upload bytes; complete upload bytes are represented by canonical blob files.

Public composable ports are `captureDesktopAssets`, `archiveDesktopAssets`,
`verifyDesktopAssetArchive`, and `restoreDesktopAssets`. Captures are immutable,
process-originating private handles; serialized clones cannot authorize source
reads. The private archive contains `catalog.json` plus `assets/` content-addressed
blobs/manifest. Independent verification reads only that archive and validates
namespace, private modes, full required references, byte hashes and exact
message/request/preparation relationships. The same originating archive
observation retains directory and file identities, private modes/UIDs, mount
identities and bytes through materialization and evidence publication. Fresh
current-path mount checks also reject overmounts that leave pinned descriptors
unchanged. Materialization creates `tree/` and
`desktop-evidence.json`; the latter retains inert original paths, operation states
and incomplete upload bytes. It neither installs a usable profile nor grants
approvals, enrolls paths, prepares messages or executes sends.

The Desktop subgraph limits are 128 MiB file bytes, 10,000 filesystem entries,
three path levels and 16 MiB total serialized catalog. Frozen database selections
also bound records and payloads before loading them. Source traversal checks the
entire set, aggregate bytes/names and exact namespace before file-body reads.
FD, mount, UID, private mode, link, path and original byte witnesses survive the
last consumer, including same-size mmap writes with unchanged timestamps.

Supported incomplete evidence includes private `.upload-*` directories and
unlinked `<request>.json.<uuid>.tmp` files. External hardlinks, symlinks, protected
names, nested mounts, missing required blobs/metadata/receipts, corrupt references,
legacy receipts without the complete prepared-body binding and observed source
changes refuse. The accepted 7.7 checkpoint `3114a85` refused the receipt link/unlink interval.
The [7.8 unified layer](profile-backup.md) now retains its exact two same-room
receipt names only for one frozen started preparation with full request/body/to/ID
binding, exact two-link membership, no sent association and original private
mount/identity/byte proof. Outside/third aliases and ambiguous or completed
operations still refuse before bodies. Both names remain inert after restoration;
this exception does not permit arbitrary external hardlinks.

## Qualification and remaining gates

Source tests cover legacy default/alternate migration, continued old-root writes,
zero coding tasks, relocated-profile refusal, bounded chunks, exact request
binding (including unsent legacy retry adoption), partial upload evidence and
source-deleted archive materialization. Late archive directory/file identity and
mode mutations use real filesystem operations; late mount substitutions are
unit-injected separately from the opt-in native mount qualification.
Independent client-process tests exercise the production shared Desktop adapter,
a paused upload versus snapshot, snapshot-held runtime startup refusal, reconnect
and an actual owner SIGKILL in receipt link/unlink. Linux tests qualify real child
mount refusal before body reads and late shared-mmap corruption. The original Electron host
unit integration uses a mocked native rendering boundary. The 7.13 driver adds
actual standard-entrypoint Wayland windows against an installed 7.12 runtime,
with canonical operation faults, exact exported bytes and source-deleted public
restore; it preserves its private screenshots and event logs. Historical pre-7.7
GUI results remain historical and do not establish canonical ownership.

Run root `pnpm check`, `pnpm build`, `pnpm format:check`; targeted process:
`pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/desktop-assets-process.test.ts`;
native: `OCEAN_SANDBOX_NATIVE=1 pnpm exec vitest run --config vitest.process.config.ts packages/tools-node/src/desktop-assets-native.test.ts`.
Use explicit disposable HOME, all XDG directories, TMPDIR and userData for every qualification.

The low-level SQLite-only capture port still refuses external coding and bound
Desktop assets; unregistered marker-bearing profiles require explicit enrollment
instead of silently producing a new SQLite-only backup. Old format-1 text-only
archives retain their historical summary shape and restore guard. New public
backups use [format 2](profile-backup.md), including zero-coding-task Desktop
profiles. Unified budgets and inert quarantine are implemented in 7.8; executable
rebind and installed Linux gates are implemented and separately accepted through
7.12. Current GUI independent acceptance, live RC, final whole-branch review and
publication remain OPEN.
