# Coding changeset review development

Status: stage 6 in progress.

Domain review bindings identify exact task, changeset hash, base commit,
after-tree hash and ordered test evidence hashes. Findings anchor to a path,
before/after side and line in the immutable complete changeset. Missing paths,
absent file sides and invalid lines are refused. A changed artifact, base,
tree or evidence list makes a review stale.

Domain regression tests pass with root check and build. Root formatting is
currently blocked by an unrelated untracked design-assets/character-atlas
file; formatting of the changed domain files passes. Durable handoff/verdict
storage, isolated reviewer input and exact owner-approved application remain
pending.
