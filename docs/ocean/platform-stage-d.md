# Platform stage D — bot tasks and communication

## Implemented: D19.1 pure addressing contract

Domain exports readonly `RoomTaskAddress` and `RoomDeliveryAddress` projections,
`RoomAgentRequest`, trusted `RoomDeliveryOrigin`, and `decideRoomAddress`. These
are addressing facts, not a complete persisted task schema, grant or wire endpoint.
Only bot tasks are actors: a task differs from its owner root and has a nonself
parent (the owner root or a delegating bot task). An owner root is not a root bot.
Owner starts have no source task/turn/sender; other delivery kinds have a causal
bot task/turn. A result to an initial owner root is progress/publication, not a
bot-waking delivery. The delivery projection has no frozen runtime validator or
persisted receipt format in this leaf.

The decision accepts only exact `message`/`delegate` requests (`kind`, `toBotId`,
`text`). It derives sender and context from the trusted runtime origin, requires
a ready task with its assigned bot, and requires different sender/recipient bots
in both selected and current room membership. It returns malformed input as
`invalid_argument` and otherwise ineligible routes as `invariant_violation`.
Selected membership is dense, unique and limited to 1–32 bots; current membership
is dense, unique and limited to 0–32. Empty current membership refuses routing.
Grant references are current C reference shapes, unique by grant ID, limited to
0–32. Empty references permit local communication under the owner root; neither
empty nor nonempty references grant external authority through this decision.

Ordinary IDs use the existing 128-byte UTF-8 rule; the engine's trusted compound
round-qualified call ID has a 512-byte ceiling. Text has a 16384-byte ceiling and
is preserved exactly, including whitespace. NUL and unpaired surrogates fail.
The stable internal key is canonical JSON of
`['room-agent/v1', turnId, attemptId, callId]`; the payload binding is canonical
JSON of `[workspaceId, roomId, rootId, task.id, deliveryId, botId, kind, toBotId, text]`.
This function allocates no identity, grants no authority, performs no I/O, and
mutates no input.

## Planned: remaining D work

D is not complete. D19.2 owns persisted joins, lineage, mandate/budget, revisions,
current external grant authority and its intersection. Durable receipt lookup
must precede fresh routing checks; later persistence may hash the internal key
through the trusted SHA256 port and must never repeat an unknown execution.
Autonomous task persistence, scheduling/execution, engine integration, hosts,
client/UI capabilities and delivery receipt validation remain planned. Current C
permissions and external service behavior are unchanged. This leaf does not
qualify native behavior or live model/service execution.
