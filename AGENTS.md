# Ocean contributor guidance

Ocean is a local TypeScript workspace based on RunneTS. Its first product milestone is direct and group conversations with named bots through a terminal client. See [the production roadmap](docs/ocean/production.md) for release scope, gates and operations, [the v1 plan](docs/ocean/v1.md) for proposed behavior and [runtime architecture](docs/ARCHITECTURE.md) for inherited behavior.

- Keep domain pure, application dependent only on domain, and I/O behind adapter ports. CLI/TUI and ACP are hosts. Access packages via public entry points.
- Keep strict TypeScript and the pinned pnpm version. Keep source files within 300 physical lines. Add regression tests for behavior changes.
- Persist authoritative state before external effects. Never infer confirmed cancellation or retry an unknown effect. Scope conversation context and approvals to their owning room and operation.
- Keep product docs explicit about planned versus implemented behavior. Preserve LICENSE and NOTICE. Never store credentials, real session databases or sensitive transcripts in Git.
- Run `pnpm check`, `pnpm build` and `pnpm format:check` from the workspace root before reporting a completed change. Qualify external services and native behavior separately.
