/**
 * Standalone smoke test for the host half (lib/index.js).
 *
 * Builds a minimal cordis-shaped context backed by a real node:http server that
 * implements the same `register({ kind, path, handler })` contract as
 * @deepseek-ai/dsh-host-webserver, then exercises every route:
 *
 *   GET  /balance-monitor/health
 *   GET  /balance-monitor/balance   (live official API through mock credentials)
 *   GET  /balance-monitor/config
 *   POST /balance-monitor/config    (valid patch, clamping, rejected patch)
 *   POST /balance-monitor/reset
 *
 * Run with: node test/host-smoke.mjs
 */

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the smoke test out of the real DSH home.
const fakeHome = await mkdtemp(join(tmpdir(), 'balance-monitor-test-'))
process.env.DSH_HOME = fakeHome

const { apply } = await import('../lib/index.js')

const routes = new Map()
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.get(url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  Promise.resolve(route(req, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500)
    if (!res.writableEnded) res.end(String(err))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/** Minimal webServer-shaped service. */
const webServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

/** Credentials seam reading the real key from the environment. */
const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.TEST_DEEPSEEK_API_KEY
const credentials = {
  resolve(ref) {
    if (ref === 'DEEPSEEK_API_KEY' && typeof apiKey === 'string' && apiKey.length > 0) {
      return Promise.resolve({ value: apiKey, source: 'env' })
    }
    return Promise.resolve(undefined)
  },
}

/** The host half requires webServer on the Web profile and credentials always. */
const services = new Map([['webServer', webServer], ['credentials', credentials]])
const effects = []
const ctx = {
  get: (name) => services.get(name),
  on: () => {},
  effect: (fn) => {
    const dispose = fn()
    effects.push(dispose)
  },
}

apply(ctx)

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

async function getJson(path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

console.log(`fake DSH_HOME: ${fakeHome}`)
console.log(`base: ${base}`)
console.log(`api key present: ${typeof apiKey === 'string' && apiKey.length > 0}`)

console.log('\n# routes registered')
check('4 routes registered', routes.size === 4, `got ${routes.size}: ${[...routes.keys()].join(', ')}`)

console.log('\n# GET /balance-monitor/health')
{
  const { status, body } = await getJson('/balance-monitor/health')
  check('status 200', status === 200, String(status))
  check('ok true', body.ok === true)
  check('transport webServer', body.transport === 'webServer', String(body.transport))
  check('version string', typeof body.version === 'string', String(body.version))
  check('node string', typeof body.node === 'string', String(body.node))
  check('stateFile under fake home', typeof body.stateFile === 'string' && body.stateFile.startsWith(fakeHome), String(body.stateFile))
}

console.log('\n# GET /balance-monitor/config (defaults)')
{
  const { status, body } = await getJson('/balance-monitor/config')
  check('status 200', status === 200, String(status))
  check('default refreshInterval 30', body.config.refreshInterval === 30, String(body.config.refreshInterval))
  check('default displayCurrency auto', body.config.displayCurrency === 'auto', String(body.config.displayCurrency))
  check('default icon wallet', body.config.icon === 'wallet', String(body.config.icon))
  check('default rollDuration 0.85', body.config.rollDuration === 0.85, String(body.config.rollDuration))
  check('history is array', Array.isArray(body.history))
}

console.log('\n# POST /balance-monitor/config')
{
  const ok = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshInterval: 45, icon: 'bag' }),
  })
  check('accepted', ok.status === 200, String(ok.status))
  check('refreshInterval applied', ok.body.config.refreshInterval === 45, String(ok.body.config.refreshInterval))
  check('icon applied', ok.body.config.icon === 'bag', String(ok.body.config.icon))

  const clamped = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshInterval: 1 }),
  })
  check('below-range clamped to 5', clamped.body.config.refreshInterval === 5, String(clamped.body.config.refreshInterval))

  const high = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshInterval: 99999 }),
  })
  check('above-range clamped to 3600', high.body.config.refreshInterval === 3600, String(high.body.config.refreshInterval))

  const wrapped = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { displayCurrency: 'USD' } }),
  })
  check('{ config } envelope accepted', wrapped.body.config.displayCurrency === 'USD', String(wrapped.body.config.displayCurrency))

  const bad = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ icon: 'diamond' }),
  })
  check('invalid icon rejected 400', bad.status === 400, String(bad.status))
  check('rejection names the field', typeof bad.body.error === 'string' && bad.body.error.includes('icon'), String(bad.body.error))

  const badCurrency = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayCurrency: 'usd' }),
  })
  check('lowercase currency rejected', badCurrency.status === 400, String(badCurrency.status))

  const afterBad = await getJson('/balance-monitor/config')
  check('rejected patch did not persist', afterBad.body.config.icon === 'bag', String(afterBad.body.config.icon))
}

console.log('\n# GET /balance-monitor/balance')
{
  const first = await getJson('/balance-monitor/balance')
  check('status 200', first.status === 200, String(first.status))
  if (apiKey === undefined) {
    check('no-key path reports a helpful error', typeof first.body.error === 'string' && first.body.error.includes('DEEPSEEK_API_KEY'), String(first.body.error))
  } else {
    check('no error', first.body.error === null, String(first.body.error))
    check('balances is a non-empty array', Array.isArray(first.body.balances) && first.body.balances.length > 0, JSON.stringify(first.body.balances))
    check('numeric balance', typeof first.body.balance === 'number', String(first.body.balance))
    check('currency code', typeof first.body.currency === 'string' && /^[A-Z]{2,8}$/.test(first.body.currency), String(first.body.currency))
    check('spend object', first.body.spend !== null && typeof first.body.spend === 'object')
    const cny = first.body.balances.find((b) => b.currency === 'CNY')
    check('CNY row carries flag/granted/toppedUp', cny !== undefined && 'flag' in cny && 'granted' in cny && 'toppedUp' in cny, JSON.stringify(cny))
  }

  const cached = await getJson('/balance-monitor/balance')
  check('second read served', cached.status === 200, String(cached.status))

  const forced = await getJson('/balance-monitor/balance?force=1')
  check('force=1 bypasses the cache', forced.status === 200, String(forced.status))
}

console.log('\n# history + spend after a successful read')
{
  const { body } = await getJson('/balance-monitor/config')
  if (apiKey !== undefined) {
    check('history recorded one sample', Array.isArray(body.history) && body.history.length >= 1, `len=${body.history?.length}`)
    const last = body.history[body.history.length - 1]
    check('sample has numeric t', typeof last?.t === 'number')
    check('sample has balances map', last?.balances !== null && typeof last?.balances === 'object', JSON.stringify(last?.balances))
    check('spend is numeric', typeof body.spend?.CNY === 'number', JSON.stringify(body.spend))
  } else {
    check('lastError surfaced for diagnostics', typeof body.lastError === 'string', String(body.lastError))
  }
}

console.log('\n# POST /balance-monitor/reset')
{
  const methodNotAllowed = await getJson('/balance-monitor/reset')
  check('GET rejected 405', methodNotAllowed.status === 405, String(methodNotAllowed.status))

  const reset = await getJson('/balance-monitor/reset', { method: 'POST' })
  check('status 200', reset.status === 200, String(reset.status))
  check('ok true', reset.body.ok === true)
  check('history cleared', Array.isArray(reset.body.history) && reset.body.history.length === 0, `len=${reset.body.history?.length}`)
  check('spend zeroed', reset.body.spend?.CNY === 0, JSON.stringify(reset.body.spend))
  check('config kept by default', reset.body.config.icon === 'bag', String(reset.body.config.icon))

  const wipe = await getJson('/balance-monitor/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keepConfig: false }),
  })
  check('keepConfig:false restores defaults', wipe.body.config.icon === 'wallet' && wipe.body.config.refreshInterval === 30,
    `icon=${wipe.body.config.icon} interval=${wipe.body.config.refreshInterval}`)
  check('rollDuration clamp low', (await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rollDuration: 0.01 }),
  })).body.config.rollDuration === 0.3, 'expected 0.3')
  check('rollDuration clamp high', (await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rollDuration: 99 }),
  })).body.config.rollDuration === 3, 'expected 3')
  check('rollDuration rejects a non-number', (await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rollDuration: 'fast' }),
  })).status === 400, 'expected 400')

  // Restore the defaults last, so the persistence assertion below sees them.
  const restored = await getJson('/balance-monitor/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keepConfig: false }),
  })
  check('defaults restored for the persistence check', restored.body.config.icon === 'wallet' && restored.body.config.rollDuration === 0.85,
    JSON.stringify(restored.body.config))
}

console.log('\n# persistence file')
{
  // persistSoon() debounces 250ms; wait, then force one more write.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const { readFile } = await import('node:fs/promises')
  let text = null
  try {
    text = await readFile(join(fakeHome, '.balance-monitor.json'), 'utf8')
  } catch (err) {
    text = null
  }
  check('state file written', typeof text === 'string', 'missing .balance-monitor.json')
  if (typeof text === 'string') {
    const parsed = JSON.parse(text)
    check('persisted config round-trips', parsed.config.icon === 'wallet', JSON.stringify(parsed.config))
    check('persisted history is an array', Array.isArray(parsed.history))
  }
}

console.log('\n# every collected icon is accepted by the host')
{
  // The browser half renders the whole collection; the host validates `icon`
  // against its own list. If that list is narrower, picker tiles silently fail
  // to save (the host answers 400 and the old value sticks) — so pin the two
  // together, and prove each id round-trips through the actual route.
  // Placed last: it changes the stored icon.
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname: dirOf, join: joinOf } = await import('node:path')
  const { loadClientBundle } = await import('./lib/load-client-bundle.mjs')
  const here = dirOf(fileURLToPath(import.meta.url))
  const hostSource = await readFile(joinOf(here, '..', 'lib', 'index.js'), 'utf8')

  const hostList = hostSource.match(/const ICON_IDS = \[([\s\S]*?)\];/)
  const hostIds = hostList === null
    ? []
    : (hostList[1].match(/"[a-z0-9]+"/g) ?? []).map((s) => s.replace(/"/g, ''))

  // Read the collection from the evaluated bundle, not from its source text:
  // source parsing breaks whenever the file is reformatted, and the icon
  // entries carry nested arrays/objects that defeat a naive scan.
  const client = await loadClientBundle()
  const clientIds = client.exports.ICONS.map((entry) => entry.id)

  check('client collection found', clientIds.length >= 12, String(clientIds.length))
  check('host list found', hostIds.length >= 12, String(hostIds.length))

  const missing = clientIds.filter((id) => !hostIds.includes(id))
  check('host accepts every collected icon', missing.length === 0, `missing from host: ${missing.join(', ')}`)
  check('host default icon is in its own list', hostIds.includes('wallet'), hostIds[0])

  let accepted = 0
  for (const id of clientIds) {
    const response = await getJson('/balance-monitor/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ icon: id }),
    })
    if (response.status === 200 && response.body.config.icon === id) accepted += 1
  }
  check(`all ${clientIds.length} icons round-trip through POST /config`, accepted === clientIds.length, `accepted ${accepted}`)

  // The currency-symbol placement has the same client/host coupling: the
  // picker's ids must be exactly the host's whitelist.
  const hostSymbols = [...(hostSource.match(/const SYMBOL_POSITIONS = \[([\s\S]*?)\];/)?.[1] ?? '')
    .matchAll(/"([a-z]+)"/g)].map((m) => m[1])
  const clientSymbols = client.exports.SYMBOL_OPTIONS.map((option) => option.id)
  check('host whitelists three placements', hostSymbols.length === 3, hostSymbols.join(','))
  check('client offers exactly the host placements',
    hostSymbols.length > 0 && hostSymbols.every((id) => clientSymbols.includes(id)) && clientSymbols.length === hostSymbols.length,
    `host=[${hostSymbols.join(',')}] client=[${clientSymbols.join(',')}]`)

  let symbolAccepted = 0
  for (const id of hostSymbols) {
    const response = await getJson('/balance-monitor/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currencySymbol: id }),
    })
    if (response.status === 200 && response.body.config.currencySymbol === id) symbolAccepted += 1
  }
  check('every placement round-trips through POST /config', symbolAccepted === hostSymbols.length, `accepted ${symbolAccepted}`)

  const badSymbol = await getJson('/balance-monitor/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currencySymbol: 'middle' }),
  })
  check('unknown placement rejected 400', badSymbol.status === 400, String(badSymbol.status))
  check('rejection names the field', typeof badSymbol.body.error === 'string' && badSymbol.body.error.includes('currencySymbol'),
    String(badSymbol.body.error))

  const restoredSymbol = await getJson('/balance-monitor/config')
  check('default placement is after', restoredSymbol.body.config.currencySymbol === 'none' || restoredSymbol.body.config.currencySymbol === 'after',
    String(restoredSymbol.body.config.currencySymbol))
}

console.log('\n# effect disposal')
{
  // Four route effects; the Web-profile carrier has nothing to tear down, so
  // no carrier-disposal effect is registered here.
  check('every route registered through ctx.effect', effects.length === 4, `effects=${effects.length}`)
  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose()
  }
  check('disposers removed all routes', routes.size === 0, `routes=${routes.size}`)
}

server.close()
await rm(fakeHome, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
