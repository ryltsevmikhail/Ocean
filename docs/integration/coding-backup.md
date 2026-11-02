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
failure. On Linux x86_64 / Node 26.13.0 / pnpm 12.16.1, root check passes 839 tests
(39 opt-in skipped), build and format pass. Independent review found no blocking
issue in this foundation; it did not qualify a complete archive or restore.

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
