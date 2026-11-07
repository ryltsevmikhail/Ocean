# Desktop service settings and decisions

The current-source Desktop Plugins toolbar now negotiates service settings and
service-call decisions explicitly. Its native host delegates the nine settings
methods to the public authenticated LocalRuntimeClient and uses the existing
list/get/full SHA-verified preview/resolve decision methods. Only the native host
chooses the profile, client and fixed `ws_ocean` workspace. Negotiation failures
and unsupported features remain visible. A partially capable current runtime
cannot expose the writable historical fallback; supported older runtimes may
retain their explicitly historical plugin interface.

The current form supports declarative HTTP URL plus an optional private key, or
pinned Node stdio configuration: executable, SHA256, optional package.json SHA256,
optional isolated workspaceRoot and either no arguments or `/workspace`. It does
not install commands or manage stdio keys/environment. Saving permission and
requesting metadata are separate owner actions. Merely selecting a connection
never discovers metadata. Recorded permission, actual readiness, published tools
and current config/trust/credential versions are shown separately. Disconnect and
HTTP key removal require explicit actions with the current version triple. Key
removal uses persisted metadata rather than unsaved form edits and preserves a
disconnected connection; ordinary configuration save explicitly activates it.

New grants bind the current room and selected bot, with project/task null. The
UI currently offers the entire connection resource scope and clearly states
that it covers every resource reachable by that connection. Account/repository
labels do not enforce a narrower scope. Exact tool names remain separate values;
current-set and all-including-future use existing runtime policies. Autonomous
is the default; confirm and future-tool access require explicit selections. The
proposed editable limits are maxCalls 1000, maxEffectBytes 1048576 and expiresAt
null. Public contract guards validate input and the runtime remains responsible
for catalog, trust, policy, scope and grant revision checks. Coding/project/task
scope editing remains planned separately.

Key inputs clear before awaiting IPC and on selection, context change and dialog
close/Escape. No credentials or pending requests are stored in browser storage.
Lost responses query the original request receipt without automatically sending
another mutation. The original result snapshot is labelled separately from
current connection metadata; absent/prepared/unknown is never success. An owner
can look up an original request ID after reopening. Reopening also reads bounded
prepared-operation pages (50 rows/page, at most 20 pages); truncation is explicit.
Prepared set/refresh intent supports explicit recovery with a new request ID,
current versions and required key resupply. Recovery requires selecting the exact
prepared request and entering fresh material in its separate destination-labelled
input; another connection's password is never used. The old prepared fact is preserved.
Old rows without intent remain read-only unknown and require manual setup.

Service-call cards show the owning room/run, status and the entire verified
plain-text operation, including backend executor/request/effect facts. SHA256,
full length, current version/digest and context must match before allow/deny is
enabled. The backend owns lifetime and CAS. Another owner resolving the same card
observes the same terminal decision; allowed does not establish effect completion.
Closing a dialog/window or disconnecting never cancels a run or resolves a card.
Reopening reloads the runtime facts. Bounded decision batches expose a continuation
cursor, so a pending service call beyond the first 1000 mixed decisions remains
reachable. Original receipt lookups clear previous feedback and bind result/error
to the latest requested identity and context. Different Desktop userData roots remain
subject to the existing profile asset enrollment binding; this change does not
widen it. An independent public SDK process is a separate owner client.

The current-runtime historical archive exposes connection/grant/operation facts
without install, enable, grant or unknown-operation acknowledgement mutations.
Known declarative HTTP configuration may prefill a deterministic legacy-ID /
generation proposal with a blank key, metadata permission none and no grants.
Existing proposed IDs cannot silently overwrite current rows. Historical rows do
not carry pinned Node hashes, so their unsupported/unknown configuration requires
manual setup. Archived tools, repository, visibility and account facts remain
unchanged. Legacy identity/schema/generation/env-name fields prove no durable
credential continuity or current enforcement. A newly approved wider connection
scope is a new grant, never an active permission migration.

Provider/model hints use the existing status.code: missing valid references may
require explicit resupply, while corrupt/insecure secret stores preserve their
contents and require separate safe repair. No reset/delete-all advice or storage
healing is introduced.

This is implemented source behavior with synthetic settings/decision GUI
qualification recorded separately in the C18.5.3.2 report. Installed/released
Desktop acceptance, real credentials, live vendor models/services and the full F
release matrix remain separate gates. C5 remains incomplete until all children
and the production gates reconcile.
