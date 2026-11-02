# Interrupted-run review (M4)

Ocean can inspect a run and let its local owner allow a new text-only turn after
an unknown outcome. The old run keeps its factual status, and unresolved tool
claims keep their global replay block. Startup only completes locally prepared
answers and performs reconciliation. It never sends the old prompt again.

## CLI

Exit the TUI before opening the same profile from the CLI.

```sh
pnpm ocean run list --profile /absolute/ocean-profile --json
pnpm ocean run review TASK_RUN_ID --profile /absolute/ocean-profile --json
pnpm ocean run show TASK_RUN_ID --profile /absolute/ocean-profile --json
```

Review returns task and chat phase, counts and safe identities of pending effects,
current room policy, canAcknowledge and an opaque version string. It omits
tool arguments, raw fingerprints, conversation bodies and secrets. Copy the
version string exactly as a shell-quoted argument for the next operation.

```sh
pnpm ocean run acknowledge TASK_RUN_ID --text-only --review-version 'TOKEN_FROM_REVIEW' --reason "Inspected the interrupted work" --request-id review-1 --profile /absolute/ocean-profile --json
```

Acknowledgement requires live TTY input and an explicit y confirmation.
Redirected input, n, cancellation and a changed review version leave the room
hold intact. Confirmation explains possible previous execution/billing and that
new messages can create a new paid request. Reusing an already committed request
ID with identical inputs returns its receipt without a second decision.

## TUI

Open the affected room and type /review. The UI shows the held turn and retains
its exact review version locally. Then type:

```text
/continue text-only Inspected the interrupted work
```

The confirmation screen accepts y once or n. Session-wide approval is unavailable
for this decision. Escape/Ctrl+C rejects the decision and can cancel the pending
UI action. Under redirected input the decision is refused. Slash commands do not
enter model history or create TaskRuns. An owner-authored notice is saved only
when acknowledgement commits.

## Transaction and limits

Schema 5 adds immutable audit records, room execution policies and a continuation
review reference on a chat turn. After consent, the application rechecks the
committed task version, chat status, current policy and all unresolved claim
identities/outcomes inside the same transaction as the decision. A stale view
returns review_conflict. Custom adapters lacking synchronous committed evidence
cannot grant acknowledgement.

The notice, audit, room policy, continuation reference and request receipt commit
together. The old uncertain status is preserved. Only its room hold is released.
Later attempts cannot remove that review reference or publish an old response.
The next explicit prompt creates its own TaskRun with no tools. A missing final
provider result is never changed into a confirmed cancellation, and no journal
claim is settled by this administrative decision.

Room paths currently advertise no model tools. Legacy task/ACP paths still obey
the global tool journal. An unresolved claim remains replay-blocking even after
room acknowledgement and process restart. A native process-stop verifier is a
separate qualification activity.

## Checks

Tests kill actual child Node processes with SIGKILL after admission, after model
dispatch, after durable preparation and before answer publication. They use the
normal application services with a synthetic provider and inspect the persistent
database after startup recovery. They establish local crash behavior without
claiming remote-provider availability. Additional checks cover stale evidence,
consent denial, redirected stdin, audit rollback, exactly-once notices, immutable
uncertainty and CLI/TUI continuity after reopening.
