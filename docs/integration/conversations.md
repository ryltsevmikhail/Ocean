# Bot profiles and direct history (M1)

M1 exposes a synchronous application service for one workspace, immutable bot
profiles, one direct room per bot and ordered user messages. Memory and SQLite
adapters implement the same transaction port. All time and identity are injected.
No model is called by RecordUserMessage. The separate [M2 chat path](direct-chat.md) admits a TaskRun and model dispatch.

## Public application API

`ConversationService` is exported by `@runnets/application`. Its dependencies
are `store`, `nextId` (a collision-resistant identity generator, also after
restart) and `clock`. The host must resolve and verify the canonical existing
workspace root before submitting `BindWorkspace`.

`execute` accepts four command variants, all with requestId and workspaceId:

| Type              | Additional fields                   | Successful reply kind |
| ----------------- | ----------------------------------- | --------------------- |
| BindWorkspace     | root                                | workspace             |
| CreateBot         | handle, name, role, provider, model | bot                   |
| OpenDirectRoom    | botId                               | room                  |
| RecordUserMessage | roomId, text                        | message               |

Replies use `{ok:true,value:{kind,data}}`; expected rejections use
`{ok:false,error:{code,message}}`. Storage failures throw and roll back the
complete transaction. A successful command receipt and all its writes commit
together. Request IDs are global to this conversation store. Identical retries
return the original detached reply. Altered requests fail with request_conflict.

`bots(workspaceId)` lists profiles in handle order.
`history(workspaceId,roomId,after=0,limit=50)` returns messages after the cursor,
ordered by sequence. Limits are 1–200. Text is nonblank, valid Unicode, and at
most 16 KiB in UTF-8. Message records retain the exact text and injected ISO time.
They represent user input and do not claim an assistant response or TaskRun.

## Adapters and persistence

Use `new InMemoryConversationStore()` from `@runnets/store` for ephemeral
sessions. Use `openSqliteStore({path}).conversations` from
`@runnets/store-sqlite` for durable storage. Close the SQLite store after use.
Application clients sharing a file serialize writes through BEGIN IMMEDIATE.
Hosts performing execution must still acquire exclusive runtime ownership.

SQLite schema 2 added workspace, bot, direct room, membership, message and
conversation receipt tables. Migration from schema 1 is transactional.
Existing task events, receipts, checkpoints and tool journals remain intact.
A live or unverifiable runtime owner prevents migration. A dead owner's record
is left for the existing ownership mechanism. Future schema versions are refused
before changing the journal mode. Existing v2 databases must contain all M1 tables.

Before upgrading a real profile, stop its owner and make a verified backup.
The migration does not invent missing historical conversations from old tasks.
A failed migration keeps the previous version and rolls back newly created tables.

## Remaining milestones

CLI/TUI profile commands, bot replies, model context reconstruction and TaskRun
assignment are implemented in [M2](direct-chat.md). Group rooms are implemented in [M3](group-chat.md). Membership changes remain a later feature. The
full target schema and command interface in docs/ocean describe those future
milestones; M1 implements only the direct user-history subset.
