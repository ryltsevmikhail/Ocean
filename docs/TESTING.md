# Test compiler and runtime gates

Run `pnpm check` from the workspace root. It runs production TypeScript,
strict test TypeScript, ESLint, source tests, then built process tests, in that
order. `pnpm build` and `pnpm format:check` remain separate required gates.

`pnpm typecheck:tests` is the complete test compiler gate. Its two commands
are `pnpm typecheck:tests:node` and `pnpm typecheck:tests:desktop`.
`tsconfig.tests.json` contains shared no-emit options and source aliases; it
has no standalone roots and is not an aggregate compiler command.

The Node configuration owns package and CLI sources, tests, fixtures, root
network setup, and root test configurations. It uses ES2023 and Node types,
without DOM globals. The desktop configuration owns desktop TypeScript,
fixtures and Vite configuration, plus the same network setup. It uses ES2023,
DOM, DOM.Iterable, DOM.AsyncIterable and Node types. DOM.AsyncIterable supplies
the standard streaming HTTP types used by imported provider source. Shared
code imported by desktop tests is also checked transitively in that context.
Both configurations inherit the production strict flags without emitting.

Public workspace packages and their exported subpaths resolve to source for
static checking. Fixture children that qualify built entry points still load
`dist` at runtime; explicit source module types check their callers without
using generated declarations as the compiler authority. TypeScript fixture
imports ending in `.ts` are allowed only by the no-emit test configurations.

Typechecking includes native and process tests even when their runtime gates
are skipped. Passing TypeScript does not qualify native behavior, external
services or Vue SFC templates. The desktop bundle command separately runs
`vue-tsc`, Vite and the preload bundle. Runtime source/process presets retain
their existing test discovery and environment gates.
