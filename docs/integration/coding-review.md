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

The application service now creates an owner-confirmed immutable review request
with artifact/test binding and explicit context grants, then validates reviewer
identity, finding anchors and evidence freshness before persisting a verdict.
No conversation-history or tool executor port enters reviewer handoff.
Regression tests verify default empty context, exact seeded-defect artifact,
stale-evidence refusal and one verdict per request. Concrete durable storage,
provider review dispatch and exact application remain pending.
Root check/build pass; global formatting is still blocked by parallel untracked
character-atlas files, while the changed source formatting passes.
