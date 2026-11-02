# Coding approval development

Status: stage 4 in progress. The domain binding and expiry predicate are
implemented; durable storage, owner decisions, atomic consumption and host UI
integration remain pending.

An approval binding identifies workspace, task, project and worktree, room,
bot, run, attempt and invocation, operation kind, exact operation hash, source
tree hash, policy version, limits hash and qualified toolchain hash.
A decision is valid for at most five minutes, expires at the deadline, and
is refused if the clock precedes creation or any binding field changes.

These types grant no authority on their own. Application admission must
validate task ownership, lease and pending claims, persist the exact preview
and trusted owner decision, then atomically consume an allowed decision
before dispatch. Restored decisions remain unusable.
