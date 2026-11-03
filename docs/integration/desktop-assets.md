# Runtime-owned Desktop asset capture (7.7)

Implemented in development source after accepted 7.6 (`ce482d5`). This is a
composable Desktop subgraph, not public full-format-2 backup or complete profile
restore. Independent acceptance remains with the controller.

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
Relocated profiles refuse the old binding before reading its source; rebind is
future explicit owner work. An admitted but unfinished enrollment remains
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
changes refuse. A receipt interrupted between link and unlink has two inode names;
7.7 deliberately refuses this interval (`protected_desktop_asset`) and preserves
both source names. It does not claim all crash states are capturable.

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
mount refusal before body reads and late shared-mmap corruption. Electron host
integration uses a mocked native rendering boundary; new GUI/installed behavior
is not qualified here. Historical pre-7.7 GUI scripts need separate qualification
against the new canonical ownership layout.

Run root `pnpm check`, `pnpm build`, `pnpm format:check`; targeted process:
`pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/desktop-assets-process.test.ts`;
native: `OCEAN_SANDBOX_NATIVE=1 pnpm exec vitest run --config vitest.process.config.ts packages/tools-node/src/desktop-assets-native.test.ts`.
Use explicit disposable HOME, XDG_RUNTIME_DIR and userData for every qualification.

Public format 1 still refuses external coding assets and now refuses bound
Desktop assets; unregistered marker-bearing profiles require explicit enrollment
instead of silently producing a new SQLite-only backup. Old format-1 text-only
archives retain their historical summary shape and restore guard. Full format 2,
unified cross-subgraph budgets, full profile restore/rebind, remaining crash
intervals, installed/live RC, final whole-branch review and publication remain OPEN.
