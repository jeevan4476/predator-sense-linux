/**
 * P0 toolchain seed (`feat/ts-migration`, build model B-lite).
 *
 * `tsc -p .` requires at least one input file, and this tree is still
 * fully .js. This seed consumes exactly one input (tsconfig include:
 * [env.d.ts, *.ts]) so typecheck passes today and grows file-by-file
 * as each .js gains its authoritative .ts twin. Per-phase generated
 * .d.ts files land with their migrations (P2: ddsc-table.d.ts).
 *
 * Ambient declarations below: shared shim environment only.
 */

/**
 * Data resources imported as `require("*.json")` (CJS shim style) type
 * as the wildcard module until the explicit per-file declarations are
 * generated in P2.
 */
declare module "*.json";
