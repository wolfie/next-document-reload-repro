// Usage: start `npm run dev` (next dev --webpack, port 3100) in another terminal, then `node repro.mjs`.
// Needs Node >= 22 (global WebSocket). No browser.
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT ?? '3100';
const BASE = `http://localhost:${PORT}`;
const DOCUMENT = '.next/dev/server/pages/_document.js';
const COMPONENT = 'components/Counter.js';
const MAX_INACTIVE_AGE_MS = Number(process.env.MAX_INACTIVE_AGE_MS ?? 5000); // must match next.config.mjs (Next default: 60000)
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...args);

const startupLine = () =>
  readFileSync(DOCUMENT, 'utf8')
    .split('\n')
    .find((l) => l.includes('__webpack_require__.X(0,'))
    ?.match(/X\(0, (\[[^\]]*\])/)?.[1] ?? '(not found)';
const chunkList = (line) => (line.match(/vendor-chunks\/[^"]+/g) ?? []).map((c) => c.replace(/_react.*|_@.*/, ''));

async function get(path) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(BASE + path).catch(() => null);
    if (res?.status === 200) return res;
    await sleep(500); // freshly added entries may 404 until the file watcher catches up
  }
  throw new Error(`GET ${path} never returned 200 - is "npm run dev" running on port ${PORT}?`);
}

// SCENARIO=idle (default): compile page + API route, idle past maxInactiveAge, edit a component.
// SCENARIO=add-api: no waiting - the first request to /api/hello while a tab is open is enough.
const SCENARIO = process.env.SCENARIO ?? 'idle';

// 1. Compile page A (/) and, for the idle scenario, the API route, like browsing the app would.
await get('/');
if (SCENARIO === 'idle') await get('/api/hello');
log('compiled /' + (SCENARIO === 'idle' ? ' and /api/hello' : ''));

// 2. Behave like the browser's on-demand-entries client: ping the page being viewed every 2.5s.
const messages = [];
const ws = new WebSocket(`ws://localhost:${PORT}/_next/hmr`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('websocket error'));
});
ws.onmessage = (e) => {
  const text = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString();
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const type = msg.type ?? msg.action ?? msg.event;
  messages.push({ at: Date.now(), msg });
  const interesting = ['reloadPage', 'removedPage', 'addedPage', 'serverError', 'built', 'sync'].includes(type);
  if (interesting) log('HMR <-', JSON.stringify(msg).slice(0, 200));
};
const ping = () => ws.send(JSON.stringify({ event: 'ping', page: '/' }));
ping();
const pinger = setInterval(ping, 2500);
await sleep(1000);
log('pinging page "/" only, like an open tab on page A (the API route is never pinged)');

const before = startupLine();
log('_document.js startup line BEFORE:', before);

if (SCENARIO === 'add-api') {
  log('first request to /api/hello');
  await get('/api/hello');
  await sleep(5000);
} else {
  // 3. Let the API route exceed onDemandEntries.maxInactiveAge (it is flagged for disposal).
  const idle = MAX_INACTIVE_AGE_MS + 7000; // + dispose-check interval (min(5s, maxInactiveAge) + 1s) + slack
  log(`idling ${idle / 1000}s (onDemandEntries.maxInactiveAge=${MAX_INACTIVE_AGE_MS}ms)`);
  await sleep(idle);

  // 4. Edit a component of page A (not _document), wait, then restore it. The disposal is applied by this rebuild.
  const original = readFileSync(COMPONENT, 'utf8');
  try {
    log(`editing ${COMPONENT}`);
    writeFileSync(COMPONENT, original.replace(/counter v\d+/, 'counter v2'));
    await sleep(6000);
  } finally {
    writeFileSync(COMPONENT, original);
  }
  await sleep(3000);
}
clearInterval(pinger);
ws.close();

const after = startupLine();
log('_document.js startup line AFTER: ', after);
console.log('\nvendor chunk order in pages/_document.js startup line:');
console.log('  before:', chunkList(before).join('  '));
console.log('  after: ', chunkList(after).join('  '));

const reloads = messages.filter(({ msg }) => (msg.type ?? msg.action) === 'reloadPage');
const removed = messages.filter(({ msg }) => (msg.type ?? msg.action) === 'removedPage');
console.log(`\nremovedPage messages: ${removed.length}, reloadPage messages: ${reloads.length}`);
if (reloads.length) {
  console.log('FAIL: server sent reloadPage', JSON.stringify(reloads[0].msg), 'although pages/_document was not edited');
  process.exit(1);
}
console.log('PASS: no reloadPage received');
