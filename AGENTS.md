# Agent Instructions

## Package manager and JS runtime

Use **Bun** everywhere in this repository. Never use `npm`, `npx`, `yarn`, or `pnpm`.

- Install dependencies with `bun install` (never `npm install`).
- Run scripts with `bun run <script>` (never `npm run`).
- Run package binaries with `bunx <bin>` (never `npx`).
- Run JS tests with `bun ./tests/test_backend_lighting.js` and `bun test ./tests/test_lighting_engine.js ./tests/test_daemon_protocol.js` (or `bun run test` inside `src/psense-electron`).
- Keep only `bun.lock`. Never create or commit `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`.
