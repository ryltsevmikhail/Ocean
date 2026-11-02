# Coding conversation integration

Status: stage 5 in progress.

Chat requests can bind an explicit taskId. That identity is included in request
deduplication and persisted as codingTaskId on the admitted turn. A plain chat
retains its historical receipt identity and receives no tools. Task-bound sends
require an injected host factory; a group message without a selected recipient
cannot carry task execution authority.

The common direct/group service requests tools from the factory only for a
fresh admitted task turn. Duplicate receipts never create another factory or
provider dispatch. The factory must recheck current task authority, project
lease, restored state and pending effects. Production factory and command
parsing remain pending. A durable chat regression verifies explicit factory
requirement, task persistence and refusal to reuse a receipt for another task.
