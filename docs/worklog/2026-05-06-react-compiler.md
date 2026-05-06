# 2026-05-06 — Enable React Compiler in dashboard

## What changed

Enabled the React Compiler (`babel-plugin-react-compiler@1.0.0`) for the
dashboard via a `@rolldown/plugin-babel` Vite plugin. The compiler runs over
all `.ts`/`.tsx` source and auto-memoizes components/hooks, importing the
runtime helpers from `react/compiler-runtime` (split into its own chunk).

To pick up `@rolldown/plugin-babel`'s peer requirement of `vite@^8`, Vite was
upgraded from `7.3.2` → `8.0.10` and rwsdk from `1.2.0` → `1.3.0-canary.0`
(rwsdk 1.3 is the first version whose peer range includes Vite 8 — verified
against `npm view rwsdk@1.3.0-canary.0 peerDependencies`).

## Details

### `packages/dashboard/vite.config.mts`

```ts
import babel from "@rolldown/plugin-babel";
import reactCompiler from "babel-plugin-react-compiler";

plugins: [
  cloudflare({ viteEnvironment: { name: "worker" } }),
  redwood(),
  babel({
    presets: ["@babel/preset-typescript"],
    plugins: [reactCompiler],
  }),
  tailwindcss(),
],
```

Notes:

- `redwood()` already wires `@vitejs/plugin-react` internally — no separate
  `react()` call.
- `@rolldown/plugin-babel`'s options are flat (`presets` / `plugins` at the
  top level), not nested under a `babelOptions` key. Default `include` is
  `/\.(?:[jt]sx?|[cm][jt]s)(?:$|\?)/`, default `exclude` skips
  `node_modules` — both fine for our case.
- `babel-plugin-react-compiler@1.0.0` exposes the compiler as the default
  export; there is no `reactCompilerPreset` named export at any published
  version (1.0.0, 19.1.0-rc.3, beta, experimental). The published rwsdk
  documentation snippet that uses `reactCompilerPreset()` does not match the
  shipped package surface — the plugin form is the working invocation.

### Dependencies (`packages/dashboard/package.json`, devDependencies)

| Added                                   | Why                                                                 |
| --------------------------------------- | ------------------------------------------------------------------- |
| `@babel/core ^7.29.0`                   | Peer of `@rolldown/plugin-babel`                                    |
| `@babel/preset-typescript ^7.28.5`      | Strips TS syntax so babel can parse `.tsx` source for compiler pass |
| `@rolldown/plugin-babel ^0.2.3`         | Vite-compatible babel runner for the compiler                       |
| `babel-plugin-react-compiler ^1.0.0`    | The compiler itself                                                 |
| `vite ~8.0.10` (upgraded from `~7.3.2`) | Required peer for `@rolldown/plugin-babel`                          |

`rwsdk` bumped from `^1.2.0` to `1.3.0-canary.0` (first release whose peer
range covers Vite 8).

## Verification

- `pnpm --filter @wrightful/dashboard build` — succeeds for both client and
  worker environments. Build time ~1.3s vs ~0.6s pre-compiler; the
  `compiler-runtime-*.js` chunk is emitted and imported by every client
  island that has memoizable hooks (e.g. `run-progress`, `field`, `client`).
- `pnpm --filter @wrightful/dashboard test` — all 333 tests pass across
  unit + components projects.
- `pnpm --filter @wrightful/dashboard typecheck` — same 6 pre-existing errors
  (in `runs-filter-bar.test.tsx` and `run-progress-broadcast.test.ts`)
  reproduced on the unchanged tree via `git stash`. None are caused by the
  compiler.

## Risks / follow-ups

- Build-time cost: the babel pass roughly doubles `vite build` for the
  dashboard. Acceptable for now; if it becomes a CI bottleneck the `include`
  regex could be narrowed to client-island directories only.
- The compiler bails on rules-of-React violations rather than erroring. Worth
  spot-checking dev-server console for `[React Compiler]` warnings during
  the next round of dev work and cleaning up any flagged components.
- rwsdk `1.3.0-canary.0` is a canary release — pin to a stable `1.3.x` once
  available.
