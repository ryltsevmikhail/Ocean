CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (aggregate_id, sequence),
  CHECK (sequence >= 1)
) STRICT;

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  events TEXT NOT NULL
, request_binding TEXT) STRICT;

CREATE TABLE checkpoints (
  aggregate_id TEXT NOT NULL,
  event_position INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  snapshot TEXT,
  PRIMARY KEY (aggregate_id, event_position),
  CHECK (event_position >= 1),
  FOREIGN KEY (aggregate_id, event_position) REFERENCES events (aggregate_id, sequence)
) STRICT;

CREATE TABLE ocean_workspace (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      id TEXT NOT NULL UNIQUE, root TEXT NOT NULL UNIQUE
    ) STRICT;

CREATE TABLE ocean_bots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES ocean_workspace(id),
      handle TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
      UNIQUE(workspace_id,handle), UNIQUE(workspace_id,id)
    ) STRICT;

CREATE TABLE ocean_members (
      workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, bot_id TEXT NOT NULL,
      PRIMARY KEY(room_id,bot_id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(workspace_id,bot_id) REFERENCES ocean_bots(workspace_id,id)
    ) STRICT;

CREATE TABLE ocean_receipts (
      request_id TEXT PRIMARY KEY, binding TEXT NOT NULL, reply TEXT NOT NULL
    ) STRICT;

CREATE TABLE "ocean_rooms"(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('direct','group')),bot_id TEXT,title TEXT,
      CHECK((kind='direct' AND bot_id IS NOT NULL AND title IS NULL)
        OR (kind='group' AND bot_id IS NULL AND title IS NOT NULL)),
      UNIQUE(workspace_id,bot_id),UNIQUE(workspace_id,id),
      FOREIGN KEY(workspace_id) REFERENCES ocean_workspace(id),
      FOREIGN KEY(workspace_id,bot_id) REFERENCES ocean_bots(workspace_id,id)
    ) STRICT;

CREATE TABLE "ocean_messages"(
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq>=1),author TEXT NOT NULL CHECK(author IN ('user','bot')),
      target_bot_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
      author_bot_id TEXT,turn_id TEXT,UNIQUE(room_id,seq),UNIQUE(turn_id),
      CHECK((author='user' AND author_bot_id IS NULL AND turn_id IS NULL)
        OR (author='bot' AND author_bot_id IS NOT NULL AND target_bot_id IS NOT NULL
          AND author_bot_id=target_bot_id AND turn_id IS NOT NULL)),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id),
      FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id)
    ) STRICT;

CREATE TABLE ocean_reviews(
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,
    task_run_id TEXT NOT NULL,turn_id TEXT NOT NULL UNIQUE,notice_message_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,UNIQUE(room_id,id),
    FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
    FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id),
    FOREIGN KEY(notice_message_id) REFERENCES ocean_messages(id)
  ) STRICT;

CREATE TABLE ocean_room_policies(
    room_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode='text_only'),
    review_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY(room_id,review_id) REFERENCES ocean_reviews(room_id,id)
  ) STRICT;

CREATE TABLE ocean_coding_tasks(
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_root TEXT NOT NULL,
  owner_room_id TEXT NOT NULL,dev_bot_id TEXT NOT NULL,review_room_id TEXT NOT NULL,review_bot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','cancelled','finalizing','finalized')),
  policy_version INTEGER NOT NULL CHECK(policy_version=1),payload TEXT NOT NULL,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES ocean_workspace(id),
  FOREIGN KEY(owner_room_id,dev_bot_id) REFERENCES ocean_members(room_id,bot_id),
  FOREIGN KEY(review_room_id,review_bot_id) REFERENCES ocean_members(room_id,bot_id),
  CHECK(dev_bot_id!=review_bot_id)
 ) STRICT;

CREATE TABLE ocean_coding_receipts(
  request_id TEXT PRIMARY KEY,binding TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id)
 ) STRICT;

CREATE TABLE ocean_worktrees(
  task_id TEXT PRIMARY KEY REFERENCES ocean_coding_tasks(id),root TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','uncertain')),payload TEXT NOT NULL
 ) STRICT;

CREATE TABLE ocean_changesets(
  hash TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id),payload TEXT NOT NULL
 ) STRICT;

CREATE TABLE ocean_capture_receipts(
  request_id TEXT PRIMARY KEY,binding TEXT NOT NULL,hash TEXT NOT NULL REFERENCES ocean_changesets(hash)
 ) STRICT;

CREATE TABLE ocean_coding_approvals(
      id TEXT PRIMARY KEY,payload TEXT NOT NULL
    ) STRICT;

CREATE TABLE ocean_coding_approval_claims(
      invocation_key TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE REFERENCES ocean_coding_approvals(id)
    ) STRICT;

CREATE TABLE ocean_coding_test_evidence(
 id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,payload TEXT NOT NULL
 ) STRICT;

CREATE TABLE ocean_coding_review_requests(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;

CREATE TABLE ocean_coding_review_verdicts(
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES ocean_coding_review_requests(id),payload TEXT NOT NULL
 ) STRICT;

CREATE TABLE ocean_coding_applications(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;

CREATE TABLE ocean_owner_decisions (
   decisionId TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, roomId TEXT NOT NULL, runId TEXT NOT NULL,
   kind TEXT NOT NULL, bindingDigest TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
   version INTEGER NOT NULL, status TEXT NOT NULL, previewLength INTEGER NOT NULL, preview BLOB NOT NULL, revision INTEGER NOT NULL
 ) STRICT;

CREATE TABLE ocean_desktop_operations(id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('started','completed')),result TEXT) STRICT;

CREATE TABLE ocean_desktop_uploads(id TEXT PRIMARY KEY,room TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL) STRICT;

CREATE TABLE ocean_desktop_adopted(message_id TEXT PRIMARY KEY,room TEXT NOT NULL,request_id TEXT NOT NULL,body TEXT NOT NULL) STRICT;

CREATE TABLE ocean_restore_origin (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL
  ) STRICT;

CREATE TABLE ocean_restore_origins(identity TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;

CREATE TABLE ocean_retired_epochs(identity TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;

CREATE TABLE ocean_profile_rebinds (
    request_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL
  ) STRICT;

CREATE TABLE ocean_execution_epoch (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT NOT NULL UNIQUE REFERENCES ocean_profile_rebinds(request_id)
  ) STRICT;

CREATE TABLE ocean_rebind_observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;

CREATE TABLE ocean_coding_finalizations(
   request_id TEXT PRIMARY KEY,
   task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id),
   project_root TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('preview','finalizing','finalized','uncertain','refused')),
   revision INTEGER NOT NULL CHECK(revision>=1),
   binding_digest TEXT NOT NULL,
   payload TEXT NOT NULL
  ) STRICT;

CREATE TABLE ocean_provider_connections (
      provider TEXT PRIMARY KEY,
      model TEXT,
      secret_ref TEXT,
      intent TEXT NOT NULL CHECK(intent IN ('active','disconnected','pending')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      request_id TEXT,
      binding TEXT,
      last_check TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE ocean_provider_receipts (
      request_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      binding TEXT NOT NULL,
      result TEXT NOT NULL
    ) STRICT;

CREATE TABLE "ocean_chat_turns" (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','accepted','dispatching','prepared','completed','failed','uncertain','cancelled')),
      payload TEXT NOT NULL,
      review_id TEXT REFERENCES ocean_reviews(id),
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id)
    ) STRICT;

CREATE TABLE ocean_broadcast_batches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      binding TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      boundary_seq INTEGER NOT NULL CHECK(boundary_seq>=1),
      recipients TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','paused','completed','abandoned')),
      revision INTEGER NOT NULL CHECK(revision>=1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(message_id) REFERENCES ocean_messages(id)
    ) STRICT;
