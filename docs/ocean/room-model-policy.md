# Room model transfer policy

Implemented: every migrated and newly created direct or group room has a persisted
`RoomModelPolicy` with `cloudTransfer: 'allow'` and revision 1. This preserves historical
behavior; it is not a new grant. The application exports `RoomModelPolicyService.set`
with room/workspace scope, request receipts and revision CAS. A fresh same-value
mutation increments the revision. An exact retry returns its historical receipt.
Missing or invalid authoritative policy refuses admission, including under allow.

`deny` admits only an explicit canonical connection classified local from its kind
and valid loopback endpoint. A provider name, host injection, credentials, connection
availability or local qualification cannot establish locality. Activation separately
refuses unavailable local models; there is no cloud fallback. Policy admission runs
before conversation context and image resolution for addressed direct turns and
queued broadcast children. Bot rebinding checks every owning room in its existing
transaction. Standalone cloud bots and mixed rooms under allow remain supported.

Setting deny conflicts without changing policy or receipt if any current member is
cloud or unknown. It also conflicts on room-owned queued cloud/unknown frozen
bindings and accepted, dispatching, prepared or uncertain cloud/unknown activations.
These checks use durable frozen work independently of current bot bindings and
text-only continuation reviews. An uncertain reviewed turn can block deny indefinitely.
Completed, failed and proven cancelled work adds no new hold. Successful mutation
never claims cancellation, remote cleanup, data deletion or reversal of billing.
A failed transition leaves the old policy unchanged; clients must show its blocking
reason and must not describe privacy revocation as complete.

Planned: Task 15 host settings/RPC/UI composition. No policy RPC or scheduler is
introduced here. Local-only setup currently means create, then successfully set deny;
atomic create-with-deny requires a later explicit contract. Immediate per-request
revocation requires coordinated dispatch permits, not an incidental policy read.
Future membership addition/replacement must validate every new frozen binding in the
membership CAS/receipt transaction. Removal must preserve admitted turn evidence.
A future room Retry must reacquire current room-policy authority without rewriting
its frozen activation, clearing unknown outcomes or redispatching receipt replays.
