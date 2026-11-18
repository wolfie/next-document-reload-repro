# Pages Router dev server reloads every tab with "_document has changed" without `_document` being edited

`next dev --webpack`, Pages Router only (no `app/` directory). When the set of server entries changes (an API route or page is compiled for the first time, or disposed after `onDemandEntries.maxInactiveAge` of inactivity), the dev server sends

```json
{"type":"reloadPage","data":"_document has changed"}
```

over `/_next/hmr` and every open tab does a full page reload, although `pages/_document` was not edited.

## Environment

- next 16.4.6 (also reproduces on 16.5.0-canary.54), react / react-dom 19.3.1, webpack mode (`--webpack`)
- Node 26.13.1 (any Node >= 22 works for `repro.mjs`), pnpm 12.21.0, macOS (Darwin 25.6, arm64)
- The pnpm layout matters for naming only; see "Precondition" below.

## Reproduce (scripted, no browser)

```sh
pnpm install
pnpm dev                  # terminal 1: next dev --webpack -p 3100 (onDemandEntries.maxInactiveAge = 5s)
node repro.mjs            # terminal 2: prints every relevant HMR message, ends in PASS or FAIL
```

Restart the dev server with `rm -rf .next` between runs (the order flips on every trigger, so a second run against the same server can start from the already-flipped state).

`repro.mjs` GETs `/` and `/api/hello`, opens `ws://localhost:3100/_next/hmr`, sends `{"event":"ping","page":"/"}` every 2.5s like `on-demand-entries-client`, idles past `maxInactiveAge`, edits `components/Counter.js` (restored afterwards) and exits 1 (`FAIL`) if a `reloadPage` message arrived. It also prints the vendor chunk list from the startup line of `.next/dev/server/pages/_document.js` before and after.

Faster variant without waiting: `SCENARIO=add-api node repro.mjs` against a fresh `.next` (the very first request to `/api/hello` while a tab is open is enough).

Default timing: `MAX_INACTIVE_AGE_MS=60000 pnpm dev` and `MAX_INACTIVE_AGE_MS=60000 node repro.mjs` (about 80s); same result, just slower.

### Manual (browser)

1. `pnpm dev`, open http://localhost:3100/ (page A) and keep the tab open.
2. In another tab or with curl, request `http://localhost:3100/api/hello` once. This compiles the API route. (Fast variant: this alone already reloads tab A, no further steps needed on a fresh `.next`.)
3. Close that second tab / keep only page A open. Only A is pinged from now on, so after `maxInactiveAge` (default 60s; 5s here) the API route is flagged for disposal.
4. Wait longer than that, then edit `components/Counter.js`.
5. Tab A does a full reload instead of fast refresh; the server sent `reloadPage "_document has changed"`.

## Expected / actual

Expected: editing a component hot-updates the page; `_document` did not change, so no full reload.
Actual (`FAIL` run):

```
[ 13.7s] HMR <- {"type":"built","hash":"8a35caa5112367a1","warnings":[],"errors":[]}
[ 13.7s] HMR <- {"type":"reloadPage","data":"_document has changed"}

  before: vendor-chunks/next@16.4.6  vendor-chunks/@opentelemetry+api@1.10.0  vendor-chunks/@swc+helpers@0.5.23
  after:  vendor-chunks/next@16.4.6  vendor-chunks/@swc+helpers@0.5.23  vendor-chunks/@opentelemetry+api@1.10.0
```

The only difference in `.next/dev/server/pages/_document.js` is the order of two chunks in the startup line:

```diff
-var __webpack_exports__ = __webpack_require__.X(0, ["vendor-chunks/next@16.4.6_…","vendor-chunks/@opentelemetry+api@1.10.0","vendor-chunks/@swc+helpers@0.5.23"], …
+var __webpack_exports__ = __webpack_require__.X(0, ["vendor-chunks/next@16.4.6_…","vendor-chunks/@swc+helpers@0.5.23","vendor-chunks/@opentelemetry+api@1.10.0"], …
```

## Root cause

- `next/dist/server/dev/hot-reloader-webpack.js`: the server compiler's `done` hook compares `compilation.namedChunks.get('pages/_document').hash` with the previous hash and sends `RELOAD_PAGE` / `"_document has changed"` on any difference. The guard that ignores spurious changes (diffing chunk names) is wrapped in `if (this.appDir)`, so Pages-Router-only apps have no protection.
- `next/dist/build/webpack-config.js` (dev, node server): `optimization.splitChunks.cacheGroups.vendor` creates one `vendor-chunks/<package>` chunk per `node_modules` package, all in one cache group with the same priority. `SplitChunksPlugin` (`compareEntries`) therefore orders chunk creation by number of entry chunks sharing the module group, then by `size * (n - 1)`. The startup list in every entry (`__webpack_require__.X(0, [...])`) follows that creation order.
- In this repro `@swc/helpers` is used by 4 server entries (`_error`, `_app`, `index`, `_document`) and `@opentelemetry/api` by 3 without the API route (`_error`, `index`, `_document`) or 4 with it (+ `api/hello`; `_app` does not use it). So with the API route compiled it is a tie in entry count that is decided by size, and without it `@opentelemetry/api` is shared by fewer entries. Adding or removing an entry that shares one of the two chunks but not the other flips the order, which changes the `_document` chunk hash although its modules are identical.
- The on-demand-entries handler disposes pages / API routes that were not pinged for `maxInactiveAge` (the page a client pings is exempt); disposal is applied in the next compilation, usually the one triggered by an unrelated component edit. Compiling a new page / API route on first request flips the order the same way.

### Precondition

`@opentelemetry/api` must be bundled into the server chunks, i.e. resolvable from `next` but not from the project root (otherwise Next externalizes it and there is no such vendor chunk). With pnpm that is the normal case when it arrives transitively. `pnpm-workspace.yaml` in this repro simulates it with `packageExtensions` so no extra package is needed. Any two vendor chunks in `_document`'s list whose entry-share counts cross over show the same thing.

## Workaround

Pin the order with distinct priorities (`WORKAROUND=1 pnpm dev`, see `next.config.mjs`):

```js
webpack: (config, { dev, isServer, nextRuntime }) => {
  if (dev && isServer && nextRuntime === 'nodejs') {
    const { cacheGroups } = config.optimization.splitChunks;
    cacheGroups.swcHelpers = { ...cacheGroups.vendor, test: /[\\/]node_modules[\\/]@swc[\\/]helpers[\\/]/, priority: 2 };
    cacheGroups.opentelemetryApi = { ...cacheGroups.vendor, test: /[\\/]node_modules[\\/]@opentelemetry[\\/]api[\\/]/, priority: 1 };
  }
  return config;
},
```

With it both scenarios end in `PASS: no reloadPage received` and the chunk order stays identical before and after.

## Suggested fix

Apply the chunk-name-diff guard in `hot-reloader-webpack.js` regardless of `this.appDir`, or compare something that does not depend on chunk ordering (e.g. a hash of `_document`'s module ids / contents instead of `chunk.hash`).
