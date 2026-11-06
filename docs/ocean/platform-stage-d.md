# Platform stage D — bot tasks and communication

## Implemented: D19.1 pure addressing contract

Domain exports readonly `RoomTaskAddress` and `RoomDeliveryAddress` projections,
`RoomAgentRequest`, trusted `RoomDeliveryOrigin`, and `decideRoomAddress`.
Only bot tasks are actors: a task differs from its coordinating owner root and
has a nonself parent (the root or another bot task). An owner root is not a bot.
Owner starts have no source task/turn/sender; other delivery kinds have a causal
bot task/turn. A result to an initial owner root is progress/publication, not a
bot-waking delivery.

The decision accepts only exact `message`/`delegate` requests (`kind`, `toBotId`,
`text`). It derives sender and context from the trusted runtime origin, requires
a ready task with its assigned bot, and requires different sender/recipient bots
in both selected and current room membership. Malformed input remains
`invalid_argument`; otherwise ineligible routes remain `invariant_violation`.
Selected membership is dense, unique and limited to 1–32 bots; current membership
is dense, unique and limited to 0–32. Grant references retain the accepted C shapes,
unique by grant ID, limited to 0–32. Empty references permit local communication;
neither empty nor nonempty references grant external authority through addressing.

Ordinary IDs use the existing 128-byte UTF-8 rule; trusted compound round-qualified
call IDs have a 512-byte ceiling. Text has a 16384-byte ceiling and is preserved
exactly, including whitespace. NUL and unpaired surrogates fail. The stable logical
key remains canonical JSON of `['room-agent/v1', turnId, attemptId, callId]`; binding
remains canonical JSON of
`[workspaceId, roomId, rootId, task.id, deliveryId, botId, kind, toBotId, text]`.
The strict request validator and immutable key/binding helpers are reusable on
receipt lookup without running the ready-only routing decision.

19.1 принят на `ba6ec5c` после независимого ревью без замечаний. Поведенческие
RED→GREEN и278 доменных тестов прошли; полные `pnpm check` (3707 source /
165 process), `pnpm build`, `pnpm format:check` завершились с кодом0.
Это историческое подтверждение19.1 на указанной ревизии; новый persistence-код
требует отдельного ревью и проверок.

## Implemented: D19.2.1 inert durable persistence

`RoomTaskPersistence.start` and `.send` commit task rows, addressed deliveries,
conversation history and the existing message-kind receipt under one SQLite lock.
Schema 27 adds two tables. Starts persist one owner root, sibling initial bot tasks,
one user message and ordered queued deliveries. Their causeId is the owner root ID;
a peer delivery refers to its originating input delivery. Peer sends persist a new direct
child, one queued delivery and an A-author/B-target message tied to the actual
source turn. Delegation atomically moves the sender to waiting for that child.
Failures during publication roll all writes back. Repeated identical requests return
original IDs and sequence positions from complete-key immutable joins tied to the
requested scope, body and target; changed requests and
cross-kind key collisions conflict. Receipt lookup precedes mutable eligibility.

Roots retain the trusted owner, immutable mandate, exact selected C references,
configured connection identities and fixed limits of 2 concurrent slices, 32 total
slices, 64 provider starts and 64 tool calls. These are stored limits, not execution
accounting. Project subjects derive from the stored workspace root or the actual
owning coding task. Fresh sends verify a claimed incoming delivery, a marked source
turn and its persisted running Core attempt with a settled tool-call round. Sender
activation must match the root pin; later sender default edits do not rewrite it.
A recipient's current metadata must still match its pin. Revoked references cannot
be replaced or silently reselected; local communication itself grants no physical
operation authority.

Fresh work respects current membership, transfer privacy, legacy room/batch holds,
text-only recovery restrictions and restore-origin quarantine. D roots and unresolved
marked slices hold legacy executing admissions, including slices linked to a review
after a root stop. Unaddressed group notes retain their existing path. Runnable queued
nonlocal pins participate in the privacy-deny barrier even after a local rebind.
Never-claimed queued rows under stopped/completed roots or tasks are inert and
do not prevent tightening privacy; claimed/unresolved work still requires evidence.
Maintenance retains schema 26 and reports distinct held rooms for schema 27 without
counting inert deliveries as model runs or effects. Predecessor history, final-reply
uniqueness, direct-room targeting and the ten physical history columns are preserved.
Stored message facts are immutable on update, including on reopened v27 snapshots.

19.2.1 принят на `698c6ba` после полного и повторного независимого ревью:
шесть важных замечаний и проверка настоящего format-2 backup/restore закрыты.
`pnpm check`: 3761 source / 165 process прошли (44/36 настроенных пропусков);
`pnpm build` и `pnpm format:check` завершились с кодом0. Архив с обеими квитанциями
восстановлен после удаления исходного тестового профиля; повтор читается,
новая работа остаётся запрещена восстановлением. Два minor-пункта учтены для F.
Общий D не завершён; подключение исполнения остаётся следующим этапом.

## Implemented: D19.2.2 negotiated addressed history

The existing protocol-1 hello requests `room.addressed-history-v1` after the
client's four existing features. Hello and status advertise it only to clients
requesting it, independently of plugin, model and service support. This is wire
support and grants no bot, owner or tool authority. An older runtime can ignore
the feature while continuing to serve ordinary history.

History decoding accepts distinct bot author/target IDs only when the returned
identity includes the feature. Both IDs and the source turn remain required;
scope, consecutive positions, strict base64/UTF-8 and byte bounds still apply.
`runs.result` remains an ordinary final bot reply. Before serializing history,
the runtime inspects the requested candidate page: a peer row without negotiated
support returns `client_upgrade_required` for the whole page. It never drops,
rewrites or advances past that row. Ordinary pages retain their wire format;
modern pages retain the existing continuous-prefix frame budget.

Synthetic accepted persistence is qualified through the normal built runtime,
real shared socket and independent current/frozen RC2 client processes. This
qualifies reading and compatibility only; it introduces no execution endpoint
and does not qualify provider, service or native behavior.

19.2.2 принят на `486df4f` после независимого ревью без важных замечаний.
Полные `pnpm check` (3785 source / 166 process; 44/36 настроенных пропусков),
`pnpm build` и `pnpm format:check` прошли. Все восемь замороженных RC2-фикстур
сохранены побайтно. Шум унаследованных тестовых фикстур учтён для финального F.

## Implemented: D19.2.3 local slice engine foundation

The common `runTurn` engine now accepts an explicit room-turn opt-in. A trusted
in-process tool result can carry detached, frozen committed-delegation evidence
through a private exact-object association. The existing serial tool loop stops
at that result, records skipped suffix calls using their provider call IDs and
finalizes the local TaskRun with one version-bound `Complete`. It resolves as a
yielded slice without another model request, answer preparation or child wait.
Ordinary tools, one-argument turns and ACP stop reasons retain their contracts.

Success requires an exact command receipt and matching committed succeeded head.
A lost Complete response permits one lookup of the unchanged command; conflicting
identity, version, cancellation or evidence stops uncertain without redispatch.
Model settlement and required usage still precede tool admission and completion.
This is qualified with scripted providers and real in-memory TaskRunService only.
The internal evidence factory has no production caller or public barrel export.

19.2.3 accepted at `dc78dbf` after independent review and one cancellation fix.
A synchronous abort from the pending tool notification now prevents invocation;
a separately committed handoff retains its truthful completion behavior. Final
root checks:3819 source tests and166 process tests passed; build and format passed.
The approved test-fixture split and existing turn-safety regression stay≤300 lines.

This foundation alone introduced no producer. D19.2.4 below adds local application
claim/publication/recovery; production room dispatch remains disabled.

## Implemented: D19.2.4 durable local room slices

Schema 28 preserves the two v27 room tables and their existing rows, messages and
receipts. It adds inverse result deliveries and immutable saved handoff/disposition
fields. A completed/yielded slice has no final message or result ID: its bot task
waits on the committed child. The child's ordinary self-targeted final is reused
by the result edge; a fresh parent run resumes the same bot task with a fresh
bounded activation. Nested results reference the original delegated assignment.

The narrow application claim API selects one committed delivery under the SQLite
write lock. It verifies receipts, pins, current membership/privacy, local scope,
input ordering, pending effects and the fixed two concurrent /32 total slice
limits. Only the accepted→dispatching winner enters the existing
`executeChatTurn`→`runTurn` path. Peer/result input is attributed bot data and
history stops at the selected sequence. Text-only recipients receive no tools.
Physical and coding mandates fail closed at this boundary.

Local handoff repair and ordinary final publication replay contiguous Core events
and compare the identical Complete request, receipt and head on the same locked
connection as their writes. A changed head, unknown effects, stop or lost authority
retains the hold. Accepted-claim discovery is separate and proves absence or an
exactly created run with no attempt/model/effect before reusing its IDs. Generic
chat recovery never dispatches a marked model request. A committed handoff is
checked before generic failure handling, and its pinned head survives a failed
local Complete after the genuine carrier/context checks.

Qualification uses scripted providers, the common engine and temporary on-disk
SQLite, including contention, nested/drained queues, crash repair, rollback and a
genuine populated BASE v27 migration fixture. This is application/local persistence
qualification only; no native, provider network or external service claim is made.

## Planned: execution and host integration

D and Task 19.2 are not complete. The local application surface remains unwired
to runtime hosts: no production start/tool endpoint, scheduler, RPC, startup
auto-dispatch or UI producer is enabled. Inert start/send admission still creates
no ChatTurn or Core TaskRun; the explicit local claim/execution caller owns those
steps. Production producers remain disabled until a negotiated task view and
observers can expose waiting-child and yielded disposition truthfully.

The addressed-history wire gate is implemented; the frozen RC2 decoder remains
unchanged and receives an upgrade error for peer-containing pages. The local
engine labels peer/result input as attributed bot data; it does not grant current
owner text or attachment authority.

Cross-producer accounting, scheduling, stop/cleanup, mixed-model outages and
native/live gates remain planned. Actual provider-start/tool limits, repeated
handoff pause rules and full ancestor grant intersection belong to host integration. At each eventual physical-operation boundary, the root mandate and a valid
captured grant at every actual delegating level and recipient remain mandatory;
this leaf does not promise that a captured grant remains usable. Native behavior,
external services and live models are not qualified by these persistence tests.
