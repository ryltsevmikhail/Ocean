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

Prepared-task finalization records (schema 14 `ocean_coding_finalizations` plus
the task status) live in ordinary profile tables, so a format-2 backup and
restore copy them byte-exactly. A restored finalizing/uncertain/finalized task
keeps its exact historical state, release intent/receipt reference and retained
assets inertly: ordinary restored admission refuses before opening it, no
original or restored profile attempts the release again, and original live
profile leases are never transferred or stolen. The coordination registry's
durable release receipt is separate and is never rewritten by backup/restore.
This is development-source behavior for workpackage 7.10; installed, current GUI
and fresh live release qualification remain planned gates.

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

## Format-2 lineage and owner rebind (7.9 development source)

Workpackage 7.9 adds optional versioned lineage to public format 2 and an
explicit owner-authorized rebind from an inert quarantine into a fresh execution
epoch. It composes reviewed 7.8 at `74b1dfa`; independent review of 7.9 and the
release gates remain open. This section records implemented source behavior, not
release qualification.

The public root stays format 2. An activated profile's backup adds
`manifest.lineage` (format 1) with `parentSnapshotId` (the exact parent manifest
hash), full current `codingInventory`/`desktopInventory` hashes, a
`recordsHash` over the bounded durable restoration state, ordered
`tasks:[{taskId,source:'live'|'parent'}]`, `desktopSource`, and ordered
`intents:[{requestId,recordHash,state,outputs}]`. Output kinds are exactly
`materialization`, `git-administration`, `git-reference`, `desktop`,
`registration`; presence is `absent` or `captured` with an exact asset-archive
hash. The extended envelope is `runtime.sqlite`, `snapshot.json`, `assets`,
`lineage`; `lineage/parent` is a COMPLETE independently verifiable format-2
parent envelope and `lineage/intents/<requestId-hash>/<kind>` holds each
captured pre-ready output.

Every frozen SQLite task and asset is assigned exactly once from durable current
origin/epoch state, never from a caller/model selector: tasks predating the
current origin must match the parent frozen inventory (recursively), while only
tasks owned by the current ready epoch's owner may be live. `assets` therefore
contains only the live partition; the frozen database still retains all task,
changeset, application, journal, decision, review, run and restoration history.
Desktop is live only after current epoch publication's exact new binding;
otherwise file-bearing Desktop records must match the parent evidence and the
live Desktop partition is empty with current rooms only. At most eight complete
envelopes may chain, with 1,000 task selectors and 1,000 intent records per
envelope and five output selectors per intent. Cycles, duplicate selectors,
unknown lineage versions/fields and incomplete parent/intent archives refuse.
The shared 2 GiB stored/logical, 32 MiB metadata and 100,000 entry ceilings span
the entire chain and current live graph; every independent copy occurrence is
charged again and there is no cross-envelope content deduplication. Verification
scans also consume budget, so refusal below the nominal payload ceiling remains
expected. This initial contract performs no deduplication.

Pre-ready intent coverage is mandatory. Consumed, preparing, held and ready
rebind records contribute planned output selectors derived from their exact
persisted plan; the deterministic Git temporary root and new administration
basename are part of that plan before Git runs. A ready record requires every
applicable output captured. Earlier consumed states preserve proven planned
absence versus safely captured partial bytes without promotion; an output that
appears for an unconsumed record, a dangling relative-link graph, a substituted
Git administration/backlink, a torn registration, an unparsable reference or a
missing ready output refuses backup instead of being omitted. The selected
project working tree itself is never copied, reset, cleaned or changed.

Schema 13 retains immutable origin history and retired epoch headers beside the
current origin head. Installing a new public restore appends the previous head
to history, changes only the current head, clears the executable epoch pointer
and records retirement. It never rewrites an archived ready/held rebind record or
approval, and the frozen parent database keeps the original pointer. Busy and
recovery predicates apply only to the current head, so archived intents remain
inert and readable. `restore-origin` remains the exact frozen database plus
manifest; new `restore-lineage` preserves the complete envelope lineage tree.
Runtime admission and rebind verification re-check the profile-owned frozen
bytes instead of any original absolute provenance path.

## Owner rebind operations (7.9 development source)

The commands are explicit, local and shared with the TUI/Desktop SDK; no model
or wire Boolean grants authority. Stop ordinary runtime use first, then:

```sh
ocean runtime restore --profile /absolute/restored-profile --json
ocean rebind inspect --profile /absolute/restored-profile --config inspect.json --json
ocean rebind preview --profile /absolute/restored-profile --config selection.json --json
ocean rebind confirm --profile /absolute/restored-profile --config selection.json
ocean rebind result --profile /absolute/restored-profile --config selection.json --json
```

`runtime restore` starts a restricted maintenance host over the existing
endpoint: history, common owner decisions and `restore.inspect`,
`restore.preview`, `restore.result` are served, while provider dispatch, Desktop
mutation and coding execution remain refused. Inspect derives profile, snapshot,
source owner, base and tree from verified local state plus the owner-selected
clean project and a fresh explicit policy; preview binds that exact selection,
tree and materialization plan to one five-minute common `restore-rebind` owner
decision. Confirmation is only `decisions.resolve` with exact reference, digest
and version, and one use. Denial, expiry, invalidation, or changed inputs create
no epoch, lease, registration or executable task.

After an allowed decision the operation durably consumes the card once, records
the new random epoch and explicit project/worktree lease intent, acquires new
epoch-scoped registry leases, materializes a complete ready-worktree snapshot
under `profile/rebind-<epoch>/materialized/tree` with fresh Git administration
against the selected base, then publishes the successor task, worktree, workspace
binding and optional new-profile Desktop storage in one SQLite transaction. If a
crash leaves any step unknown, reopening turns the record into `held`; nothing is
retried, promoted or cancelled, and removing `restore-guard.json` cannot admit a
durable-origin (7.9) profile. Legacy marker-only format-1 quarantines have no
durable origin and keep their historical behavior: with the marker deleted they
admit as an ordinary live owner (the explicit restored flag still keeps that
historical text-only mode; see the local runtime contract). After `ready`, stop
the maintenance host and start ordinary `ocean runtime start --profile ...`;
admission verifies the durable origin and exact ready epoch, older task
identities cannot authorize, and old receipts, approvals, claims and request
retries remain inert.

A deterministic refusal before any external effect is durable as `refused`, not
`held`: the confirmation CAS itself persists no lease, a busy global registry
acquire rolls back without creating a binding, and no materialization starts, so
the owner may retry with a new request. Any outcome at or after lease acquisition
or the start of materialization remains `held` - partially applied or unknown -
and is never retried, released, promoted or cancelled. A held record blocks a
later preview for the same durable origin head; the supported recovery path is to
restore a later verified archive into a new generation (which clears executable
epoch authority), never to edit, delete or reinterpret the held record. Current
live coding projections (`coding.show`, `coding.diff`, `coding.panel`) remain
current-epoch/owner-scoped and refuse old task IDs; they are not an
archived-execution read authority. Exact original task, changeset (including the
stored diff), review, run, application and decision records remain readable as
immutable evidence through the verified format-2 archive and the profile-owned
frozen `restore-origin` database plus `assets/evidence`; reading that evidence
grants no execution authority, and only newly authorized work can execute.

Desktop storage transition: the owner preview exposes the planned new-profile
binding for the epoch as `profileId`, `epochId`, root
`profile/desktop-<epoch>/tree`, the exact archived Desktop evidence hash and
`identity: null`. The materialized directory's inode identity cannot exist before
the effect, so publication fixes the real new-profile `identity` in the durable
`desktop_assets_binding` row and verification requires it to equal
`desktopRootIdentity(new root)` and to differ from the archived binding identity;
the archived absolute `root`/`originalRoot` are inert provenance and are never
opened as storage authority. Archived pre-ready operations remain exactly as
recorded: a started preparation (including any retained alias evidence) stays
`started`, is surfaced as an operation-scoped hold, and neither rebind nor
storage rebinding promotes it to `completed` or retries it; a new call with that
request id keeps returning `desktop_outcome_unknown`.

Honest limits of this development source: a new selected project root is
required, and the exact original project root/global lease is never reclaimed or
released by rebind. A restored context without the 7.9 frozen-origin evidence
(`restore-origin`, `assets/evidence`, optional `restore-lineage`) remains
read/text-only and refuses rebind; restore again from an archive produced by this
code to gain the evidence. Preparing a backup of an origin-bearing profile
requires the frozen-snapshot lineage reader; a preparation that supplies the
durable restoration state without it refuses `restoration_lineage_required`
before creating a destination, so an archived old-profile Desktop binding is
never archived as current live authority. The live ready record's fresh Git administration and
loose branch reference live under the selected project's `.git`, so a backup
after the project is deleted refuses rather than omitting them. Desktop rebind
materialization and the live binding switch are exercised end to end through the
maintenance host/SDK on a genuine source-deleted format-2 fixture with an
enrolled binding, a completed preparation and a started operation, including two
reopenings after an actual SIGKILL; the old absolute provenance path is replaced
by a decoy and is never read. A later owner-confirmed rebind can select an
archived task through the bounded parent chain: after a lineage backup, deletion
of every previous source/archive, independent verification and restore, the
second epoch/task materializes from the parent envelope while archived epochs,
tasks and approvals stay inert. Pre-ready intent capture is exercised with actual
SIGKILL-held partial materialization, a dangling workspace alias, a substituted
Git administration/backlink and a torn registration, each of which refuses
backup with its source evidence retained. A dedicated configurable-limit test on
the same real session path proves stored, logical, metadata and entry ceilings
are shared across the chain without deduplication, refuses before publication,
retains a refused incomplete destination and shows the independent verifier
rejects it.
