# Ocean RC2: agreed scope and release gates

Status: agreed product scope, implementation not started. The owner approved the priority order and confirmed that a group “Everyone” message gets one response from each participant, with no automatic bot-to-bot conversation. This document records technical defaults as planning decisions, not as features already implemented.

## Intent

Deliver a usable next Linux desktop candidate: connect DeepSeek in the UI, address every group participant, send actual images to a capable model, and offer the first scoped GitHub plugin. Preserve the already accepted shared runtime, coding authority, receipts, recovery, installed Linux and actual Desktop/live-provider results.

## Priority and delivery order

1. P0: provider connection in the Desktop UI.
2. P0: explicit group broadcast, distinct from a note.
3. P0: genuine image input through the provider-neutral contract.
4. P1: Executor qualification and a GitHub read-issues pilot through the supplied plugin plan.
5. P1: ready Desktop audit parts 4–6; composer accessibility at 1024 is a release blocker.
6. Release gate: whole-branch review, fixes, regression/native/live acceptance and safe installed RC2 update.

The existing release remains Ocean 1.0. RC1 is already installed separately as Ocean RC. RC2 is another candidate, not a declaration that the stable 1.1 release is complete.

## 1. Provider connection

The trusted runtime owns credentials and provider activation. Desktop settings support adding, checking, replacing, disconnecting and deleting an Ocean-managed saved key, selecting a model and seeing the actual connection state. Renderer input is transient and cleared after submission; responses return metadata only. Never put secrets in SQLite, messages, request logs, process arguments, backup or error text.

Use an application port for secret storage and a Linux adapter storing private credential material outside the profile/backup tree with directory 0700 and files 0600. Keep metadata and opaque secret references in authoritative state. Persist intent before filesystem/network effects; qualify interrupted writes and activation. Existing environment credentials remain explicitly labeled external sources; an explicit disconnect overrides environment fallback after restart. The installed RC1 key must be retained safely through the update. Do not pretend that deleting an Ocean-managed key revokes it at DeepSeek or deletes an unrelated external source.

A connection check is explicit, bounded and reports auth/network/timeout states without echoing secrets. It must not silently replay a model request. Credential replacement does not restart or replay an active turn: an admitted call keeps its exact provider snapshot; later calls use the newly activated configuration. Backup includes metadata but no secret; restore requires reconnection.

## 2. Everyone and notes

Current “Everyone · note” saves a room message and starts no model; existing room context includes these messages in a later addressed turn. RC2 exposes separate “Everyone” and “Note” actions.

A broadcast persists one user message, a frozen recipient list, a context boundary and per-recipient identities before dispatch. Every eligible participant gets exactly one model turn and at most one final published answer. Repeating the same request ID/data returns the original batch and child runs; changed data conflicts. New members are not added to an admitted batch. A member removed before its dispatch receives a visible not-started refusal.

All participants answer the same frozen room history plus that user message. Sibling answers from the current batch do not enter later siblings' requests. Older peer replies remain attributed data, never permissions. There are no automatic follow-up rounds. A broadcast grants no coding authority; bot/room/task/plugin permissions remain separately enforced.

Keep one active room execution at a time; queue recipients durably. Window closure detaches only the client. Per-recipient progress, result, failure and uncertainty are visible. After an interrupted owner, do not replay ambiguous children or silently resume a partially uncertain batch. Cancellation distinguishes undispatched children from effects already started; never claim confirmed remote cancellation without proof.

### Interrupted-batch recovery policy

Recovery pauses the batch. Proven-undispatched siblings remain held/not started; they are neither silently cancelled nor dispatched. An explicit owner action with batch ID and expected version may continue only known-not-started siblings when every previously started child has a known terminal outcome and no relevant hold remains. Completed children are never dispatched again. If any child is uncertain, continuation is refused; the owner may abandon the known-not-started remainder without altering that uncertain child.

A batch waiting for this decision blocks new model turns/broadcasts in its room; history, status and note-only messages remain available. Abandoning the remainder is not settlement or cancellation proof for an uncertain child. Any later room acknowledgement uses the existing explicitly owner-confirmed text-only recovery semantics and preserves journal/tool holds; it does not retry the batch, grant tools or relabel uncertainty. Expose this through the shared runtime and Desktop/TUI, not client-specific guesses. This is a conservative technical planning decision; it trades automatic continuation for explicit control after a crash.

## 3. Actual image understanding

Use the same DeepSeek Flash provider, not OCR as a substitute. The official API accepts multimodal Chat Completions user content: text and inline image parts. Reference: [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/), checked 2026-11-04.

Represent images in a provider-neutral request contract; runtime resolves authenticated room-bound immutable assets through an I/O port. Do not treat an arbitrary text attachment marker or a renderer-supplied host path as authority. Persist attachment references/hashes, not base64 pictures in message text. Map parts to vendor wire shapes only in the adapter. Preserve legacy string messages, tool results and ACP behavior.

Declare capabilities per model. A model without confirmed image support receives a visible refusal, never a silent metadata-only substitute or an automatic switch of model/account. In a mixed-model broadcast, show unsupported recipients as not started while capable recipients receive the actual images.

Preserve the Ocean attachment limit of four files of 10 MiB each. For inline DeepSeek requests validate the complete serialized body against 48 MiB, including history/base64 overhead; refuse before dispatch when it cannot fit. Validate supported actual image content (JPEG, PNG, GIF, WebP) and the documented 8192-pixel side limit. Keep original local bytes; do not introduce Files API upload effects or external image URLs for this candidate. Historical images need the same hash/room/ownership checks on every context reconstruction. Missing/corrupt images are explicit failures, not silently dropped context.

Live acceptance uses a photograph, a diagram whose answer depends on spatial/color content, and a screenshot. The request must contain genuine image bytes, and checks must not derive answers from filenames or captions. Model quality is evaluated honestly; no fabricated or forced response counts as vision acceptance.

## 4. Plugins

The supplied local plan is authoritative for the plugin subsystem: `docs/superpowers/plans/2026-11-02-ocean-service-plugins.md`. It currently exists as a protected untracked owner file; do not alter, stage or lose it. If absent in an isolated checkout, read the original repository copy.

RC2 targets that plan's stages 1–4: qualified pinned Executor adapter; shipped declarative GitHub catalog; install disabled by default; named connections; explicit bot/room/account/repository grants; read issues through normal chat. CLI/TUI/Desktop use the same application services. SDK and Effect stay in the I/O adapter.

Keep the exact pilot limits: 1 MiB per message, discovery at most 4 MiB and 256 tools, 30 seconds per call, 16 tool calls per turn, and 32 KiB model-visible tool output with explicit truncation. A single allowed call causes at most one business request, including after 401; loss after dispatch is uncertain and is not retried. Until the SDK/transport proof passes, execution stays disabled. Account identity must be honestly labeled verified or unverified.

Recheck membership, connection generation, tool schema, pinned adapter/plugin version and repository constraints transactionally before claiming the journal operation. Denied/ungranted/revoked/wrong-bot/wrong-room/wrong-repository calls cause zero business requests. Restore does not reactivate secrets or grants. Catalog installation itself makes zero GitHub requests.

The first live test needs an explicitly approved test connection and repository. Do not silently transfer credentials from another application or choose an unrelated account. If this external prerequisite is absent, retain a visible unqualified live gate and continue independent work; do not present mocked GitHub traffic as live acceptance.

Issue comments, OAuth/PKCE, a second service, external catalogs and arbitrary executable plugins are outside RC2's agreed pilot. They remain later stages of the supplied plan.

## 5. Desktop audit and delivery

Preserve `design/desktop-audit-fixes` and `/home/ryltsevmg/Projects/Ocean-design-fixes`. Parts 1–3 are already integrated. Merge only ready subsequent audit commits and keep runtime recovery plus new UI fields on conflicts. Do not duplicate a separate unfinished visual audit. If the 1024 composer obstruction remains, a narrowly scoped functional correction is required before RC2 acceptance.

Verify settings, readable focus/error states and composer/send availability with details open at widths 1024, 1280 and 1920. Keep image previews, export bytes, attachment limits and existing keyboard/history behavior.

Update through a new versioned installed directory, preserving RC1, persistent profile and its saved key. Never switch binaries against an incompatible upgraded database as a supposed rollback. Prove the schema/data rollback procedure on disposable fixtures before touching the user's profile. Do not stop an active/unknown user turn or overwrite an uncertain profile merely to finish an update.

## Global constraints and completion

- Linux x86_64 Omarchy; TypeScript workspace; pinned pnpm; source files at most 300 physical lines; domain pure, application dependent only on domain, I/O behind public adapter ports.
- Runtime owns state/authority; model cannot approve itself; review reads immutable artifacts and has no command/write tools.
- Persist before effects; unknown effects are never automatically replayed; parent exit is not child cleanup proof; failed isolation leaves execution disabled.
- No automatic stash/reset/clean of source or user files; bots cannot commit/push/deploy; no keys, real profiles or sensitive transcripts in Git.
- Keep root checks, native behavior, actual GUI, live DeepSeek, live GitHub and credential-store verification separately attributed. Skips are not passes.
- RC2 passes only after independent review, final whole-branch review and its consolidated fixes, reproducible artifacts/hashes and installed application acceptance. Time passing overnight does not substitute for a gate.
