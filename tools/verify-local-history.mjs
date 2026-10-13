// End-to-end render check with the REAL host state file and a fake host.
// Drives the bundle exactly like a reload, then renders the sidebar row, the
// trend dialog and the settings section, reporting any thrown error.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const state = JSON.parse(
  await readFile(join(process.env.USERPROFILE, '.dsh', '.balance-monitor.json'), 'utf8'),
)
const source = await readFile('lib/client.js', 'utf8')

let hookState = []
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    const resolved = { ...(props ?? {}), children: flat.length > 1 ? flat : flat[0] }
    if (typeof type === 'function') return type(resolved)
    return { type, props: resolved }
  },
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookIndex++
    if (hookState[index] === undefined) hookState[index] = [typeof initial === 'function' ? initial() : initial, () => {}]
    return hookState[index]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_s, getSnapshot) => getSnapshot(),
}

const store = new Map()
const ls = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.localStorage = ls

let registration = null
new Function('window', 'document', 'fetch', source)(
  { __ModuleLoader__: { load: (e) => { registration = e } }, localStorage: ls },
  {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  },
  () => Promise.reject(new Error('no network')),
)

const requireTable = {
  react: React,
  'react/jsx-runtime': { jsx: React.createElement, jsxs: React.createElement },
  '@deepseek-ai/dsh-client-ui-primitives': {
    Modal: (props) => ({
      type: 'ModalCard',
      props: { ...props, children: [props.description, props.children] },
    }),
    Tooltip: (props) => ({ type: 'Tooltip', props }),
  },
}
const exported = registration.factory((s) => requireTable[s])

const balances = state.history[state.history.length - 1].balances
const rows = Object.keys(balances).map((c) => ({
  currency: c,
  balance: balances[c] - 0.42,
  granted: 0,
  toppedUp: 100,
  total: balances[c] - 0.42,
  available: true,
}))
let n = 0
globalThis.fetch = (url) => {
  n += 1
  const p = String(url)
  const body = p.includes('/balance-monitor/balance')
    ? { balances: rows, currency: rows[0].currency, available: true, phase: { phase: 'peak', label: '高峰', hint: 'x' }, spend: state.spend }
    : p.includes('/balance-monitor/health')
      ? { ok: true, version: '1.2.0', node: process.versions.node, requests: n, stateFile: 'x', lastError: null }
      : { config: state.config, history: state.history, spend: state.spend }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const registrations = []
const locale = { register: () => () => {}, bind: () => (k) => k }
const slots = {
  inject(name, factory) { registrations.push({ name, handle: factory() }) },
  register: (options, component) => ({ ...options, component }),
}
const ctx = {
  get: (name) => (name === 'locale' ? locale : name === 'slots' ? slots : undefined),
  inject: (_services, cb) => cb({ get: (name) => ctx.get(name) }),
  effect: (fn) => { fn() },
  on() {},
}

exported.apply(ctx)
await new Promise((r) => setTimeout(r, 150))

const render = (component, props) => {
  hookIndex = 0
  hookState = []
  return component(props)
}
const collect = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) collect(item, out); return out }
  if (typeof node === 'object' && node.props !== undefined) collect(node.props.children, out)
  return out
}
const findClass = (node, token) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findClass(item, token); if (hit) return hit }
    return null
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes(token)) return node
  return findClass(node.props?.children, token)
}

const footer = registrations.find((r) => r.name === 'sidebar.footer.action')
const section = registrations.find((r) => r.name === 'settings.section')

console.log('# state')
console.log('  host frames       :', state.history.length)
console.log('  fetch calls       :', n)
console.log('  local span        :', JSON.stringify(exported.localHistorySpan()))

const badge = render(footer.handle.component, { wide: true })
const badgeText = collect(badge).join('')
console.log('\n# sidebar row')
console.log('  text              :', badgeText)
console.log('  has row class     :', findClass(badge, 'bm-row') !== null)

// Open the dialog and walk every tab, so each window path is exercised.
const tabs = ['近1小时', '近6小时', '近24小时', '近7天', '近30天', '全部']
const rangeButton = (tree, label) => {
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const item of node) { const hit = walk(item); if (hit) return hit }
      return null
    }
    if (typeof node.props?.className === 'string' && node.props.className.includes('bm-range-btn') && collect(node).join('') === label) return node
    return walk(node.props?.children)
  }
  return walk(tree)
}
findClass(badge, 'bm-row')?.props?.onClick?.()
console.log('\n# 额度消耗趋势 dialog')
for (const tab of tabs) {
  const current = render(footer.handle.component, { wide: true })
  rangeButton(current, tab)?.props?.onClick?.()
  const tree = render(footer.handle.component, { wide: true })
  const text = collect(tree).join('|')
  const body = findClass(tree, 'bm-trend-body')
  const svg = findClass(tree, 'bm-chart') !== null
  const selected = findClass(tree, 'bm-on') !== null
  const samples = /本区间 (\d+) 个采样点 · 实际跨度 ([^|]+)/.exec(text)
  console.log(
    '  ' + tab.padEnd(6),
    'mounted', String(body !== null).padEnd(5),
    'chart', String(svg).padEnd(5),
    'tab on', String(selected).padEnd(5),
    samples === null ? '(no sample line)' : `${samples[1]} samples / ${samples[2]}`,
  )
  if (body === null) console.log('    text:', text.slice(0, 300))
}
findClass(render(footer.handle.component, { wide: true }), 'bm-modal-card')?.props?.onClose?.()

console.log('\n# settings section')
const sectionTree = render(section.handle.component, {})
const sectionText = collect(sectionTree).join('|')
// Each diagnostics row renders as `<label>|<value>`, and a label can be a prefix
// of another one (本地采样 vs 本地采样存储), so match label-then-value.
const sectionRow = (label) => {
  const match = new RegExp(label + '\\|([^|]*)').exec(sectionText)
  return match === null ? 'MISSING' : match[1]
}
for (const needle of ['余额监控', '本地采样存储', '本地采样', '本地占用', '宿主历史', '保留 30 天']) {
  console.log('  ' + needle.padEnd(12), sectionText.includes(needle) ? 'ok' : 'MISSING')
}
console.log('  sample line :', sectionRow('本地采样'))
console.log('  usage line  :', sectionRow('本地占用'))
process.exit(0)
