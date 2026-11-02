# ADR 0001: Runtime and CLI are the whole product; the desktop client is a separate project

- **Status:** accepted
- **Date:** 2026-10-31
- **Supersedes:** the Rust runtime, Rust clients and Rust-specific decisions of
  the archived Runne documentation (`ADR-0001 Use Rust for GOCODE Runtime` and
  the ADRs that depend on it). It also replaces any assumption that a desktop
  shell, renderer or native host is built in this repository.

## Context

The archived Runne design combined a Rust execution core, Rust clients and a
Tauri desktop host. That combination is not being rebuilt. Ocean is its own
runtime: an event-sourced TypeScript execution core for AI coding-agent
workflows, shipped with a CLI host. The archived documentation is reference
material and provenance — not a porting target, and not a structure to mirror.

The project owner has fixed the product boundary: this repository is the
runtime and its CLI, and nothing else. The desktop application is a separate
project. It is not built here, does not live here, and consumes this runtime as
an external client.

Drivers for that boundary:

1. **One responsibility per repository.** Execution semantics — commands,
   events, lifecycle, budgets, side effects — are the product here. Windows,
   rendering, packaging and OS integration are not.
2. **The client must be free to evolve.** A separate project can choose its UI
   stack, release cadence and platform strategy without constraining the
   runtime's tests or dependency tree.
3. **The runtime must be consumable from outside.** A client that lives in a
   different repository can only use what this runtime exposes as a contract.
   Anything the client needs must be expressible there.
4. **Small, boring toolchain.** Node.js and pnpm are the only required
   toolchains; no native build, no UI framework and no second language in this
   repository.

## Decision

1. **This repository is the runtime plus a CLI host.** The runtime is
   `@runnets/domain` (pure model), `@runnets/application` (ports and command
   service) and `@runnets/store` (adapters); the CLI host is `apps/cli` /
   `@runnets/cli`. That is the whole product surface here.
2. **No UI, no desktop shell, no native host.** There is no Vue renderer, no
   Tauri or Electron host, no windowing, packaging code signing or OS
   integration in this repository. There is no Rust in this repository: no Rust
   toolchain requirement and no Rust CI lane.
3. **The desktop client is a separate project and an external consumer.** It
   may not import runtime internals. It builds against the runtime's contract
   and is released independently.
4. **The contract boundary is a product API.** The runtime must expose a
   stable, typed, versioned contract: command, query and event DTOs; explicit
   command identity and idempotency; expected-version fencing; replay cursors;
   and versioned schemas. An out-of-repository client must be buildable against
   that contract without reaching into `src/` modules or depending on
   implementation classes.
5. **The archive is reference and provenance.** Ocean is its own runtime. The
   MIT-licensed Runne archive informs intended behavior and is attributed in
   [NOTICE](../../NOTICE); it is not ported and its Rust layout, crate
   structure and requirement IDs are not targets.

## Alternatives considered

| Alternative                                       | Why rejected                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and desktop application in one repository | Mixes execution semantics with UI and OS integration, forces a second toolchain and a UI dependency tree into the runtime, and couples two release cadences                           |
| Runtime embedded in the client process only       | Leaves nothing an out-of-repository client can build against; an external client cannot link a TypeScript package's internals, so the boundary would have to be invented later anyway |
| Port the archived Rust runtime                    | The Rust implementation is abandoned; re-implementing it in Rust is not the chosen path, and the archive is reference material rather than a porting target                           |
| Build the desktop shell here (Electron or Tauri)  | Windowing, packaging and OS integration are client concerns; either choice adds a toolchain and UI dependencies this repository must not carry                                        |
| Keep the runtime as a dev-only helper of the CLI  | Forfeits the external-client use case the product now depends on                                                                                                                      |

## Consequences

### Positive

- The repository stays single-purpose: domain, application, adapters, CLI tests
  and tooling; Node.js and pnpm are the only toolchains.
- No UI framework, webview, IPC layer or native build enters the runtime's
  dependency tree or CI.
- The runtime can be exercised in process (tests, CLI) or hosted behind a
  service without changing its core.
- The client project is free to choose its own stack, platform scope and
  release process.

### Negative

**The contract boundary becomes a public API with compatibility obligations.**
An out-of-repository client can only depend on what is exposed:

- Command, query and event DTOs must be stable, typed and versioned. Today
  events carry `schemaVersion` (`TASK_RUN_SCHEMA_VERSION = 1`), but there is no
  contract version, negotiation or serialized DTO layer.
- Command identity and idempotency must be part of the contract, not a property
  of an in-process adapter: `commandId` is the idempotency key today, and
  `CommandDedupPort` stores receipts in memory only.
- Expected-version fencing must survive the boundary: `expectedVersion` is a
  field on the in-process command, not a wire-level contract with documented
  conflict semantics.
- Replay and subscriptions need cursors. `EventLogPort.load` returns the whole
  stream; there is no cursor, page boundary or at-least-once delivery contract
  for an external consumer.
- Breaking changes to these shapes are breaking changes for every
  out-of-repository client.

**The boundary is currently incomplete.** It is honest to say what the runtime
does not yet expose: there is no HTTP/SSE/WebSocket transport, no authentication
or authorization surface, no serialized error model (errors are in-process
`Result` values with `DomainError` codes), and no process-level lifecycle for a
separate runtime. Ports (`EventLogPort`, `CommandDedupPort`, `Clock`,
`IdGenerator`) are TypeScript interfaces consumed in process — today the CLI
embeds the packages directly. External consumption requires the contract work
above; it is not available by importing the packages.

**Cross-process concerns move out of this repository.** Launching and
supervising the runtime, credential handling, replay delivery and client-side
caching belong to the client or its hosting layer. This repository has no
opinion on them, which means a client must solve them, and the integration is
not covered by the tests here.

**UI and OS integration are explicitly out of scope.** Rendering, windowing,
packaging, signing, auto-update and platform sandbox integration are not
delivered by this repository. A client that needs them owns them.

### Neutral

- Event-sourced state, expected-version fencing, terminal immutability,
  monotonic budgets and "uncertain effects never auto-retry" are unaffected by
  this boundary.
- The package layering already points inward (domain ← application ← adapters ←
  hosts), which is the shape a contract layer would attach to.
- The archive's requirement IDs, crate layout and Rust-specific ADRs remain
  history; [AGENTS.md](../../AGENTS.md) states that documentation describes what
  exists.

## Implementation status

Present: the domain model, application service, in-memory adapters and CLI
host. Absent by decision: any desktop application, renderer or native host.
Absent and still required for external clients: a transport, a serialized and
versioned contract, authentication and replay cursors. See
[ARCHITECTURE.md](../ARCHITECTURE.md) for the current component inventory.

## References

- [Architecture](../ARCHITECTURE.md)
- [Domain model](../domain-model.md)
- [State machines](../state-machines.md)
- [README](../../README.md)
- [NOTICE](../../NOTICE) — archive and OpenCode attribution
