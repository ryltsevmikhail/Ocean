# Domain model

The domain model lives in [`@runnets/domain`](../packages/domain/src/index.ts)
and is a pure, synchronous TypeScript library: no I/O, no timers, no random
sources, no provider SDKs. Everything is a deterministic function of committed
events and command input.

## 1. Identities

Identity is branded at the type level and validated at construction, so an
`AttemptId` cannot be passed where a `TaskRunId` is expected and a malformed
wire value cannot enter the domain.

| Type               | Prefix | Constructor        |
| ------------------ | ------ | ------------------ |
| `TaskRunId`        | `tr`   | `taskRunId`        |
| `AttemptId`        | `at`   | `attemptId`        |
| `EventId`          | `ev`   | `eventId`          |
| `ConversationId`   | `cv`   | `conversationId`   |
| `WorkspaceId`      | `ws`   | `workspaceId`      |
| `CheckpointId`     | `cp`   | `checkpointId`     |
| `ToolInvocationId` | `ti`   | `toolInvocationId` |
| `SideEffectId`     | `se`   | `sideEffectId`     |
| `PolicyId`         | `pl`   | `policyId`         |
| `ProcessId`        | `px`   | `processId`        |

`isValidId(raw, prefix)` accepts `^[a-z]{2}_[a-z0-9][a-z0-9_-]{2,62}$` up to 65
characters and requires the matching prefix. Constructors throw `RangeError` on
invalid input — invalid identity is programmer error, not a domain outcome.
See [ids.ts](../packages/domain/src/ids.ts).

## 2. Actors, sensitivity and versioning

- `ActorKind`: `user`, `runtime`, `scheduler`, `tool`, `provider`, `policy`.
- `Actor`: `{ kind, id }`.
- `Sensitivity`: `public`, `internal`, `restricted` — used for audit and
  redaction decisions.
- `TASK_RUN_SCHEMA_VERSION` is `1`. A payload shape change requires a new
  version; `draft` stamps the current one.

## 3. Event envelope

Events are immutable records committed to one aggregate stream. `sequence` is
1-based and strictly contiguous per aggregate.

| Field                                     | Meaning                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `eventId`, `aggregateType`, `aggregateId` | Identity and stream placement                     |
| `sequence`                                | Position; also the aggregate version after commit |
| `type`, `schemaVersion`, `payload`        | Domain fact and its versioned shape               |
| `timestamp`                               | Commit time, supplied by the append port          |
| `causationId`                             | Command id that caused the event, or `null`       |
| `correlationId`                           | TaskRun id used for tracing                       |
| `actor`, `sensitivity`                    | Who caused it and how private it is               |

`EventDraft` is the pre-commit form: `type`, `payload`, `actor`,
`sensitivity`, `schemaVersion`, `causationId`. `draft(type, payload, options)`
fills defaults: current schema version, `internal` sensitivity, `null`
causation. See [events.ts](../packages/domain/src/events.ts).

## 4. Event vocabulary

Every event type belongs to the TaskRun aggregate in this repository.

| Event                            | Payload                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `task_run.created`               | `conversationId`, `workspaceId`, `parentTaskRunId`, `model`, `policyId`, `budget` (limits) |
| `task_run.queued`                | none                                                                                       |
| `task_run.admitted`              | none                                                                                       |
| `attempt.started`                | `attemptId`, `ordinal`, `reason`, `provider`, `model`                                      |
| `attempt.usage_recorded`         | `attemptId`, `usage` (`inputTokens`, `outputTokens`, `totalTokens`)                        |
| `task_run.waiting`               | `reason` (`WaitingReason`)                                                                 |
| `task_run.resumed`               | none                                                                                       |
| `attempt.retry_scheduled`        | `attemptId`, `nextOrdinal`, `delayMs`, `dueAt`                                             |
| `task_run.checkpointing`         | `checkpointId`, `attemptId`                                                                |
| `checkpoint.committed`           | `checkpointId`, `eventPosition`                                                            |
| `task_run.reconciling`           | `reason`                                                                                   |
| `task_run.reconciled`            | none                                                                                       |
| `task_run.reconciliation_failed` | `FailureInfo`                                                                              |
| `task_run.cancelling`            | `cause`                                                                                    |
| `task_run.cancelled`             | `cleanup`: `completed` or `forced`                                                         |
| `task_run.succeeded`             | `summary`, `attemptId`                                                                     |
| `task_run.failed`                | `failure`, `attemptId`                                                                     |
| `task_run.budget_exhausted`      | `dimension`, `limit`, `consumed`                                                           |
| `task_run.policy_denied`         | `capability`, `reason`                                                                     |

Typed vocabulary: `AttemptReason` (`initial`, `retry`, `resume`, `reconcile`),
`WaitingReason` (`approval`, `retry_delay`, `child_result`, `tool_process`,
`external_input`, `resource_capacity`, `reconciliation`), `FailureCode`
(`provider_error`, `tool_error`, `context_overflow`, `policy_denied`,
`internal_error`, `unrecoverable`) and `FailureInfo` (`{ code, message }`).

## 5. Commands

A command is an intent that names the version it expects. The envelope is
`{ type, commandId, taskRunId, expectedVersion, actor, payload }`;
`commandId` is the idempotency key. `AnyCommand` is the discriminated union of
all nineteen commands.

| Command            | Payload                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `CreateTaskRun`    | `conversationId`, `workspaceId`, `parentTaskRunId`, `model`, `policyId`, `budget` |
| `Admit`            | none                                                                              |
| `Schedule`         | none                                                                              |
| `StartAttempt`     | `attemptId`, `reason`, `provider`, `model`                                        |
| `RecordUsage`      | `attemptId`, `usage` (`inputTokens`, `outputTokens`, `totalTokens`)               |
| `Wait`             | `reason`                                                                          |
| `Resume`           | none                                                                              |
| `Retry`            | `attemptId`, `delayMs`, `dueAt`                                                   |
| `BeginCheckpoint`  | `checkpointId`, `attemptId`                                                       |
| `CommitCheckpoint` | `checkpointId`, `eventPosition`                                                   |
| `BeginReconcile`   | `reason`                                                                          |
| `ResolveReconcile` | none                                                                              |
| `FailReconcile`    | `failure`                                                                         |
| `RequestCancel`    | `cause`                                                                           |
| `CompleteCleanup`  | `cleanup`                                                                         |
| `Complete`         | `summary`, `attemptId`                                                            |
| `Fail`             | `failure`, `attemptId`                                                            |
| `ExhaustBudget`    | `dimension`, `limit`, `consumed`                                                  |
| `DenyPolicy`       | `capability`, `reason`                                                            |

`commandTarget(command)` returns the targeted `TaskRunId`. See
[commands.ts](../packages/domain/src/commands.ts).

## 6. TaskRun aggregate state

`TaskRunAggregate` is either `TaskRunState` or `UncreatedTaskRun`
(`{ status: 'absent', version: 0 }`, exported as `ABSENT`).

| Field                                              | Meaning                                                     |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `id`, `status`, `version`                          | Identity; status; last committed sequence                   |
| `conversationId`, `workspaceId`, `parentTaskRunId` | References                                                  |
| `model`, `policyId`                                | Selected model and policy at creation                       |
| `budget`                                           | `RunBudget` snapshot created from the creation event        |
| `activeAttempt`                                    | `{ attemptId, ordinal, reason, provider, model }` or `null` |
| `attemptCount`                                     | Number of attempts started so far                           |
| `waitingReason`                                    | Current reason while `waiting`/`reconciling`, else `null`   |
| `pendingCheckpointId`                              | Checkpoint being committed, else `null`                     |
| `lastCommittedCheckpointId`                        | Most recent committed checkpoint                            |
| `cancellationCause`                                | Cause recorded by `RequestCancel`                           |
| `terminal`                                         | `{ status, failure, summary }` once terminal, else `null`   |

Statuses: `created`, `queued`, `admitted`, `running`, `waiting`, `retrying`,
`checkpointing`, `reconciling`, `cancelling`, `succeeded`, `failed`,
`cancelled`, `budget_exhausted`, `policy_denied`, `unrecoverable`. The last six
are terminal (`TERMINAL_STATUSES`). See
[state.ts](../packages/domain/src/state.ts).

## 7. Decisions and folds

- `decide(aggregate, command): Result<readonly TaskRunEventDraft[]>` — pure;
  it never mutates the aggregate and produces either event drafts or a
  `DomainError`.
- `evolve(aggregate, event)` — applies one committed event.
- `replay(events)` — rebuilds the aggregate from an ordered stream, starting at
  `ABSENT`.
- `initialBudget(limits)` — convenience wrapper around `createBudget` for hosts.

See [decide.ts](../packages/domain/src/decide.ts) and
[evolve.ts](../packages/domain/src/evolve.ts).

## 8. Budgets

`RunBudget` is `{ limits, consumed, reserved }` over seven dimensions:
`active_time_ms`, `provider_cost_usd`, `provider_tokens`, `tool_calls`,
`retry_attempts`, `child_runs`, `process_starts`.

- A limit is a finite non-negative number or `null` (unlimited).
- `consumed` is monotonic; it never decreases.
- `reserved` is subtracted from `available`, so an unresolved reservation keeps
  blocking capacity.
- Operations return `Result<RunBudget>`: `reserve`, `settle`, `release`,
  `consume`. `available` and `isExhausted` are read-only helpers.
- `settle` cannot exceed the amount reserved in that dimension; `release` cannot
  release more than is reserved.
- `createBudget` validates every limit (`assertLimit`) and starts both counters
  at zero; `unlimitedBudget` returns all-`null` limits.
- Provider token consumption is evented: `RecordUsage` commits
  `attempt.usage_recorded` and `evolve` adds `totalTokens` to
  `consumed.provider_tokens` monotonically. When actual usage crosses a finite
  `provider_tokens` limit, the decision also commits `task_run.budget_exhausted`
  and the run becomes terminal (ADR-0012). Reservations, cost and the remaining
  dimensions are not yet driven by committed events.

See [budget.ts](../packages/domain/src/budget.ts).

## 9. Side effects

A side effect has durable identity before it is executed. States:
`planned`, `denied`, `authorized`, `started`, `failed_before_commit`,
`confirmed`, `uncertain`, `compensated`, `reconciliation_failed`.

| From                                                                     | Allowed next                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| `planned`                                                                | `denied`, `authorized`                              |
| `authorized`                                                             | `started`                                           |
| `started`                                                                | `failed_before_commit`, `confirmed`, `uncertain`    |
| `uncertain`                                                              | `confirmed`, `compensated`, `reconciliation_failed` |
| `confirmed`                                                              | `compensated`                                       |
| `denied`, `failed_before_commit`, `compensated`, `reconciliation_failed` | none                                                |

`canTransition`/`transition` enforce the table. `requiresReconciliation` is true
for `uncertain` and `reconciliation_failed`. `retryVerdict` returns:

| State                                                                    | Verdict                   |
| ------------------------------------------------------------------------ | ------------------------- |
| `failed_before_commit`                                                   | `safe`                    |
| `uncertain`, `reconciliation_failed`                                     | `requires_reconciliation` |
| `denied`, `confirmed`, `compensated`, `planned`, `authorized`, `started` | `forbidden`               |

Compensation is a new record; the confirmed effect is never rewritten. See
[side-effect.ts](../packages/domain/src/side-effect.ts).

## 10. Errors and results

Expected outcomes are values: `Result<TValue, TError = DomainError>` with `ok`
and `err`. `DomainError` carries a code — `invalid_transition`,
`version_conflict`, `terminal_state`, `invariant_violation`, `unknown_event`,
`invalid_argument` — plus structured `details`, and offers the factories
`invalidTransition`, `versionConflict`, `terminal`, `invariant` and
`invalidArgument`. Exceptions are reserved for programmer error, such as an
invalid id or a structurally impossible event stream. See
[errors.ts](../packages/domain/src/errors.ts).

## 11. What is not modelled

The domain recognises conversation, workspace, capability-policy and
process-tree aggregate types, but only ids cross into the TaskRun stream. There
are no provider, tool-invocation, approval, checkpoint-snapshot or telemetry
entities, and no capability-grant evaluation. Budgets exist as pure models:
provider token settlement and exhaustion are committed, while reservations and
the other dimensions are not.
