# Group rooms (M3)

A group is a persistent room with a title and a fixed set of 2–32 distinct,
existing bots in the same workspace. CLI and TUI use the same conversation
service and turn engine as direct rooms. Membership changes are a later feature.

## Create and open a group

Initialize a profile and create dev and review as described in
[direct chats](direct-chat.md). The following commands use that same profile.

```sh
pnpm ocean room group --name Team --bot dev --bot review --profile /absolute/ocean-profile
pnpm ocean room list --profile /absolute/ocean-profile
pnpm ocean room members ROOM_ID --profile /absolute/ocean-profile
pnpm ocean send ROOM_ID --text "Shared context" --request-id note-1 --profile /absolute/ocean-profile --json
pnpm ocean send ROOM_ID --to dev --text "Implement add" --request-id dev-1 --profile /absolute/ocean-profile --json
pnpm ocean send ROOM_ID --to review --text "Review the implementation" --request-id review-1 --profile /absolute/ocean-profile --json
pnpm ocean tui --room ROOM_ID --profile /absolute/ocean-profile
```

Group creation returns its ID in data.data.id. A repeated creation with the same
request key returns the original room. A new key creates a separate room, even
with the same title and members. Room listing returns both direct and group rooms.
The members command resolves their profile IDs, handles, names and model settings.

In the TUI, address one bot with a leading mention, such as
`@dev Implement add`, then `@review Review the result`. A plain message
records shared context. Reopening the room restores its transcript and each bot
answer is labelled with its stored author. The active addressed bot/model is
shown during execution. Replies containing mentions do not route new work.

## Addressing and execution

A group message without a leading mention or --to has status recorded and a null
taskRunId. It requires no configured model and creates no TaskRun. A mention
inside a sentence or quoted passage is ordinary text. A leading mention is
reserved for explicit routing. Malformed addresses, multiple leading mentions,
conflicting --to and mention, unknown bots and nonmembers fail before recording
the input or calling a provider. Direct chats accept only their sole bot.

Every addressed message creates one turn for one selected member. A unique room
hold prevents overlapping addressed turns. Shared notes can be committed during
a running turn, but do not alter that turn's already frozen model context. They
become available for the next explicitly addressed turn. CLI/TUI profile
ownership still excludes a second host process.

The selected bot receives its role and this room's published history. Its own
earlier replies use assistant role. Peer replies use user role with a JSON author
envelope carrying the peer ID, handle, name and text. Thus a peer cannot become
the selected bot's assistant history or system instructions. Private rooms and
reasoning streams do not enter group context. A reply is published to the group
only after the existing prepared-result and TaskRun checks.

The request receipt binds the exact text, room and explicit --to option. A
changed recipient under the same request key fails with request_conflict.
Existing M2 requests without --to retain their original receipt binding. Exact
retries inspect the original result and never redispatch, including after restart.

## SQLite and checks

Schema 4 migrates versions 1–3, extends room kinds and permits untargeted group
user messages. The migration preserves direct room IDs, all published answers,
memberships, turns, event records and receipts. Parent-table replacement runs in
one transaction, with connection-local foreign keys disabled for replacement,
foreign_key_check before commit and the original enforcement setting restored
on success or failure. Live or unverifiable owners prevent migration. Make a
verified backup before opening a real older profile with the new version.

Offline checks cover memory/SQLite parity, ambiguous recipients, membership,
shared notes, explicit handoff, overlapping turns, context boundaries, CLI/TUI
continuity and rollback of schema 3→4. Frozen schema-2/3 SQL fixtures come from
the public M2 revision and contain no user data. Real provider availability and
full production qualification remain part of the release gates.
