# Ocean 1.1 coding backup development

Status: stage 7 in progress. Validated database inventory and an ownership-held
capture port are implemented. Selected-root manifests and content-addressed archive copy are implemented.
Selected-root quarantine materialization and interrupted native worktree-create
evidence capture are also implemented. The shared-runtime source delivery is
accepted through correction `dc9e244` and acceptance `56bbef0`; capture still uses
the actual ownership-held frozen SQLite API, without ownership bypass.
Workpackage 7.5 is accepted at `a6b3958`, including independent Git object
identity/closure and compressed/inflated/reconstructed pack bounds. Workpackage
7.6 is accepted at `ce482d5` and adds the frozen configuration/dependency subgraph described below. Workpackage 7.7 adds the [runtime-owned Desktop subgraph](desktop-assets.md), pending independent acceptance.
Complete external-asset graph selection, format-2 publication and full profile restore
are not implemented yet. User-facing
backup still refuses external coding assets with coding_assets_unavailable.
This boundary must remain until all asset completeness/restore gates pass.

## Validated frozen inventory

readCodingBackupInventory reads SQLite metadata only. It never opens a task's
project/worktree/Git path, migrates a profile or takes over an active owner.
It rejects live ownership, broken foreign keys, invalid task/worktree bindings,
missing artifact/application references, incorrect changeset payload hashes,
invalid base/tree hashes and mismatched application file ordering/statuses.

The deterministic content-addressed inventory includes bounded, strictly validated
task policyVersion/policy/testPresets evidence and minimal task references,
worktree bindings, changeset tree/hash references and application identities.
Each frozen application includes its ordered file paths and statuses and a
recoveryProtocol of 2 or null. An absent historical marker becomes null only in
the inventory projection. The stored receipt keeps its original fields.
Authoritative approvals, messages, evidence, review/resolution records and exact
changed-file contents remain in the complete SQLite snapshot; they are not
replaced with this reduced reference list. Inventory format 1 describes this
internal DTO, not the public backup format version.

Explicit inventory limits: 1,000 tasks/worktrees, 10,000 changesets/applications,
64 MiB per stored payload, 256 MiB aggregate examined payload and 16 MiB of
reference/path-validation metadata. IDs and payload sizes are enumerated before
loading large records. Artifact path lists are cached within the metadata bound,
so repeated applications do not reparse large immutable artifacts. Oversized
or invalid metadata refuses rather than returning a truncated catalogue.

## Ownership-held database capture

snapshotCodingDatabase is a low-level adapter API. It acquires the source's
exclusive maintenance ownership, makes and verifies a standalone SQLite copy,
clears only the copied owner row, then invokes a trusted asset-capture callback
with a clone of the frozen inventory. Ownership remains held throughout that
callback. A second runtime cannot acquire the source while assets are observed.

The copied database uses DELETE journal mode so its authoritative pages are in
one file. A stable regular single-link file digest is streamed in bounded memory
before and after the callback; inventory identity is checked again too. A callback
that changes the frozen database fails snapshot_mismatch. Success returns the
summary/inventory and callback result, not a complete backup manifest. The host
must independently prove the external graph and publish/verify format 2.
Errors release source ownership. The existing snapshotDatabase API retains its
external-assets refusal; format-1 backup/restore behavior remains in place.

Real temporary Git/profile tests prove live-owner refusal, cross-reference/hash
checks and deterministic inventory even if the project is subsequently absent.
That last case proves metadata isolation, not that missing assets are acceptable
for a full backup. Record-limit tests refuse before parsing unbounded history.
Ownership tests check the callback interval, standalone copy and database-tamper
failure. At the inventory checkpoint on Linux x86_64 / Node 26.13.0 / pnpm
12.16.1, root check passed 839 tests
(39 opt-in skipped), build and format pass. Independent review found no blocking
issue in this foundation; it did not qualify a complete archive or restore.

## Selected-root file manifest

captureCodingAssetTree now captures a chosen Linux root through pinned directory
FDs, without following filesystem symlinks. Portable manifests preserve raw
binary bytes by SHA-256/size, ordinary modes, empty directories, internal hardlink
relationships and inert symlink target text. First full file data is counted once
per inode within the root. External aliases/targets are not implicitly captured.
This is a selected-root manifest, not proof that the complete referenced graph
has been selected or archived.

Source identity evidence (device/inode/mode/owner/link count/size/mtime/ctime)
is separate from the portable manifest hash. File/parent/root checks and two
complete passes refuse observed changes. A copied root can have the same portable
manifest and a different source identity. Invalid UTF-8 names, special file types,
special permission bits, foreign owners and unplanned file/directory child mounts
refuse rather than being silently omitted. Linux own-FD mount IDs are checked
before file reads; no source project code is invoked.

Limits: 2 GiB unique file bytes, 100,000 total entries, 128 levels, 4 KiB relative
paths/link targets and 32 MiB serialized entry/signature plus queued-name budget.
Options can only lower these limits. File hashing reuses a 1 MiB buffer. Directory
names are read in bounded batches and share one global pending count/byte budget,
including ancestor lists; processed Buffer references are released before descent.
Independent review found an initial ancestor-list accounting gap; its nested-wide
regression failed before the fix and now refuses within the global bound.

Tests cover exact binary/BOM/CRLF bytes, modes, empty dirs, hardlinks, inert escaping
links, portability, unsupported inputs/limits and content/parent swaps mid-read.
A simulated child mount refuses before body reads. Separately,
`OCEAN_SANDBOX_NATIVE=1 pnpm test packages/tools-node/src/coding-asset-native.test.ts`
passes on the target laptop: the built scanner runs inside the qualified isolated
worker, verifies distinct real mount IDs and equal UID, refuses a read-only
mounted dependency subtree, and confirms cgroup cleanup. No real profile/key is
used. Root check passes 846 tests (40 opt-in skipped), build and format pass.
Independent review confirms the resource-bound fix and mount-check delta.

Asset selection, credential/path policy, external symlink/object closure,
graph-wide copy/materialization and full profile archive verification still
belong to the next layer. This scanner neither chooses host roots nor publishes a backup, and its
symlink records must not be treated as permission to follow those targets.

## Selected-root content archive

archiveCodingAssetTree copies one previously captured root into a new private
canonical destination. It rechecks the source capture, pins source parents/files,
compares physical identities before reading and streams exact bytes into private
SHA-256 named blobs. Equal content is stored once. Directories, modes, hardlinks
and symlink targets remain manifest data; no archived symlink is activated.
Raw source identity evidence is not part of the portable archive manifest.

An fsynced .incomplete intent precedes blob writes. Source changes, path swaps,
existing output or unsupported input refuse; failed newly created output is
retained for inspection, never recursively removed. Blob and manifest data and
containing directories are synced before successful return. This is a low-level
selected-root operation, not atomic publication of an entire profile backup.

verifyCodingAssetArchive accepts only the exact private manifest/blobs layout,
strict bounded manifest schema and content hash, earlier internal file hardlink
targets, valid parent directories and normalized paths. It verifies every blob's
size/hash, owner, regular single-link kind and stable identity without following
links. Extra/missing blobs, incomplete markers, malformed records, unsupported
paths and observed mutation refuse. Symlink target text remains inert even if it
names an external path; completeness policy must resolve or refuse it separately.

Regression tests cover binary copies/deduplication, corrupt and symlink/hardlinked
blobs, strict paths/structure/limits, source mutation during copy and destination
replacement. Both copy races retain incomplete output and preserve user bytes.
On the target Linux notebook, root check passes 858 tests (40 opt-in skipped),
build and format pass; the separate native child-mount test passes again after
the scanner change. Independent review found no blocking archive issue.
This does not yet provide root selection, credential policy, Git object closure,
full profile restore or a user-facing format-2 backup.

## Selected-root quarantine materialization

validateCodingAssetLinks proves closure within one portable manifest without
opening host targets. Resolution follows intermediate symlinks before processing
later dot/dotdot components, refuses absolute/escaping/missing targets, file
traversal and cycles, and preserves literal Linux backslashes. Limits are 40 link
expansions per resolution, 8,192 queued components and 1,000,000 total component
steps; an oversized valid graph refuses instead of consuming unbounded work.
External dependency relationships need the future graph layer's explicit mapping.

restoreCodingAssetTree first verifies the entire archive and internal link closure,
then creates a new private quarantine container with a durable .incomplete marker.
It copies verified blobs to newly created files through pinned directories, creates
internal links after regular data, restores modes and syncs files/directories.
The restored tree is beneath the private container even if original modes are
public. A full portable rescan and repeat archive verification must match before
removing the incomplete marker. Existing output refuses; failures retain partial
output without recursive cleanup. No source checkout/database is changed, no Git
command/hook runs, and no coding authority is activated or rebound.

Tests cover exact binary/mode/hardlink/symlink round trip, source independence,
missing/external/cyclic links, component semantics, traversal bounds, corruption
before output creation, archive mutation and destination replacement during copy.
A separate opt-in built-code process test SIGKILLs after the first 1 MiB write:
partial output retains .incomplete, retrying that destination refuses, source and
archive remain unchanged, and an explicitly new destination restores correctly.
This passes on the target notebook without a provider or real profile. It proves
one selected-root interruption boundary, not complete profile crash recovery.
Independent review found no blocking issue in internal closure/materialization.
At this checkpoint, root check passes 872 tests (41 opt-in skipped), build and
format pass. The real SIGKILL scenario is qualified separately from that suite.

## Required Git object capture

captureCodingGitObjects captures a bound task's base commit/history and staged
index object closure into a self-contained Git pack, alongside exact raw index
bytes and SHA-256 digests. Worktree bytes remain a separate required asset. It
validates canonical worktree/common/admin paths, .git/back pointers, HEAD and the
exact task branch base before and after capture. SHA-1 and SHA-256 repositories,
packed refs and packed objects are covered. Source refs/config/hooks/reflogs and
unrelated branch objects are not copied into this pack.

Git runs with a newly synthesized private bare config, an inherited pinned index
and object directory, no host/global/source config, replacement refs or lazy fetch.
Only fixed local ls-files, rev-list, cat-file and pack-objects commands run. Source
files/index/refs are never written. Temp config cleanup removes only fixed files
created by this operation through a pinned scratch directory; unknown contents
refuse cleanup rather than recursive deletion. Metadata-only object-store walking
uses Linux O_PATH FDs and own mount IDs before object reads. Alternates, promisor
layouts, symlinks, multiply-linked objects, child mounts, unsupported names/types
and changed identities refuse. Unsupported split-index layouts do not return an
apparently complete capture.

Limits: 16 MiB raw index, 100,000 combined staged/resolve-undo entries and reachable
objects, 64 MiB per object, 2 GiB aggregate uncompressed selected objects, 256 MiB
pack output; object-store metadata enumeration is capped at 100,000 names and a
32 MiB accounting budget. Each fixed Git command has a 60-second timeout and pack
compression uses one thread. These are bounded trusted host operations, not a
claim of sandbox/cgroup memory qualification for backup. Errors do not expose raw
Git stderr through the adapter.

Independent review found missing resolve-undo (REUC) objects in the first version.
Its regression failed before the fix: current staged entries alone omit earlier
conflict blobs referenced by the index. Both stage and resolve-undo roots now feed
the pack. A fresh repository imports the pack/raw index and successfully recreates
the conflict with checkout -m. Tests also prove unrelated synthetic secret objects
are absent, a malformed source include config is never consumed, SHA-256 and packed
storage round trips work, and a changed index refuses without overwriting user
bytes. FIFO index substitution refuses without a blocking open, and malformed
branch refs refuse instead of silently normalizing an invalid identity. Missing
alternate targets are not implicitly traversed. This object-capture foundation
does not yet select every task/asset or publish a complete backup.
On Linux x86_64 / Git 2.56.0 / Node 26.13.0, root check passes 885 tests
(41 opt-in skipped), build and format pass. The source scanner mount primitive
and interrupted quarantine built-code scenarios are qualified separately.

## Managed worktree subgraph

captureCodingWorktreeAssets consumes the frozen database inventory under the
caller's maintenance ownership. Every root and branch must match the original
hash plan over profile owner, project root and task ID beneath the explicit
managed directory; task/worktree/lease bindings and inventory hash must agree.
Roots are not inferred from arbitrary .git pointers or user home directories.

Ready roots retain the required private directory and present-index contract. A
missing ready root fails `missing_coding_worktree`; a missing/corrupt ready index
is never replaced with an empty index. Preparing and uncertain records use an
explicit fourth `consumePartial` callback. An old absence-only consumer refuses
with `partial_coding_consumer_required`. Every partial catalog row commits the
actual nullable tree/index hash, required base pack hash and administration hash.
A partial row never means ready or a complete profile backup.

The Linux collector supports the native `worktree add --no-checkout` order:

| Frozen preparation observation                     | Retained evidence                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Plan persisted, root/admin/branch absent           | Explicit absences and base/history pack                                                 |
| Exact task branch exists, root/admin absent        | Exact base ref, absences and base/history pack                                          |
| Complete bound admin survives, root absent         | HEAD/commondir/gitdir bytes, any raw index, base/index object closure                   |
| No-checkout root before/after chmod                | Actual tree (including inert .git), complete admin, explicit absent index and base pack |
| Partly or fully materialized tree before read-tree | Actual binary bytes/modes, complete admin, absent index and base pack                   |
| Read-tree finished but preparing/uncertain remains | Actual tree, exact raw index including stage/REUC roots, admin and object pack          |

The pre-chmod root may be 0755 only beneath a pinned private managed ancestor,
with the exact frozen slot and reciprocal Git attribution. This does not weaken
the ready-root or generic archive origin contracts. A surviving external common
Git directory can prove binding when the original checkout is absent; no original
checkout body is read. Missing common/base objects refuse.

A metadata-only pass proves every selected Git binding/storage layout and every
protected tree namespace before any selected object/tree body is read. Each
capture repeats this ordering, and the full metadata preflight runs again after
the last consumer. A protected later root therefore prevents earlier object/body
reads too.

Attribution inspects only the exact task ref and bounded, strictly parsed packed-ref metadata,
root .git, and the native slot or numeric-suffix admin candidates. Multiple
candidates, incomplete/mismatched pointers, lockfiles, reftable storage and
unknown per-worktree administrative files refuse before task-body traversal.
The retained administrative bodies are exactly root .git when present and admin
HEAD, commondir and gitdir when present; index is separate nullable binary data.
Empty admin refs and the optional logs/HEAD namespace are checked with bounded
metadata. Reflog bodies, arbitrary common/config/hooks, other worktree bodies and
unrelated object closures are not copied. ORIG_HEAD from an ordinary Git checkout
is outside the partial native-create shape and refuses; strict ready capture is
unchanged. Pointers remain inert evidence, never restoration destinations.

Objects use the same synthesized sterile Git repository for SHA-1/SHA-256 and
loose/packed storage. No source/global executable Git config, hooks, filters,
lazy fetch, network or inherited environment secrets are used. No absent index
is fabricated. `archivePartialCodingGit` writes a new private inert evidence
folder, retains an incomplete marker on failure, and checks a private originating
handle before and after copying. `verifyPartialCodingGitArchive` accepts an
expected manifest hash, checks bounded metadata and every retained digest, and
refuses missing/corrupt evidence. Independent tests import the pack and optional
raw index into a fresh private Git repository after source paths disappear.
Capture and independent archive verification also import the bounded pack into
an isolated private Git repository with synthetic configuration. They compare
actual packed object IDs, types and sizes with the manifest and prove the full
base/history plus available raw-index stage, sparse-tree and REUC closure.
SHA-1/SHA-256 and packed/delta objects are supported. Valid compressed bytes under
a false loose-object pathname refuse before capture succeeds; archive failures
retain the incomplete marker. Pack entry inflation (including delta instructions)
has a separate cumulative 2 GiB budget, charged before decompression; actual
decoded lengths are checked.
The independent 2 GiB reconstructed-object budget also remains in force before
native import. This verification never reads source configuration or
writes source objects, refs or indexes.
Tree quarantine preserves partial binary bytes, modes and inert pointer text.
This is not profile restore, source rebind or authority revival.

Pinned nofollow descriptors retain inode, mount, UID/mode, content hashes and
absence witnesses through all consumers. Final verification rechecks every
partial binding, base/index closure, earlier tree and all absences after the
last consumer. Equal-size unchanged-time shared-mapping writes to HEAD, index,
branch, required objects or tree bytes invalidate. Consumer DTO mutation cannot
rewrite private witnesses or authorize a forged archive. Mount and namespace
substitutions refuse. No root, branch, index or admin file is repaired, pruned,
replayed, recreated or promoted.

Limits aggregate across tasks: 2 GiB tree/index/compressed-pack/administration
bytes and separately 2 GiB tree/index/uncompressed-Git/administration bytes,
100,000 filesystem/administration entries and separately 100,000 Git objects.
Existing per-file, index, object and metadata preflight bounds remain. Repeated
objects count conservatively; the collector retains descriptors/digests rather
than all consumed pack buffers. Graph-wide configuration/dependency budgets are
still a separate open integration gate.

The coding-worktree scan policy refuses known credential names/components before
body reads, including environment files, private keys and credential config files.
A bounded metadata-only pass checks the whole namespace before either content
pass; both content passes compare each initial identity against that preflight.
This prevents reading a protected file through an earlier-named internal hardlink
before encountering its protected name. The alias regression failed before this
change and now observes zero body reads.
Only a regular root .git pointer is accepted; nested Git administration and linked
.git pointers refuse. Dependency directories are preserved, not silently omitted;
protected files within them also refuse. Capture limits/policy remain attached to
source evidence and are reused by archive rechecks, including lowered limits.
Generic selected-root capture retains its explicit all-data policy for other trusted
roles. These policies do not prove absence of secrets hidden under arbitrary names.

Regression tests cover two task archives, untouched source checkout/user bytes,
forged plans, lost ready roots, valid absences, source/index/absence races, aggregate
uncompressed object limits and protected-body refusal. The built scanner's opt-in
worker fixture also checks credential-policy refusal with zero file-body reads
before the separate real child-mount refusal. It uses synthetic canaries only.
Independent review of the original ready/absence-only collector found no blocking
subgraph issue; its compressed-versus-logical
limit clarification led to the separate aggregate uncompressed Git bound.
At that original checkpoint root check passed 899 tests (41 opt-in skipped),
build and format passed. Two separate native tests pass: protected hardlink-alias refusal
with zero content reads plus real child-mount refusal in the qualified worker,
and the built-code quarantine SIGKILL scenario.

At the 7.5 implementation checkpoint the six real create-boundary SIGKILL tests
are part of the required process matrix. The separate Linux native run passes
20 cases: those six plus the inherited four-file 14-case suite. Independent
scoped review remains with the controller.

This is the managed-worktree subgraph, not the complete profile graph. Frozen
project configuration, explicit dependency roots, external-link mapping and unified
selection/verification of all retained subgraphs remain open. No execution authority is restored, no source
checkout paths are rebound and the user-facing format-1 backup refusal remains.

## Selected legacy apply-recovery assets

captureCodingApplyRecovery observes one explicitly selected private recovery root
and an explicit set of original project roots from the frozen task bindings. The
coding-recovery scanner policy checks the entire namespace before any body reads:
only flat UUID before/after/json/json.next files are accepted, with no directories,
symlinks or multiply-linked JSON records. Main/next JSON is capped at 2 MiB before
reading; total bytes/entries/metadata retain the selected-root scanner limits.
The policy and limits stay attached through archive rechecks.

Version-1 intent validation requires exact types/keys, project/path scope, ordinary
file modes, complete bounded before/after text with matching content hashes and
UUID-relative backup/staged names. Missing originals claimed by a completed record
refuse. A conflicting retained original is preserved as actual evidence, not
replaced with the old expected text. Status is descriptive data only: it never
settles a runtime receipt, proves a historical external outcome or authorizes replay.

A partial or invalid-UTF-8 .json.next is preserved as opaque bytes only alongside
a valid main record for that UUID. A fully decoded next record must agree with the
same immutable intent. Orphans, malformed main records and foreign project records
refuse before a capture can be consumed as valid. Source identities and body hashes
are checked during record reads and by a final full capture. Unknown files are
never removed, missing data is never reconstructed, and original checkout files
are never observed or changed by this collector.

Tests use real temporary apply operations and archives: original bytes, partial
next bytes, conflicting evidence, missing completed originals, foreign/malformed
intents, strict modes/status and mutation during decoding. Independent review found
status coercion could accept an array and bypass the missing-original check; its
regression failed before exact string validation and now passes. Native worker
canaries separately prove recovery-policy credential refusal with zero body reads.

This is a project-scoped legacy asset collector. Version-1 records do not identify
a profile, task or application; project scope alone must not be presented as exact
profile-operation attribution. The frozen recovery graph below adds candidate attribution. Full profile backup
still requires configuration and dependency closure, publication and quarantined
profile restore. New applications use the separate scoped layout
described below; this collector does not yet select or verify that layout.
User-facing backup continues to refuse external coding assets until those gates
pass. No approvals or execution authority are restored by this API.
At this checkpoint root check passes 905 tests (41 opt-in skipped), build and
format pass; the separate built-code worker credential/mount and quarantine
SIGKILL tests pass 2/2 on the target laptop.

## Exact scope for new application recovery

New GitCodingApplyProject effects retain evidence under the canonical Git common
directory at ocean-apply-recovery-v2/SLOT/scope.json and files/. Legacy
ocean-apply-recovery is untouched. SLOT is SHA-256 of canonical JSON with keys in
order: version (2), root, ownerId, taskId, applicationId, changesetHash. The header
is those exact JSON bytes plus one newline. The application supplies identity from
its trusted task, owner lease, receipt and immutable changeset only after the
per-file started receipt is durably stored. No model argument or filesystem
metadata confers that identity or grants execution authority.

The Linux adapter creates private owned directories through pinned directory FDs
with O_NOFOLLOW, verifies canonical paths and exact existing headers, and syncs
the header and directories before any project file effect. A synchronous callback
keeps the validated common/scope/files descriptors open throughout that effect;
recovery writes use the borrowed files FD rather than reopening its pathname.
Canonical directory bindings, private ownership and the exact header are checked
before project mutation and after displacement/publication. An observed binding
change throws and retains application uncertainty; no cleanup removes evidence.
Existing missing or corrupt headers/files directories refuse without repair or
deletion. Unknown
contents and retained originals remain evidence. Scope identifies an operation;
it never authorizes replay, resolves uncertainty or proves historical completion.

Focused tests cover identity separation, exact header reuse, legacy preservation,
corrupt/missing header and missing-files refusal. Review found and reproduced a
pathname handoff substitution in the initial implementation. Deterministic
regressions now replace the scope/files directory or header at effect-root open
and require refusal before source mutation; a swap after displacement must leave
the original and started intent under the pinned directory and throw. Both old
and replacement directories are preserved. A real SIGKILL immediately after
scope.json fsync leaves only the header: two runtime openings retain its exact
bytes, preserve unchanged project files and the unresolved hold, refuse replay,
and do not recreate files/. These are synthetic trusted seeded-receipt crash
fixtures, not admission or power-loss qualification. Separate direct/group native
workflows qualify actual admitted application. See [coding recovery](coding-recovery.md).

At the corrected 7.1 checkpoint, root check passes 913 tests (41 opt-in skipped), build and
format pass; the separate seven-boundary SIGKILL plus direct/group native suite
passes 9 tests on the target Linux laptop. Installed 1.0 artifacts are unchanged.
At the initial scoped-writer checkpoint, graph capture, legacy attribution, configuration/dependency
closure, format-2 publication/restore and installed/interactive/RC qualification
remain open. User-facing backup retains its external-assets refusal.

## Source capture for a frozen protocol-2 application

New application claims persist numeric recoveryProtocol 2 before the first
file starts. The marker is immutable and part of the shared journal claim
fingerprint. Earlier receipts, including receipts from the initial scoped writer,
can lack a marker. Their layout and exact operation attribution remain unknown.

The tools-node adapter `captureScopedCodingApplyRecovery` accepts the trusted
canonical Git common directory, original project-root identity, operation context
and one frozen inventory application. It checks the numeric marker and
task/application/changeset identity, derives the slot itself and opens only that
operation below `ocean-apply-recovery-v2`. The caller binds the common directory,
original project and owner from the frozen task/worktree and holds maintenance
ownership. The collector reads recovery bytes. When a staged file has two links,
it checks metadata at the exact bound checkout path with Linux O_PATH. Its result carries
the frozen status, context and slot alongside one of four source observations.

| Presence    | Evidence                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| absent      | No scope exists and no file has a completed receipt. Includes an empty completed changeset.                                                 |
| header-only | Exact canonical header without a files directory after a file started.                                                                      |
| incomplete  | Empty leaf, bounded partial header before files creation, missing started/uncertain file intent or a still-started native intent.           |
| scoped      | Valid header and files directory, with a completed native record for each non-pending receipt path. The application can still be uncertain. |

Every present leaf yields the portable manifest and physical source identities
for its actual contents, including empty directories, header bytes and ordinary
modes. A conflicting decoded header, missing completed-file record or required
original, orphan UUID, malformed main intent, duplicate or foreign path, and
an intent for a pending file each refuse capture. Each record distinguishes a
matching original, conflicting actual bytes or executable mode, absent original
and an addition that required no original. A bounded opaque partial next record
is retained only beside a valid main record. A decoded v2 next record must
complete the same started intent. At that boundary the staged after-image is
gone and a displaced original must be present if the intent required it.

Before reading even the header, a metadata pass checks the entire leaf. Its
namespace permits only private scope.json (64 KiB), the private files directory
and flat UUID .before/.after/.json/.json.next files (2 MiB per JSON record).
Symlinks, unproved hardlinks, special nodes, foreign owners, child mounts, unknown names and over-budget
trees refuse. Selected-root limits still bound all bytes, entries and metadata.
The manifest must match the digest of the exact header bytes used for
classification, including an opaque partial header. After intent decoding, a
final traversal through the pinned leaf rechecks every content hash and source
identity. This catches writes through shared mappings even when inode, size,
mtime and ctime stay fixed. Archive recapture uses the same namespace policy.

Synthetic cases cover archive verification and private quarantine materialization
of the entire leaf, source swaps and content mutation, and zero body reads for
forbidden names or oversized JSON. Direct and group native workflow fixtures
capture their admitted completed apply from an ownership-held frozen inventory.
The nine SIGKILL boundaries also exercise source classification after reopening.
These observations describe retained evidence only. The next section extends this collector across frozen operations.
Configuration/dependency closure, format-2 publication and full restore remain open.

## Frozen recovery graph and selected files

The Linux host adapter `captureCodingRecoveryAssets(inventory, managedDirectory,
consume)` collects recovery evidence for every application in a validated frozen
profile. Hold snapshot maintenance ownership until collection and consumption
finish. Each changeset reference now carries ordered paths with before and after
mode/SHA-256 pairs, including null for additions and deletions. The SQLite reader
checks the immutable payload and hashes the file text before returning those
descriptors. This read still works after removal of the original checkout.

The graph verifies the inventory hash and binds each application to its task,
owner, changeset, ready managed worktree, derived branch and canonical Git common
directory. It reads the managed worktree's Git pointer and the matching
administrative HEAD, gitdir and commondir. A missing or rebound required
worktree refuses collection. Git binding uses no original checkout file bodies.
The sequential consumer receives one source capture at a time with its kind
and slot. The catalog binds the inventory hash, application references and
selected legacy evidence to their portable manifest hashes.

Every application's **presence** describes its expected v2 slot. Declared
protocol 2 uses the strict scoped collector. An unmarked receipt keeps its null
declaration even if the exact canonical header proves observed protocol 2.
A noncanonical unmarked leaf refuses collection. A missing scope leaves observed
protocol null. A declared interrupted header can likewise carry no observed
canonical header. Pending paths have no legacy effect demand. Started and
uncertain paths remain listed as unknown regardless of retained records.

For eligible unmarked files the collector inspects only the private flat legacy
directory in the bound common. It preflights the UUID namespace, inode types,
ownership, mount and JSON size/count bounds before reading main and next JSON.
It decodes and rehashes before/after text and matches the original project,
relative path, both Git modes and both content hashes. Every matching UUID
contributes its available files and the IDs of all candidate applications.
Unmatched valid records contribute only to the private stability check.
Their original and staged bytes are never read.

A record is marked ambiguous if several applications match its exact descriptor
or several candidate UUIDs match that descriptor for one application. Within
each descriptor group, a completed receipt file without exact v2 completion
requires a distinct finalized legacy main record. The graph counts these UUIDs
without assigning them. Decoded completion-next evidence still needs its retained
original and does not cover a completed receipt file. Opaque partial next bytes
are preserved beside a valid main. A missing required original, orphan or
unsupported phase refuses collection. A conflicting retained original is
reported and preserved in its actual mode and bytes. When both layouts contain
eligible evidence both captures are retained. No observation settles a receipt.

`captureCodingAssetFiles` takes explicit normalized relative endpoints, emits
them as a sorted `selectedFiles` list in the manifest and includes the real
ancestor directories. Rechecks retain this selection, the path policy and lowered
limits. Archive accepts an originating in-process capture handle and checks a
private digest of its original fields before accessing any source. It uses a
verified copy for the entire archive operation. A rehashed DTO or a clone cannot
authorize source reads. Existing portable archives can be verified and restored
in a separate process. Both content passes require the root mount observed in
metadata preflight. Generic selected files require all hardlink names to be
selected. This prevents a harmless-looking name from exposing an unselected credential inode.
Classified legacy .before/.after files can retain a link outside recovery during
an interrupted host apply. Only the selected inode bytes and internal aliases are
materialized. No external alias is followed or recreated.

Each graph pass limits selected outputs to 2 GiB and 100,000 entries, catalog
and reference metadata to 16 MiB and classified JSON to 256 MiB and 10,000 main
records. Repeated references are charged conservatively. After the final
consumer a fresh pass verifies every binding, including the managed checkout
mount. It also verifies every scope, observed absence, selected manifest,
physical identity and classification digest, including the JSON of
unmatched UUIDs. A changed source refuses the graph. No source is repaired.

These fixtures qualify read-only host I/O on synthetic repositories, including
unchanged-timestamp shared-mapping writes. Direct/group native workflows also
exercise graph collection inside the frozen callback. The API grants no sandbox
execution authority. Public format 1 still refuses profiles with external
coding assets.

## Interrupted staged publication

After the native writer links a staged replacement at its project destination,
a process kill can leave both names on one inode. For a declared protocol-2
receipt the collector accepts exactly two links to an owned regular UUID.after.
The native writer finishes each file before starting the next. A scope with
multiple linked staged names therefore refuses during metadata preflight,
before any main record or staged body is read.
The canonical header and strictly decoded started main must bind a unique started
or uncertain receipt path. The intent must declare an after-image, have no next
record and retain its original when required. Header, JSON and UUID.before files
still require a single link. The graph also checks the frozen changeset modes
and hashes before inspecting the destination.

The host walks only the canonical destination components with no-follow O_PATH
descriptors. It checks the destination inode, device, link count and mount against
the staged descriptor. Absent, foreign, symlinked or rebound names refuse capture.
The collector hashes the classification JSON and compares it with the actual
captured bytes. The originating capture carries private guards for later archive
reads. They recheck the scope, phase and project binding around the read, then
verify the staged hash and binding after the other scope entries. The graph
checks these witnesses again after its last consumer.

The catalog reports `publicationLink` as `matching` or `conflict` based on the
observed after bytes and executable mode. The portable manifest describes an
ordinary file with its actual bytes and permissions. Restoring it creates an
independent file under quarantine. Original project pointers remain inert and the
receipt keeps its unknown effect. The native suite covers nine SIGKILL boundaries,
one published-link frozen graph and quarantine round trip, both admitted direct
and group workflows, and two native asset tests (14 tests total).

## Frozen configuration and dependency subgraph (7.6)

`captureCodingDependencyAssets` accepts the ownership-held frozen SQLite inventory,
the exact private profile directory, originating task-tree capture handles and a
sequential archive consumer. It never calls live project registration, workspace
canonicalization or effecting tool preparation. Task registrations match the frozen
`projectRoot`; the registration ID and Ocean workspace ID are separate identities.
Every task must have one matching registration with exactly matching test presets.
All registrations remain in the catalog: selected entries name required mounts;
unselected entries are explicitly `metadata-only`, and their project bodies are
not visited. The original source checkout may be absent.

| Input/state                                                                                                    | Implemented result                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Private `coding-projects.json`, at most 1 MiB                                                                  | Exact bytes/base64 and SHA-256, strict schema, all entries retained                                           |
| No registry and no frozen tasks                                                                                | Explicit absence; profile directory and absence rechecked                                                     |
| Missing registration, changed task policy, duplicate/conflicting registration                                  | Refused                                                                                                       |
| Standalone owned executable file mapped to `/toolchain/pnpm/bin/pnpm`                                          | Selected-file archive preserves bytes/mode; symlink or multiple links refused                                 |
| Exact `dependencyProjectRoot/.../node_modules` mapped to `/workspace/.../node_modules`                         | Full selected dependency-root archive, owned ordinary nodes only                                              |
| Internal hardlinks                                                                                             | Original group identity preserved; external/unselected aliases refused before bodies                          |
| Relative dependency/package symlink                                                                            | Original link text retained; virtual resolution must reach explicit mapped roots or supplied frozen task tree |
| Workspace package source missing from captured tree                                                            | Refused, with no original-checkout traversal or link rewriting                                                |
| No task-tree input                                                                                             | `treeSelection: not-supplied`, `treeHash: null`; not evidence that a required ready worktree was backed up    |
| Task tree supplied                                                                                             | Originating capture required, exact frozen task root bound, bytes and identities rechecked                    |
| Unknown/overlapping mounts, root/home mappings, protected names, child mounts, special nodes or unsafe aliases | Refused before selected dependency bodies                                                                     |

The profile/configuration no-follow descriptors witness owner, private mode,
link count, mount, directory identity and exact bytes. Explicit dependency mapping
roots and selected tree/file sources retain private witnesses. A whole-subgraph
metadata preflight precedes dependency body reads. After the last consumer, every
source, task tree, mapping root and registry/absence is checked again, including
content hashes that detect same-size, unchanged-timestamp shared-memory writes.
Task-tree metadata is checked against its original private witness before any
initial or final body read. The archive uses the same capture lifecycle for tree
and dependency consumers: every selected task/root/policy, current tree namespace,
virtual mapping and shared budget is validated before the first tree copy. Budget
preflight includes the complete frozen inventory, retained tree witnesses and the
prospective catalog; it charges each snapshot incrementally before retaining more.
A later invalid/stale/over-budget tree therefore cannot cause an earlier tree to
be copied. The optional tree consumer receives only newly verified originating
captures after this shared preflight. Unchanged-timestamp content mutation still
refuses at the hash check. Consumer DTO mutation cannot redefine those expectations.
No source is repaired,
reset, cleaned, pruned or modified. Failed output remains incomplete evidence.

One shared subgraph budget limits stored and logical bytes to 2 GiB and entries
to 100,000; hardlink logical sizes count at every retained name. Registry, mappings,
catalog and source-witness metadata count toward the budget; metadata is capped at
32 MiB and the portable catalog at 16 MiB. Existing selected-root depth, path/name
and file bounds remain. Captures are consumed sequentially; the collector retains
bounded manifests/witnesses, not duplicated file bodies or Git packs. Git's accepted
7.5 pack/object integrity and independent bounds are unchanged. A future unified
graph must charge worktrees, Git, recovery, dependencies and Desktop assets together.

`archiveCodingDependencyAssets` writes a new private subgraph archive with an
incomplete marker, exact frozen inventory/catalog and the selected tree/file
archives. `verifyCodingDependencyArchive` independently verifies all bytes and
reconstructs policy/configuration/mapping/link bindings without opening any original
absolute path. `restoreCodingDependencyTask` materializes one virtual task under a
new private quarantine from those verified archives, with unchanged relative link
text, ordinary modes and internal hardlinks. The original configuration remains
inert archive data. It grants no execution, project rebind, approval reuse or effect
settlement. These APIs are composable subgraph primitives, not public format 2 or
full-profile restore.

Synthetic tests cover ownership-held snapshot binding, removed original checkouts,
removed archive sources, private/absent registry, missing assets, policy conflicts,
unsafe names and aliases with zero dependency body reads, mapping mount replacement,
consumer mutation, mmap writes, corrupt/missing archive inputs and quarantine links.
A separately qualified Linux worker proves actual child-mount denial and loads a
restored workspace package after source removal. That native fixture first failed
before worker launch due to its mountpoint setup; the corrected worker run passes.
No installed profile, key, provider or user coordination registry is used.

## Remaining format-2 work

Integrate the selected managed-worktree, partial Git, recovery and frozen
configuration/dependency subgraphs with the complete bounded external graph.
The Desktop subgraph and trusted isolated legacy enrollment are implemented in
7.7 development source (not part of accepted 7.6); independent acceptance and
unified integration remain open. The receipt link/unlink alias interval still
refuses capture and preserves source evidence. Full backup must support required
partial states or truthfully refuse, never silently omit them. Distinguish
planned-but-absent assets from lost ready assets. Resolve dependency/symlink
relationships explicitly; never traverse arbitrary home/root paths as a shortcut.
Preserve required data or refuse unsupported layouts without a false full-backup
claim. Do not automatically read/copy provider-key files or enable project hooks.

Capture with pinned paths, per-file hashes/size/mode, stable source verification,
private output ownership and confirmed cleanup only of newly created output.
Verify missing/corrupt/escaped assets as restore failures. Restored assets belong
in a private quarantine with old approvals/authority inert until explicit owner
rebind and effect reconciliation. Maintain old format-1 compatibility and verify
the full installed Linux round trip before marking this gate complete.

## Desktop attachment/preparation subgraph (7.7)

The ownership-held callback now receives a second frozen Desktop inventory,
independent of coding tasks. It includes trusted canonical root binding, exact
message/send-request relationships, durable operation states and incomplete
upload evidence. Runtime owns all new filesystem writers and isolates imported
legacy sources through verified copy and a durable binding switch. The four
public Desktop capture/archive/verify/materialize ports compose with this copied
SQLite snapshot; they are not unified format 2. See [exact protocol and limits](desktop-assets.md).
Bound Desktop assets and unenrolled legacy markers refuse new format-1 backup;
old text-only format-1 restore compatibility and external-coding refusal remain.
Full global budgets, complete restore/rebind and release/crash gates stay OPEN.
