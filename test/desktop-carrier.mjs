/**
 * Desktop (Electron) carrier test.
 *
 * In the desktop composition `ctx.get('webServer')` is undefined, so the plugin
 * must start its own loopback carrier and publish its address through the
 * `webserver/index-inject` hook. This drives that path for real:
 *
 *   1. apply(ctx) with no webServer service;
 *   2. the emitted injection rows are rendered by the *shipped*
 *      `renderIndexInjections` and evaluated, proving the row shape is one the
 *      host actually accepts (an ad-hoc row object makes renderRow() throw);
 *   3. `window.__BALANCE_MONITOR_HOST__` lands on globalThis with a loopback
 *      origin, so the browser half can find the host;
 *   4. /health answers without a token, data routes reject a missing/wrong
 *      token with 403 and accept the injected one;
 *   5. disposing the effects removes the routes.
 *
 * Run with: node test/desktop-carrier.mjs
 */

import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// The shipped inject-table renderer, loaded from the DSH installation.
// ---------------------------------------------------------------------------

const webserverEntry = (() => {
  const roots = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(process.env.DSH_HOME ?? '', 'profiles', 'web', 'node_modules'),
  ]
  for (const root of roots) {
    try {
      return require.resolve('@deepseek-ai/dsh-host-webserver', { paths: [root] })
    } catch {
      // next root
    }
  }
  return null
})()

if (webserverEntry === null) {
  console.log('SKIP: @deepseek-ai/dsh-host-webserver is not resolvable from this machine.')
  process.exit(0)
}

const { renderIndexInjections } = await import(pathToFileURL(webserverEntry).href)
check('shipped renderIndexInjections is exported', typeof renderIndexInjections === 'function')

// ---------------------------------------------------------------------------
// apply(ctx) with credentials but NO webServer → loopback carrier.
// ---------------------------------------------------------------------------

// Keep the test out of the real DSH home: without this it reads (and rewrites)
// the user's live ~/.dsh/.balance-monitor.json, so assertions about defaults
// would reflect whatever the user last configured.
const fakeHome = await mkdtemp(join(tmpdir(), 'balance-monitor-desktop-'))
process.env.DSH_HOME = fakeHome

const plugin = await import('../lib/index.js')
const { apply } = plugin
const injectionRows = []
const effects = []
const listeners = new Map()
const ctx = {
  get(name) {
    if (name === 'credentials') {
      return { resolve: () => Promise.resolve(undefined) } // no key needed for health
    }
    return undefined // <- the desktop composition provides no webServer
  },
  on(event, handler) {
    listeners.set(event, handler)
  },
  effect(fn) {
    effects.push(fn())
  },
}

apply(ctx)

// The loopback bind is asynchronous: wait for it before reading the origin.
const bound = await plugin.activeCarrier().ready
check('loopback carrier bound a port', bound === true, 'every port in the range was busy')

check('four route effects plus carrier disposal', effects.length === 5, `count=${effects.length}`)
check('subscribed to webserver/index-inject', listeners.has('webserver/index-inject'))

console.log('\n# injection row shape')
listeners.get('webserver/index-inject')(injectionRows)
check('pushed exactly one row', injectionRows.length === 1, `count=${injectionRows.length}`)
const row = injectionRows[0]
check('row names the global', row?.name === '__BALANCE_MONITOR_HOST__', String(row?.name))
check('row carries an origin', typeof row?.value?.origin === 'string' && row.value.origin.startsWith('http://127.0.0.1:'),
  String(row?.value?.origin))
check('row carries a loopback token', typeof row?.value?.token === 'string' && row.value.token.length >= 32,
  `len=${row?.value?.token?.length}`)
check('row advertises the port list', Array.isArray(row?.value?.ports) && row.value.ports[0] === 17881,
  JSON.stringify(row?.value?.ports?.slice(0, 3)))

let rendered = null
try {
  rendered = renderIndexInjections('<!doctype html><html><head></head><body></body></html>', injectionRows)
} catch (err) {
  rendered = `THREW: ${err.message}`
}
check('shipped renderer accepts the row', typeof rendered === 'string' && !rendered.startsWith('THREW:'), String(rendered).slice(0, 160))
check('rendered markup defines the global', typeof rendered === 'string' && rendered.includes('__BALANCE_MONITOR_HOST__'),
  String(rendered).slice(0, 160))

// Evaluate the injected head script the way a browser would.
if (typeof rendered === 'string' && !rendered.startsWith('THREW:')) {
  const scripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  for (const script of scripts) new Function(script)()
  const injected = globalThis.__BALANCE_MONITOR_HOST__
  check('global is set after evaluation', injected !== null && typeof injected === 'object', String(injected))
  check('global origin matches the row', injected?.origin === row.value.origin, String(injected?.origin))
  check('global token matches the row', injected?.token === row.value.token, 'token mismatch')
}

// ---------------------------------------------------------------------------
// Loopback HTTP behaviour.
// ---------------------------------------------------------------------------

const base = row.value.origin
const token = row.value.token

// The listen is asynchronous; poll /health until it answers.
async function waitForHealth(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/balance-monitor/health`, { cache: 'no-store' })
      if (response.ok) return await response.json()
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

console.log('\n# loopback carrier routes')
const health = await waitForHealth()
check('carrier is listening', health !== null, `${base} never answered`)
check('health needs no token', health?.ok === true, JSON.stringify(health))
check('health reports the loopback transport', health?.transport === 'loopback', String(health?.transport))
check('health reports the bound port', health?.port === row.value.ports[0] || typeof health?.port === 'number', String(health?.port))

if (health !== null) {
  const noToken = await fetch(`${base}/balance-monitor/config`, { cache: 'no-store' })
  check('data route rejects a missing token (403)', noToken.status === 403, String(noToken.status))

  const wrongToken = await fetch(`${base}/balance-monitor/config?token=nope`, { cache: 'no-store' })
  check('data route rejects a wrong token (403)', wrongToken.status === 403, String(wrongToken.status))

  const withToken = await fetch(`${base}/balance-monitor/config?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
  check('data route accepts the injected token (200)', withToken.status === 200, String(withToken.status))
  const body = await withToken.json()
  check('config body carries defaults', body?.config?.icon === 'wallet' && body?.config?.refreshInterval === 30,
    JSON.stringify(body?.config))

  const bearer = await fetch(`${base}/balance-monitor/config`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  })
  check('data route also accepts Authorization: Bearer', bearer.status === 200, String(bearer.status))

  const unknown = await fetch(`${base}/balance-monitor/nope?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
  check('unknown path answers 404', unknown.status === 404, String(unknown.status))

  const preflight = await fetch(`${base}/balance-monitor/config`, { method: 'OPTIONS' })
  check('CORS preflight answers 204', preflight.status === 204, String(preflight.status))
}

console.log('\n# disposal')
for (const dispose of effects) {
  if (typeof dispose === 'function') dispose()
}
// `server.close()` stops accepting connections; poll until the port is refused.
let refused = false
const deadline = Date.now() + 5000
while (Date.now() < deadline) {
  const probe = await fetch(`${base}/balance-monitor/health`, { cache: 'no-store' }).catch(() => null)
  if (probe === null) {
    refused = true
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
}
check('loopback server stopped listening after disposal', refused, `${base} still answering`)

await rm(fakeHome, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'DESKTOP CARRIER OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
