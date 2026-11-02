# Ocean 1.1 coding backup development

Status: stage 7 in progress. Validated database inventory and an ownership-held
capture port are implemented. Selected-root manifests and content-addressed archive copy are implemented.
Selected-root quarantine materialization is also implemented.
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

The deterministic content-addressed inventory includes minimal task references,
worktree bindings, changeset tree/hash references and application identities.
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

A missing ready root fails missing_coding_worktree. A missing preparing/uncertain
root remains an explicit absence, even if the managed directory has not yet been
created. No root, branch or file is automatically recreated or removed. Existing
roots must be private owned canonical directories. Each source supplies a portable
tree capture plus required Git pack/index to a sequential trusted consumer. The
returned catalog binds their hashes; the caller must still write and independently
verify every referenced output before publishing a complete profile backup.

After the last consumer, ALL earlier roots and Git index/packs are observed again,
as are absences and managed-directory identity. Earlier source mutation, an index
change without working-file changes, or an absent root appearing refuses rather
than producing a stale multi-task catalog. Comparison hashes/limits are captured
before passing consumer DTOs; consumer changes cannot alter the expected sources.
Limits aggregate across tasks: 2 GiB tree/index/compressed-pack bytes and separately
2 GiB tree/index/uncompressed-Git bytes, 100,000 filesystem entries and separately
100,000 Git objects. Duplicated objects across tasks count again conservatively.
Only one task's file manifest/pack is passed at a time, not all pack Buffers retained.

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
Independent review found no blocking subgraph issue; its compressed-versus-logical
limit clarification led to the separate aggregate uncompressed Git bound.
At this checkpoint root check passes 899 tests (41 opt-in skipped), build and
format pass. Two separate native tests pass: protected hardlink-alias refusal
with zero content reads plus real child-mount refusal in the qualified worker,
and the built-code quarantine SIGKILL scenario.

This is the managed-worktree subgraph, not the complete profile graph. Partial
Git administration for absent intents, retained apply originals/intents, registered
project configuration, explicit dependency roots and external-link mapping still
need graph selection/verification. No execution authority is restored, no source
checkout paths are rebound and the user-facing format-1 backup refusal remains.

## Remaining format-2 work

Build the complete bounded external graph from these references, including all
managed worktree bytes, required Git administration/object closure, staged data,
retained apply originals/intents and profile coding configuration. Distinguish
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
