# GitHub read-only pilot: stable source qualification

The stable source candidate passed a real GitHub read-only qualification on
2026-11-04 through the normal runtime owner, asynchronous CLI commands and chat
tool dispatcher. This does not qualify an installed Desktop/TUI artifact or
declare Ocean 1.1 released. The frozen RC2 record describes its earlier artifact.

The shipped catalog still contains one GitHub pilot, with exactly `list_issues`
and `issue_read`. The trusted host supplies `X-MCP-Tools: list_issues,issue_read`
and `X-MCP-Readonly: true` to `https://api.githubcopilot.com/mcp/`. These are
[GitHub's documented server controls](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md).
Models and clients cannot select endpoint headers or broaden the manifest.
An extra, missing or duplicate tool, incomplete catalog, refused connection or
stale authority prevents publication. Account identity remains **unverified**
unless the adapter actually provides verified identity evidence.

## Owner activation and recovery

Supply the token to the runtime's environment under an explicitly named
reference. Only that name is stored in the profile. Plugin commands require a
running owner; an offline CLI does not create an ephemeral SDK session or
automatically start a runtime. Install and enable the GitHub catalog entry,
add the connection with `--credential-env NAME`, acknowledge metadata consent
for the displayed generation, discover, then grant the exact room, bot,
repository and tool set. The plugin settings page and CLI/TUI show readiness.

`active` describes the connection record; `ready` means its current SDK session
also has proven continuity. `discovery_required` means tools cannot be granted
or advertised for use. The owner must enable the installed plugin if needed,
give fresh metadata consent, discover and grant access again.

A full runtime restart deliberately requires that recovery. SDK credentials
and contexts are memory-only; no persistent credential revision or SDK database
is introduced. On startup, the exclusive runtime owner clears unproven published
schema, identity and consent, increments the generation and revokes grants in
one existing SQLite transaction. Startup makes no external request. Detaching
or reconnecting a client does not restart this authority or revoke grants.
Schema version remains **19**.

Changing the connection or the raw credential behind its environment reference
also makes old authority unusable. Each consented discovery uses an isolated SDK
host and immutable credential/endpoint/plugin/adapter/generation snapshot.
Only successful durable publication activates that context. Identical
rediscovery can preserve grants only while exact local continuity is proven;
schema changes revoke them before the replacement becomes executable.
An already admitted call keeps its original account and route.

## MCP dispatch policy

The host explicitly selects the pinned SDK's supported `legacy` MCP negotiation
policy. The generic adapter exposes that policy as a typed provision option;
there is no per-service SDK fork. Standard `initialize`, initialized notification
and stream setup may occur when opening the invocation connection. Catalog
requests (`tools/list`, `server/discover`) belong only to consented discovery.

The pinned MCP SDK can otherwise refresh a catalog and repeat a `tools/call`
after modern `HEADER_MISMATCH`, or repeat a warm connection's HTTP 404. A generic
HTTP guard now blocks catalog recovery during invocation and permits at most one
business request per admitted call. A known 4xx refusal remains an observed
failure; a lost reply or 5xx remains uncertain, with the existing journal hold
and no replay. A guard refusal before any business request is `not_started`.
Modern-only servers that require invocation-time discovery are unavailable under
this policy. General catalog import and additional ready-made MCP servers remain
future work and require the same counter qualification.

## Shared-client compatibility

Upgrade the runtime and shipped clients together. Plugin-capable owners must
advertise `plugin.session-authority-v1`; new clients reject an older plugin owner
at hello with `plugin_runtime_upgrade_required`, before sending commands. The
capability bound is now 65; the frozen RC2 validator's bound of 64 rejects the new
owner's 65-capability hello. This proves shipped-client compatibility behavior,
not a claim about every third-party client. Minimal non-plugin protocol-1 peers
remain compatible, and ACP is unchanged.

## Evidence and limits

The live run used a dedicated Issues Read/Metadata Read token, the approved
`ryltsevmikhail/Ocean` repository and existing issue #5. Exactly three business
requests succeeded: list issues, read issue #5, and read #5 after explicit
post-restart recovery. Every answer was derived from actual tool content and
contained the fixture marker. Wrong repository, bot, room, ungranted tool and
unrecovered restart emitted zero business requests. Three durable operations
finished `observed/ok`; SQLite integrity and foreign-key checks passed.

Two explicit discovery consents produced four `tools/list` requests in total.
Legacy connection setup produced six initialize/notification/stream-open
sequences; the six optional stream GETs returned 405. There was no startup
network activity, invocation catalog refresh or hidden business replay in the
passing run. All requests carried the fixed tool/read-only headers.

The chat provider was deterministic (13 local provider requests, zero external
model calls). Genuine DeepSeek and installed native GUI/TUI qualification are
separate gates. Sensitive profiles and sanitized request evidence are outside
Git; exact token scans found no token in generated profiles, logs or evidence.
The detailed implementation and validation record is
[Task 4's report](../../.superpowers/sdd/2026-11-04-ocean-stable/task-4-report.md).
