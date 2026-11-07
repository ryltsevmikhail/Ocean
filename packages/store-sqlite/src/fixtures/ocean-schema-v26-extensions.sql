
CREATE TABLE ocean_plugin_versions (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      publisher TEXT NOT NULL,
      title TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      manifest TEXT NOT NULL,
      adapter TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('installing','installed','interrupted','corrupt')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      file_digest TEXT,
      installed_at TEXT NOT NULL,
      verified_at TEXT,
      PRIMARY KEY(plugin_id, version)
    ) STRICT;

CREATE TABLE ocean_plugin_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      account_label TEXT,
      identity TEXT,
      identity_verified INTEGER NOT NULL CHECK(identity_verified IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('active','disconnected')),
      generation INTEGER NOT NULL CHECK(generation >= 1),
      schema_digest TEXT,
      tools TEXT,
      consented_generation INTEGER,
      consented_at TEXT,
      last_discovery_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plugin_id, name)
    ) STRICT;

CREATE TABLE ocean_plugin_consents (
      connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY(connection_id, generation)
    ) STRICT;

CREATE TABLE ocean_plugin_grants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      tools TEXT NOT NULL,
      repository TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      visibility TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','revoked')),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK((state = 'revoked') = (revoked_at IS NOT NULL))
    ) STRICT;

CREATE TABLE ocean_plugin_confirmations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      state TEXT NOT NULL CHECK(state IN ('pending','revoked','consumed')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;

CREATE TABLE ocean_plugin_operations (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      endpoint TEXT NOT NULL,
      tool TEXT NOT NULL,
      repository TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      arguments_digest TEXT NOT NULL,
      arguments TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN
        ('started','observed','failed','not_started','uncertain','acknowledged')),
      outcome_code TEXT,
      detail TEXT,
      result_summary TEXT,
      result_bytes INTEGER,
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      acknowledged_at TEXT,
      acknowledged_reason TEXT,
      CHECK((state = 'started') = (settled_at IS NULL)),
      CHECK((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
    ) STRICT;

CREATE TABLE ocean_model_connections (
      connection_id TEXT PRIMARY KEY, payload TEXT NOT NULL
    ) STRICT;

CREATE TABLE ocean_bot_model_bindings (
      bot_id TEXT PRIMARY KEY REFERENCES ocean_bots(id),
      connection_id TEXT NOT NULL REFERENCES ocean_model_connections(connection_id),
      model_id TEXT NOT NULL
    ) STRICT;

CREATE TABLE ocean_model_connection_receipts (
      request_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ocean_model_connections(connection_id),
      binding TEXT NOT NULL, result TEXT NOT NULL
    ) STRICT;

CREATE TABLE ocean_room_model_policies(
    room_id TEXT PRIMARY KEY REFERENCES ocean_rooms(id),
    cloud_transfer TEXT NOT NULL CHECK(cloud_transfer IN ('allow','deny')),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
  ) STRICT;

CREATE TABLE ocean_service_connections (
      id TEXT PRIMARY KEY,
      config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
      trust_revision INTEGER NOT NULL CHECK(trust_revision >= 1),
      credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
      current_catalog_id TEXT,
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536),
      FOREIGN KEY(id, current_catalog_id) REFERENCES ocean_service_catalogs(connection_id, id)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;

CREATE TABLE ocean_service_catalogs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ocean_service_connections(id),
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 4194304),
      UNIQUE(connection_id, id)
    ) STRICT;

CREATE TABLE ocean_owner_scope_grants (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536)
    ) STRICT;

CREATE TABLE ocean_service_owner_receipts (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('prepared','completed')),
    record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 131072)
  ) STRICT;

CREATE UNIQUE INDEX ocean_coding_project_hold ON ocean_coding_tasks(project_root) WHERE status='reserved';

CREATE INDEX ocean_decisions_by_room ON ocean_owner_decisions(workspaceId,roomId,decisionId);

CREATE INDEX ocean_decision_revision ON ocean_owner_decisions(revision);

CREATE INDEX ocean_room_decision_revision ON ocean_owner_decisions(workspaceId,roomId,revision);

CREATE INDEX ocean_decisions_by_run ON ocean_owner_decisions(workspaceId,roomId,runId,status);

CREATE UNIQUE INDEX ocean_coding_finalization_hold ON ocean_coding_finalizations(task_id)
   WHERE state IN ('preview','finalizing','finalized','uncertain');

CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
      WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL;

CREATE INDEX ocean_chat_broadcast ON ocean_chat_turns(json_extract(payload,'$.broadcast.batchId'))
      WHERE json_extract(payload,'$.broadcast.version')=1;

CREATE UNIQUE INDEX ocean_broadcast_open ON ocean_broadcast_batches(room_id)
      WHERE state IN ('open','paused');

CREATE INDEX ocean_plugin_grants_scope
      ON ocean_plugin_grants(workspace_id, room_id, bot_id, state);

CREATE INDEX ocean_plugin_grants_connection
      ON ocean_plugin_grants(connection_id, state);

CREATE INDEX ocean_plugin_grants_plugin
      ON ocean_plugin_grants(plugin_id, state);

CREATE INDEX ocean_plugin_operations_scope
      ON ocean_plugin_operations(workspace_id, room_id, bot_id, created_at DESC);

CREATE INDEX ocean_plugin_operations_state
      ON ocean_plugin_operations(state, created_at DESC);

CREATE INDEX ocean_plugin_operations_connection
      ON ocean_plugin_operations(connection_id, connection_generation);

CREATE TRIGGER ocean_direct_member BEFORE INSERT ON ocean_members
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct'
      AND NEW.bot_id!=(SELECT bot_id FROM ocean_rooms WHERE id=NEW.room_id)
    BEGIN SELECT RAISE(ABORT,'direct room member mismatch'); END;

CREATE TRIGGER ocean_direct_target BEFORE INSERT ON ocean_messages
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct' AND NEW.target_bot_id IS NULL
    BEGIN SELECT RAISE(ABORT,'direct message requires a target'); END;

CREATE TRIGGER ocean_review_immutable BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN OLD.review_id IS NOT NULL AND NEW.review_id IS NOT OLD.review_id
      BEGIN SELECT RAISE(ABORT,'continuation review is immutable'); END;

CREATE TRIGGER ocean_review_turn BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN NEW.review_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM ocean_reviews WHERE id=NEW.review_id AND turn_id=NEW.id AND room_id=NEW.room_id)
      BEGIN SELECT RAISE(ABORT,'continuation review has wrong turn'); END;
INSERT INTO meta(key,value) VALUES('schema_version','26');
