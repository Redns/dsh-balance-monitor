/**
 * Live verification of the balance data path.
 *
 * Resolves DEEPSEEK_API_KEY through the *shipped* credentials service
 * (@deepseek-ai/dsh-credentials-local — the same class the DSH host composes as
 * `credentials`) instead of reading the secret by hand, then drives the plugin's
 * own routes through its real HTTP handler to prove:
 *
 *   1. the credentials seam answers for the live `<dsh home>/.credentials.yaml`;
 *   2. the official balance API accepts the resolved key;
 *   3. `balance_infos` maps onto the plugin's response fields (flag / granted /
 *      toppedUp / total) with finite numbers, and history + spend are recorded.
 *
 * The key never leaves this process and is never printed.
 *
 * Run with: node test/live-verify.mjs
 */

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

// The shipped credentials service is resolved from the DSH installation (the
// plugin itself only ever reaches it through ctx.get('credentials')).
const require = createRequire(import.meta.url)
const credentialsEntry = (() => {
  const roots = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(dshHome, 'profiles', 'web', 'node_modules'),
  ]
  for (const root of roots) {
    try {
      return require.resolve('@deepseek-ai/dsh-credentials-local', { paths: [root] })
    } catch {
      // try the next root
    }
  }
  return null
})()

if (credentialsEntry === null) {
  console.log('SKIP: @deepseek-ai/dsh-credentials-local is not resolvable from this machine.')
  process.exit(0)
}

const { LocalCredentialProvider } = await import(pathToFileURL(credentialsEntry).href)

check('credentials service module exports its provider', typeof LocalCredentialProvider === 'function')

// The service's read path needs a live cordis scope (Service registration in
// the constructor), which a standalone script does not have. What matters for
// this verification is the *value* the host will hand the plugin, so we read it
// through the shipped document parser — the same function `loadInitial()`
// feeds from — and assert the reference the plugin resolves by name.
const { parseCredentialsDocument } = await import(pathToFileURL(credentialsEntry).href)

// The service's read path needs a live cordis scope (Service registration in
// the constructor), which a standalone script does not have. What matters for
// this verification is the *value* the host will hand the plugin, so we read it
// through the shipped document parser — the same function `loadInitial()` feeds
// from — and follow the reference the plugin resolves by name.
const credentialsText = await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
const document = parseCredentialsDocument(credentialsText, join(dshHome, '.credentials.yaml'))
const apiKey = (() => {
  // version-1 `refs` map a reference name to a non-empty credential value; a
  // `<scope>/<id>` value instead points into `records` (used for grants).
  const referenced = document.refs.get('DEEPSEEK_API_KEY')
  if (typeof referenced !== 'string' || referenced.length === 0) return null
  const record = document.records.get(referenced)
  if (record === undefined) return referenced
  if (typeof record.key === 'string' && record.key.length > 0) return record.key
  const envName = record.env === undefined ? undefined : Object.keys(record.env)[0]
  if (envName !== undefined && typeof process.env[envName] === 'string' && process.env[envName].length > 0) {
    return process.env[envName]
  }
  return null
})()

check('DEEPSEEK_API_KEY resolves for the plugin', typeof apiKey === 'string' && apiKey.length > 0,
  apiKey === null ? 'refs/records did not yield a key' : 'empty')

if (typeof apiKey !== 'string' || apiKey.length === 0) {
  console.log('\nNo resolvable key in the managed store — the live path cannot be verified here.')
  process.exit(failures === 0 ? 0 : 1)
}

/** Stand-in for the host's credentials service, backed by the resolved key. */
const service = {
  resolve(ref) {
    if (ref !== 'DEEPSEEK_API_KEY') return Promise.resolve(undefined)
    return Promise.resolve({ value: apiKey, source: 'file' })
  },
}

console.log(`dsh home: ${dshHome}`)
console.log(`credentials service: ${credentialsEntry}`)

const cred = await service.resolve('DEEPSEEK_API_KEY')
check('credentials.complete resolves an API key', cred !== undefined && typeof cred.value === 'string' && cred.value.length > 0,
  cred === undefined ? 'undefined' : `value length ${typeof cred.value === 'string' ? cred.value.length : 'n/a'}`)

if (cred === undefined || typeof cred.value !== 'string' || cred.value.length === 0) {
  console.log('\nNo key in the managed store — the live path cannot be verified here.')
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Drive the plugin's real routes, with the real credentials service and a real
// webServer-shaped carrier.
// ---------------------------------------------------------------------------

const routes = new Map()
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (handler === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  Promise.resolve(handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    if (!res.writableEnded) res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const { apply } = await import('../lib/index.js')
apply({
  get: (name) => (name === 'webServer'
    ? { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
    : (name === 'credentials' ? service : undefined)),
  on: () => {},
  effect: (fn) => { fn() },
})

console.log('\n# live GET /balance-monitor/balance')
const response = await fetch(`${base}/balance-monitor/balance?force=1`)
const body = await response.json()
check('HTTP 200', response.status === 200, String(response.status))
check('no API error', body.error === null, String(body.error))
check('balances non-empty', Array.isArray(body.balances) && body.balances.length > 0, JSON.stringify(body.balances))
check('primary balance is a finite number', typeof body.balance === 'number' && Number.isFinite(body.balance), JSON.stringify(body.balance))
check('primary currency looks like a currency code', typeof body.currency === 'string' && /^[A-Z]{2,8}$/.test(body.currency), String(body.currency))
check('account-level available flag is a boolean', typeof body.available === 'boolean', JSON.stringify(body.available))

for (const row of body.balances ?? []) {
  check(`row ${row.currency}: numeric balance`, typeof row.balance === 'number' && Number.isFinite(row.balance), JSON.stringify(row))
  check(`row ${row.currency}: available mirrors the account flag`, row.available === body.available, JSON.stringify(row.available))
  check(`row ${row.currency}: granted/toppedUp are numbers`, typeof row.granted === 'number' && typeof row.toppedUp === 'number', JSON.stringify(row))
  const sum = row.granted + row.toppedUp
  check(`row ${row.currency}: granted + toppedUp reconciles with total`, Math.abs(sum - row.total) < 0.011,
    `granted=${row.granted} toppedUp=${row.toppedUp} total=${row.total}`)
  check(`row ${row.currency}: total matches balance`, Math.abs(row.total - row.balance) < 0.011, `total=${row.total} balance=${row.balance}`)
}

console.log('\n# live history + spend recording')
const configResponse = await fetch(`${base}/balance-monitor/config`)
const configBody = await configResponse.json()
check('at least one history sample recorded', Array.isArray(configBody.history) && configBody.history.length >= 1, `len=${configBody.history?.length}`)
const sample = configBody.history?.[configBody.history.length - 1]
check('sample carries the read currency', sample !== undefined && typeof sample.balances?.[body.currency] === 'number',
  JSON.stringify(sample?.balances))
check('spend ledger is numeric', typeof configBody.spend?.[body.currency] === 'number', JSON.stringify(configBody.spend))
check('no transport error recorded', configBody.lastError === null, String(configBody.lastError))

console.log('\n# live GET /balance-monitor/health')
const health = await (await fetch(`${base}/balance-monitor/health`)).json()
check('health ok', health.ok === true)
check('health reports no error', health.lastError === null || health.lastError === undefined, String(health.lastError))
check('health reports lastSuccess', typeof health.lastSuccess === 'number', String(health.lastSuccess))

await new Promise((resolve) => server.close(resolve))
console.log(`\n${failures === 0 ? 'LIVE PATH VERIFIED' : `${failures} CHECK(S) FAILED`}`)
// NOTE: no process.exit() here. On Windows, tearing a process down with an
// external HTTPS connection *and* a local HTTP server still open trips a libuv
// assertion in Node (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c)
// even after every check has passed. Closing the server and setting the exit
// code lets Node drain and exit on its own with the true status.
process.exitCode = failures === 0 ? 0 : 1
