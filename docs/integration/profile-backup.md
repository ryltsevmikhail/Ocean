# Complete private profile snapshots (7.8)

Workpackage 7.8 implements public format 2 and inert quarantine restoration in
development source. It composes the accepted 7.7 checkpoint
`3114a857359dc6a842df9f70d3b7811b0177747c`, including its reviewed fixes.
Independent controller review and the later release gates remain required.
Earlier selected-subgraph qualifications do not establish complete-profile support.

The existing commands remain:

```sh
ocean backup --profile /absolute/profile --to /absolute/backups/snapshot-001 --json
ocean restore --from /absolute/backups/snapshot-001 --profile /absolute/new-profile --json
ocean doctor --profile /absolute/new-profile --json
ocean history ROOM_ID --profile /absolute/new-profile
```

Stop the active runtime first. Use new destinations with existing trusted parents,
outside the profile and every selected project/worktree/dependency/Desktop source.
No source directory is cleaned, repaired or rewritten by backup or restoration.
A source graph that cannot be proved complete refuses publication.

## Frozen database and publication

The pure domain `ProfileBackupManifest` discriminates historical format 1 from
format 2. New backups always use format 2: `snapshot.json`, `runtime.sqlite` and
`assets/`. The manifest binds the copied database hash/size/schema/summary and
all frozen inventory and subgraph catalog identities. Immutable changeset text
remains in its authoritative SQLite payload; the reader checks its hashes and
exact file descriptors rather than inventing external copies.

`snapshotCodingDatabase` holds exclusive maintenance ownership through source
preparation, online SQLite backup, archive consumers and publication preparation.
Its optional destination selector admits every frozen external source before the
host creates output. Initial coding/Desktop inventories must equal those decoded
from the copied database. Existing string destinations and three-argument callers
remain supported. A retained original copied-database FD, identity, mount and
hash remain checked through the finalizer; publication is deferred until its
last authoritative check. Its final host copied-database reader precedes the final
original-source session proof. A terminal synchronous verifier then checks the
original copied-DB bytes through the inherited read-only FD against the original
hash/stat, with parent FD/current-path/mount checks around it. This helper uses
only built-in fs/crypto, no package/preload/provider environment, source pathname
or file writes; it cannot invoke host reader callbacks. No effect-capable or
selected-body consumer follows that terminal proof before marker removal.
This closes consumer-induced changes in either direction; it does not claim
global filesystem atomicity against an arbitrary external writer after the check.

`prepareProfileBackupAssets` returns an originating, single-use handle carrying
the original source session. `captureProfileBackupAssets` also accepts the
existing direct source DTO, preparing it internally before asset output. Returned
`verify`, `publish` and `close` methods keep private observations alive through
the last whole-profile consumer. Portable catalogs never authorize source reads.
The original ready/partial Git ports retain their standalone behavior; unified
sessions extend their FD/witness lifetimes without replacing accepted semantics.

Output directories are private, new and checked through retained root/parent
identity and mount observations. A durable `.incomplete` marker precedes copies.
The host independently validates copied SQLite integrity, foreign keys, summary,
exact frozen inventories and all archives before publication. Public verifiers
always refuse incomplete archives; only an originating output handle permits
internal prepublication verification. Failure retains incomplete evidence.
An incomplete quarantine is unavailable even if its restore guard says ready.

## Supported graph and refusal boundary

| Frozen state                                        | Retained result                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No coding tasks, with or without Desktop assets     | Independent Desktop selection and full format-2 envelope                                                                                   |
| Planned task without a worktree                     | Explicit absence; registration/policy retained, no invented ready tree                                                                     |
| Ready managed worktree                              | Tracked/untracked/binary bytes, modes, permitted internal links, exact index and verified Git pack                                         |
| Preparing/uncertain native worktree creation        | Actual root/admin/index presence or absence, partial tree, base closure; never promoted to ready                                           |
| Index stages 1–3, resolve-undo, staged-only objects | Exact raw index, actual object identities and required base/index/REUC closure                                                             |
| Immutable changesets                                | Exact SQLite payloads and checked ordered before/after references                                                                          |
| Scoped recovery                                     | Complete, header-only, partial and absent evidence as allowed by frozen phase; unknown effects stay unknown                                |
| Legacy recovery                                     | Every selected matching UUID, exact candidate sets, ambiguity and conflicting preimage; required completion coverage checked               |
| Interrupted apply publication                       | Accepted narrow legacy/scoped aliases remain inert evidence; external aliases are not recreated                                            |
| Registry and dependency configuration               | Exact private bytes, selected and metadata-only registrations, exact frozen task policy                                                    |
| pnpm/dependencies/workspace packages                | Selected executable bytes/mode, dependency trees, internal hardlinks and unchanged relative links resolved within the virtual task         |
| Desktop files/images/messages/preparations/uploads  | Exact bound references and bytes, unsent receipts and incomplete upload data                                                               |
| Desktop receipt link/unlink interval                | Both exact same-room names retained only for one matching frozen started preparation, with full binding/content and alias membership proof |

Missing required ready data cannot be substituted with a valid reduced dependency
catalog declaring `treeSelection: not-supplied`. Unsupported phase relationships,
missing registration, unsafe aliases/symlinks, protected names, foreign owners,
child mounts, unsupported Git storage, corrupt/extra/duplicate records, changed
sources or exceeded limits refuse. Metadata changes are checked before source
body reads; final original hashes detect shared-mapping writes with unchanged
inode/size/timestamps. No backup success is inferred from one successful subgraph.

The Desktop two-name exception is limited to canonical `<request>.json` and
`<request>.json.<uuid>.tmp`, an exact operation-bound started request, and exactly
the selected two links. Wrong rooms/requests, third/outside links, ambiguous or
completed operations and already-sent associations refuse before receipt bodies.

## Independent verification and quarantine

`verifyProfileBackupAssets` uses archive-owned data only. Full host validation
additionally compares those inventories to the copied SQLite database.
`verifyProfileBackupEnvelope` is the composable tools adapter for envelope,
database byte identity and asset checks; its consumer is where the host performs
store-specific SQLite validation. Tools-node does not import store-sqlite.
Strict format-2 schemas, canonical generated JSON, exact archive membership,
bytes/modes/link closure, actual Git OIDs and cross-graph relationships are checked.
Recomputed untrusted catalog hashes cannot replace semantic checks. Absolute
original paths are inert provenance and are never reopened during verification
or restoration.

Restoration creates a new private profile and installs its guard before copying.
`assets/evidence` retains the entire verified asset archive. Virtual task trees
are under `assets/worktrees/<slot>/materialized/tree`, recovery under
`assets/recovery`, Desktop under `assets/desktop`, and exact graph relationships
in `assets/relationships.json`. The configuration is retained as inert evidence,
not installed as authority. Raw Git index/admin/pack evidence is not imported into
an original checkout. Last archive checks precede root publication.

Historical format-1 archives retain their existing metadata-only, text-only read
semantics. They are never upgraded into complete coding backups by interpretation.
The public format dispatcher pins and bounds `snapshot.json` to 32 MiB before
allocating or parsing its body; the legacy validator uses those same decoded
bytes. Format-2 routing is followed by full independent envelope verification.
A successful format-2 restore permits the existing conversation-read and explicit
new text-only confirmation flow. It does not rebind projects, revive old approvals,
repeat uncertain operations, settle effects or enable coding execution.

## Resource bounds and qualification

One session caps stored bytes at 2 GiB, logical bytes at 2 GiB, entries/objects at
100,000 and metadata at 32 MiB. Lower subgraph limits remain, including Desktop
128 MiB/10,000 entries/depth 3/catalog 16 MiB, registry 1 MiB, index 16 MiB,
compressed Git pack 256 MiB and individual decoded Git object 64 MiB. Git's
independent compressed/inflation/reconstruction checks remain in force.

Known source sizes/names/metadata and every explicit Git closure are reserved
before the first archive consumer. Each hardlink name counts logically. Worktree
copies stored in both worktree and dependency archives are charged separately;
Git closures count separately for distinct archive occurrences even when sharing
one object store. Rechecks of the same occurrence do not add another charge.
Archive verification shares a budget across the envelope and all nested graph
checks. Known JSON metadata bodies are reserved together before the first archive
body reader, including snapshot, catalogs and inventories. Rechecks share a charge
only for the same original file identity and mount; equal content in separate
files counts separately. Declared decode bounds are charged before expansion. Accounting is
conservative: retained witnesses and source object storage can cause refusal
below the nominal payload ceiling. Files stream in bounded buffers; one bounded
Git pack/index and bounded catalogs/witnesses are processed at a time.
The terminal copied-DB proof streams in 1 MiB buffers, permits 1 KiB of output and
has a 30-second timeout with SIGKILL. Launch failure, nonzero/signal exit, timeout,
unexpected output or byte mismatch refuses publication with both markers retained.

Synthetic qualification covers source-deleted complete restore, frozen SQLite
references, partial-create process deaths, actual Desktop SIGKILL and publication
barrier, no replay on two reopenings, global budgets, late Desktop consumers,
mmap, output substitution and semantic tampering. All gate results and exact
commands are recorded in the workpackage report; native/process qualification is
separate from ordinary source tests. This is not current Electron GUI acceptance.

Remaining full-goal gates include authoritative owner rebind/new execution epoch,
effect-interval reconciliation, other worker/write/test/changeset crash intervals,
held-lease finalization, installed Linux candidate/hash/compatibility exercises,
interactive CLI/TUI/ACP/group/history/restore, separately authorized fresh live
provider qualification, final whole-branch review and verified publication.
No installed 1.0 profile, real Desktop/userData, provider credentials or BigPC data
is needed for this workpackage.
