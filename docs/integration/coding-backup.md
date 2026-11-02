# Ocean 1.1 coding backup development

Status: stage 7 in progress. Validated database inventory and an ownership-held
capture port are implemented. Complete external-asset manifests, archive copy,
format-2 publication and full restore are not implemented yet. User-facing
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
copy/materialization and full archive verification still belong to the next
layer. This scanner neither chooses host roots nor publishes a backup, and its
symlink records must not be treated as permission to follow those targets.

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
