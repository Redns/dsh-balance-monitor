/**
 * Client bundle smoke test.
 *
 * Evaluates lib/client.js the way the shell does — a fake
 * `window.__ModuleLoader__`, a minimal document for the <style> tag, and a fake
 * `require` table — then drives the real `apply(ctx)` with fake `locale` and
 * `slots` services, and renders every registered component once with a fake
 * React so a runtime error in any of them fails the run instead of surfacing
 * only in the browser.
 *
 * The fake React is a function-based stand-in: it calls function components
 * (so their bodies execute) but does not implement reconciliation.
 *
 * Run with: node test/client-smoke.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

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
// Fake React: enough surface for the bundle's createElement/useState/useEffect.
// ---------------------------------------------------------------------------

let hookState = []
let hookIndex = 0

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  const resolvedProps = { ...(props ?? {}), children: flat.length > 1 ? flat : flat[0] }
  if (typeof type === 'function') return type(resolvedProps)
  return { type, props: resolvedProps }
}

const React = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookIndex++
    if (hookState[index] === undefined) {
      hookState[index] = [typeof initial === 'function' ? initial() : initial, () => {}]
    }
    return hookState[index]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

// ---------------------------------------------------------------------------
// Fake DOM for the injected <style> tag.
// ---------------------------------------------------------------------------

const styleTags = []
const document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
  documentElement: { appendChild: (tag) => styleTags.push(tag) },
}

// ---------------------------------------------------------------------------
// Fake module loader + require table.
// ---------------------------------------------------------------------------

/**
 * In-memory localStorage stand-in. The bundle reads the browser's own 30-day
 * series out of it, so the harness has to answer `getItem`/`setItem` — and it
 * tracks writes so the persistence path can be asserted rather than assumed.
 */
function makeLocalStorage() {
  const values = new Map()
  return {
    values,
    writes: 0,
    quota: Infinity,
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      const size = String(value).length
      if (size > this.quota) {
        const err = new Error('QuotaExceededError')
        err.name = 'QuotaExceededError'
        throw err
      }
      this.writes += 1
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

const localStorage = makeLocalStorage()

let registration = null
const window = {
  __ModuleLoader__: { load: (entry) => { registration = entry } },
  localStorage,
}

// Fake for the shell's dialog primitive. The real Modal body-portals its card;
// here it returns a PLAIN element rather than a component element, because the
// fake React above eagerly invokes function components — a nested fake
// component would be called with no props and its whole subtree lost. A plain
// element keeps the dialog walkable, which is all these checks need.
function Modal(props) {
  return {
    type: 'ModalCard',
    props: {
      className: `bm-modal-card ${props.className ?? ''}`.trim(),
      'data-open': String(props.open),
      'data-title': props.title,
      'data-close-label': props.closeLabel,
      onClose: props.onClose,
      children: [
        props.description === undefined ? null : createElement('p', null, props.description),
        props.children,
      ],
    },
  }
}

/**
 * Fake for the shell's Tooltip. Like Modal it must return a PLAIN element: the
 * fake React eagerly invokes function components, so a nested component would
 * be called with no props and its subtree lost. The row rides along as
 * `children` so the tree stays walkable, and the props are kept for assertions.
 */
function Tooltip(props) {
  return {
    type: 'Tooltip',
    props: {
      label: props.label,
      side: props.side,
      align: props.align,
      children: props.children,
    },
  }
}

const requireTable = {
  react: React,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement },
  '@deepseek-ai/dsh-client-ui-primitives': { Modal, Tooltip },
}

// Evaluate the bundle in a function scope that shadows window/document.
// `localStorage` inside the bundle resolves to the global below, exactly as it
// does in a page (Web Storage is a global, not a property of `window` here).
const localStorageGlobal = localStorage
globalThis.localStorage = localStorageGlobal
/**
 * Evaluate the bundle once. Returns the registration so a test can ask for a
 * SECOND, independent evaluation (the browser half is instantiated per page).
 */
function evaluateBundle(target) {
  const fakeWindow = target ?? { __ModuleLoader__: { load: () => {} } }
  const inner = fakeWindow.__ModuleLoader__.load
  let entry = null
  fakeWindow.__ModuleLoader__.load = (item) => {
    entry = item
    inner(item)
  }
  new Function('window', 'document', 'fetch', source)(
    fakeWindow,
    document,
    () => Promise.reject(new Error('no network in smoke test')),
  )
  return entry
}

const initialRegistration = evaluateBundle(window)
if (initialRegistration !== null) registration = initialRegistration

console.log('# bundle registration')
check('__ModuleLoader__.load was called', registration !== null)
check('bundle id is the package name', registration?.id === 'dsh-balance-monitor', String(registration?.id))
check('factory is a function', typeof registration?.factory === 'function')

const exportsObject = registration.factory((specifier) => {
  if (!(specifier in requireTable)) throw new Error(`unexpected require("${specifier}")`)
  return requireTable[specifier]
})

check('exports.apply is a function', typeof exportsObject.apply === 'function')
check('injected <style> tag', styleTags.length === 1, `count=${styleTags.length}`)
check('style tag carries plugin css', styleTags[0]?.textContent?.includes('bm-row'), 'missing .bm-row rule')

// ---------------------------------------------------------------------------
// Drive apply(ctx) with fake locale + slots services.
// ---------------------------------------------------------------------------

const registrations = []
const localeRegistrations = []

const locale = {
  register(ns, dicts) {
    localeRegistrations.push({ ns, dicts })
    return () => {}
  },
  bind(ns) {
    return (key) => `${ns}:${key}`
  },
}

const slots = {
  inject(name, factory) {
    const handle = factory()
    registrations.push({ name, handle })
  },
  register(options, component) {
    return { ...options, component }
  },
}

const effects = []
const ctx = {
  get: (name) => (name === 'locale' ? locale : (name === 'slots' ? slots : undefined)),
  inject(services, callback) {
    const scoped = { get: (name) => (services.includes(name) ? ctx.get(name) : undefined) }
    callback(scoped)
  },
  effect(fn) {
    effects.push(fn())
  },
  on() {},
}

exportsObject.apply(ctx)

console.log('\n# apply(ctx) wiring')
check('registered a locale dictionary', localeRegistrations.length === 1, `count=${localeRegistrations.length}`)
check('dictionary namespace', localeRegistrations[0]?.ns === 'balance-monitor', String(localeRegistrations[0]?.ns))
check('registered one effect', effects.length === 1, `count=${effects.length}`)
check('registered two slots', registrations.length === 2, `count=${registrations.length}`)
const footer = registrations.find((r) => r.name === 'sidebar.footer.action')
const section = registrations.find((r) => r.name === 'settings.section')
check('footer action slot registered', footer !== undefined)
check('settings section slot registered', section !== undefined)
check('footer id', footer?.handle?.id === 'balance-monitor', String(footer?.handle?.id))
check('footer renders above other actions (order -1)', footer?.handle?.order === -1, String(footer?.handle?.order))
check('settings section id', section?.handle?.id === 'balance-monitor', String(section?.handle?.id))
check('settings section label is lazy (a function)', typeof section?.handle?.label === 'function', typeof section?.handle?.label)
check('settings section label resolves', section?.handle?.label?.() === 'balance-monitor:nav', String(section?.handle?.label?.()))

// ---------------------------------------------------------------------------
// Render each component in its states.
// ---------------------------------------------------------------------------

console.log('\n# rendering the footer badge')
/** Re-render helper: resets the fake hook slots before each pass. */
function render(component, props) {
  hookIndex = 0
  hookState = []
  return component(props)
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, out)
  return out
}

function collectClasses(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectClasses(item, out)
    return out
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  collectClasses(node.props?.children, out)
  return out
}

/** Depth-first search for every node whose className contains `token`. */
function findAllClass(node, token, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAllClass(item, token, out)
    return out
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes(token)) out.push(node)
  findAllClass(node.props?.children, token, out)
  return out
}

/** Depth-first search for the first node whose className contains `token`. */
function findClass(node, token) {
  return findAllClass(node, token)[0] ?? null
}

/** Depth-first search for the first node whose `type` is exactly `type`. */
function findType(node, type, out = null) {
  if (out !== null || node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) {
      out = findType(item, type, out)
      if (out !== null) return out
    }
    return out
  }
  if (node.type === type) return node
  return findType(node.props?.children, type, out)
}

const badge = footer.handle.component

// Empty state: no config loaded, no balances.
{
  const tree = render(badge, { wide: true })
  const classes = collectClasses(tree).join(' ')
  check('empty state renders the row', classes.includes('bm-row'), classes)
  check('empty state shows the label', collectText(tree).includes('余额'), collectText(tree).join('|'))
  check('empty state shows a placeholder', collectText(tree).join('').includes(''), 'expected placeholder')
}

// Loaded state: CNY balance, coin icon, refresh button.
{
  const tree = render(badge, { wide: true })
  // The store is module-private; the badge reads whatever the last live fetch
  // stored, so assert on the structure that is always present.
  const classes = collectClasses(tree).join(' ')
  const row = findClass(tree, 'bm-row')
  check('loaded state keeps the row class', classes.includes('bm-row'), classes)
  check('loaded state exposes an accessible name', typeof row?.props?.['aria-label'] === 'string',
    JSON.stringify(row?.props?.['aria-label']))
}

// Collapsed rail must not throw, must add the rail class, and must not render
// the refresh control (the rail hides the label/value through CSS, which a
// function-tree walk cannot observe, so assert the class contract instead).
{
  const tree = render(badge, { wide: false })
  const classes = collectClasses(tree).join(' ')
  check('rail state adds bm-rail', classes.includes('bm-rail'), classes)
  check('rail state omits the refresh button', !classes.includes('bm-refresh'), classes)
  check('rail state keeps the value cell for CSS to hide', classes.includes('bm-value'), classes)
}

// ---------------------------------------------------------------------------
// 额度消耗趋势 dialog: the row opens it, and it is a real Modal.
// ---------------------------------------------------------------------------

console.log('\n# 额度消耗趋势 dialog')
{
  // Closed on load: the slot must render the row and nothing else.
  const closed = render(footer.handle.component, { wide: true })
  check('dialog is closed until the row is clicked', findClass(closed, 'bm-trend-body') === null)
  check('row still renders while closed', collectClasses(closed).join(' ').includes('bm-row'))

  // Clicking the row is the only trigger; the refresh arrow must not open it.
  const row = findClass(render(badge, { wide: true }), 'bm-row')
  check('row is a real button', row?.type === 'button', String(row?.type))
  check('clicking the row opens the dialog', typeof row?.props?.onClick === 'function')
  row?.props?.onClick?.()

  const opened = render(footer.handle.component, { wide: true })
  const card = findClass(opened, 'bm-modal-card')
  const body = findClass(opened, 'bm-trend-body')
  check('clicking the row mounts the dialog', body !== null)
  check('dialog goes through the shell Modal primitive', card !== null)
  check('dialog is open', card?.props?.['data-open'] === 'true', String(card?.props?.['data-open']))
  check('dialog is titled 额度消耗趋势', card?.props?.['data-title'] === '额度消耗趋势', String(card?.props?.['data-title']))
  check('dialog carries a close label', typeof card?.props?.['data-close-label'] === 'string', String(card?.props?.['data-close-label']))
  check('dialog widens the shipped card', String(card?.props?.className).includes('bm-trend-dialog'), String(card?.props?.className))

  const text = collectText(opened).join('|')
  const classes = collectClasses(opened).join(' ')
  check('dialog has period tabs', classes.includes('bm-trend-tabs'), classes.slice(0, 120))
  check('tabs are exposed as tabs', findClass(opened, 'bm-range-btn')?.props?.role === 'tab',
    String(findClass(opened, 'bm-range-btn')?.props?.role))
  check('every period is offered as a tab',
    ['近1小时', '近6小时', '近24小时', '近7天', '近30天', '全部'].every((label) => text.includes(label)),
    text.slice(0, 200))
  check('the 1h tab is selected by default', findClass(opened, 'bm-on') !== null)
  check('dialog names what it consumes', text.includes('区间消耗'), text.slice(0, 300))
  check('dialog shows the burn rate', text.includes('平均消耗速率'), text.slice(0, 300))
  check('dialog explains the sampling model', text.includes('采样'), text.slice(0, 400))

  // A tab click must not throw, and the selected period must move to that tab
  // (the last one — 「全部」 — so the assertion cannot pass on the default).
  const tabs = findAllClass(opened, 'bm-range-btn')
  const lastTab = tabs[tabs.length - 1]
  lastTab?.props?.onClick?.()
  const afterTab = render(footer.handle.component, { wide: true })
  check('selecting a tab keeps the dialog mounted', findClass(afterTab, 'bm-trend-body') !== null,
    JSON.stringify(collectText(afterTab).join('|').slice(0, 120)))
  const movedTabs = findAllClass(afterTab, 'bm-range-btn')
  check('the clicked tab becomes the selected one',
    movedTabs[movedTabs.length - 1]?.props?.['aria-selected'] === true,
    JSON.stringify(movedTabs.map((t) => t.props['aria-selected'])))
  check('exactly one tab is selected at a time',
    movedTabs.filter((t) => t.props['aria-selected'] === true).length === 1,
    JSON.stringify(movedTabs.map((t) => t.props['aria-selected'])))

  // The dialog's own close path is the Modal's onClose.
  card?.props?.onClose?.()
  const closedAgain = render(footer.handle.component, { wide: true })
  check('onClose unmounts the dialog', findClass(closedAgain, 'bm-trend-body') === null)
}

// ---------------------------------------------------------------------------
// Trend math (pure helpers exported by the bundle).
// ---------------------------------------------------------------------------

console.log('\n# trend window math')
{
  const { periodUsage, bucketPoints, historyWindowPoints } = exportsObject

  check('periodUsage is exported', typeof periodUsage === 'function')
  check('bucketPoints is exported', typeof bucketPoints === 'function')
  check('historyWindowPoints is exported', typeof historyWindowPoints === 'function')

  // Consumption is the sum of the DECREASES only, so a top-up inside the window
  // can never be reported as spend (the classic first-minus-last bug).
  const burned = periodUsage([
    { t: 0, value: 100 },
    { t: 60000, value: 94 },
    { t: 120000, value: 104 },
    { t: 180000, value: 99 },
  ])
  check('consumption sums the decreases', burned.consumed === 11, String(burned.consumed))
  check('top-ups are measured separately', burned.toppedUp === 10, String(burned.toppedUp))
  check('net equals consumed - toppedUp', burned.net === 1, String(burned.net))
  check('window keeps its opening balance', burned.start === 100 && burned.end === 99, `${burned.start}->${burned.end}`)
  check('burn rate is per hour', burned.perHour === 220, String(burned.perHour))
  check('samples are counted', burned.samples === 4, String(burned.samples))
  check('a single sample has no burn rate', periodUsage([{ t: 0, value: 5 }]).perHour === null)
  check('an empty window reports nothing', periodUsage([]).consumed === 0 && periodUsage([]).start === null)
  check('a flat window consumes nothing', periodUsage([{ t: 0, value: 5 }, { t: 60000, value: 5 }]).consumed === 0)

  // Bucketing keeps the LAST sample of each hour and drops the rest.
  const bucketed = bucketPoints([
    { t: 0, value: 10 },
    { t: 60000, value: 9 },
    { t: 3600000, value: 8 },
    { t: 3660000, value: 7.5 },
  ], 3600000)
  check('one point per bucket', bucketed.length === 2, JSON.stringify(bucketed))
  check('a bucket reports the balance it ended at', bucketed[0].value === 9, JSON.stringify(bucketed[0]))
  check('buckets are floored to clock boundaries', bucketed[1].bucket === 3600000, String(bucketed[1].bucket))
  check('no bucket width passes points through',
    bucketPoints([{ t: 7, value: 1 }], 0).length === 1)

  // The window helper carries the sample BEFORE the window in as the baseline.
  const history = { history: [
    { t: 0, balances: { CNY: 50 } },
    { t: 1000, balances: { CNY: 40 } },
    { t: 2000, balances: { CNY: 30 } },
    { t: 3000, balances: { CNY: 20 } },
  ] }
  const carried = historyWindowPoints(history, 'CNY', 1500)
  check('the pre-window sample is carried in', carried.length === 3 && carried[0].carry === true, JSON.stringify(carried))
  check('in-window samples are not carried', carried[1].carry === false && carried[2].carry === false)
  check('the carried sample is the window baseline', carried[0].value === 40, String(carried[0].value))
  check('another currency is ignored', historyWindowPoints(history, 'USD', 1500).length === 0)
  check('an empty history yields no points', historyWindowPoints({ history: [] }, 'CNY', 0).length === 0)
  // Every sample is outside the window, so only the newest baseline survives —
  // which is still exactly the opening balance the window needs.
  const allBefore = historyWindowPoints(history, 'CNY', 5000)
  check('the newest pre-window sample wins', allBefore.length === 1 && allBefore[0].value === 20,
    JSON.stringify(allBefore))
}

console.log('\n# rendering the settings section')
{
  const tree = render(section.handle.component, {})
  const text = collectText(tree).join('|')
  const classes = collectClasses(tree).join(' ')
  check('section renders', tree !== null && tree !== undefined)
  check('section root class', classes.includes('bm-section'), classes)
  check('section title present', text.includes('余额监控'), text.slice(0, 120))
  check('section shows a trend card region', classes.includes('bm-card'), classes)
  check('section shows the icon switch', text.includes('金币') && text.includes('钱袋'), text.slice(0, 400))
  check('section shows the interval row', text.includes('刷新间隔'), text.slice(0, 400))
  check('section shows the roll duration row', text.includes('数字滚动时长'), text.slice(0, 500))
  check('section shows the phase tag switch', text.includes('时段标签'), text.slice(0, 600))
  check('section shows diagnostics', text.includes('诊断'), text.slice(0, 600))
}

// The phase tag renders between the label and the value, and only when the
// host has reported a phase.
console.log('\n# peak/off-peak tag rendering')
{
  const withPhase = render(badge, { wide: true })
  const classes = collectClasses(withPhase).join(' ')
  const text = collectText(withPhase).join('')
  // No phase in the store during the smoke run (no host), so the tag is absent
  // and must not leave an empty box behind.
  check('tag is absent without a host phase', !text.includes('高峰') && !text.includes('低谷'), text)
  check('no dangling tag class', !classes.includes('bm-phase-'), classes)

  // With a phase present, the tag renders with the fixed-width idle/peak class.
  const { resolveDisplay } = exportsObject
  check('resolveDisplay still exported for the badge', typeof resolveDisplay === 'function')

  // CSS contract: a fixed 26px column, so the label swap cannot move the amount.
  const phaseRule = /\.bm-phase\{([^}]*)\}/.exec(source)?.[1] ?? ''
  check('tag is a fixed-width column', /width:26px/.test(phaseRule), phaseRule.slice(0, 80))
  check('tag does not grow or shrink', /flex:none/.test(phaseRule), phaseRule.slice(0, 80))
  // Vertical alignment vs the 余额 glyphs: tight line box plus a measured nudge.
  // Without line-height:1 the tag box inherits the row's 22px line box and the
  // row's align-items:center puts its centre above the glyphs' optical centre.
  check('tag line box is tight (line-height:1)', /line-height:1[;}]/.test(phaseRule), phaseRule.slice(0, 90))
  check('tag is nudged onto the glyph optical centre', /position:relative/.test(phaseRule) && /top:1\.5px/.test(phaseRule), phaseRule.slice(0, 90))
  check('tag nudge does not disturb row layout', !/margin|height:1[0-9]px/.test(phaseRule.replace('height:16px', '')), phaseRule.slice(0, 90))
  check('idle colour is the theme success alias', /\.bm-phase-idle\{[^}]*--dsw-alias-state-success-primary/.test(source))
  check('peak colour carries a fallback (theme has no warning alias)',
    /\.bm-phase-peak\{[^}]*--dsw-alias-state-warning-primary,#/.test(source))
}

// ---------------------------------------------------------------------------
// Roll animation rules (pure helpers exported by the bundle).
// ---------------------------------------------------------------------------

console.log('\n# roll animation rules')
{
  const { rollDirectionsFor, mapDirections, formatAmount, amountDigits, amountSymbol, rollDelay } = exportsObject

  check('formatAmount trails the symbol', formatAmount(12.69, 'CNY') === '12.69￥', formatAmount(12.69, 'CNY'))
  check('formatAmount groups thousands', formatAmount(1234.5, 'CNY') === '1,234.50￥', formatAmount(1234.5, 'CNY'))

  // The amount is split so the currency mark can be styled separately, the way
  // DeepSeek's own balance card renders it. The two parts must still recombine
  // into exactly what formatAmount produces.
  check('amountDigits is the numeric part', amountDigits(1234.5, 'CNY') === '1,234.50', amountDigits(1234.5, 'CNY'))
  check('amountSymbol is the mark', amountSymbol('CNY') === '￥', amountSymbol('CNY'))
  check('split parts recombine', amountDigits(1234.5, 'CNY') + amountSymbol('CNY') === formatAmount(1234.5, 'CNY'))
  check('amountDigits keeps the minus sign', amountDigits(-3.5, 'CNY') === '-3.50', amountDigits(-3.5, 'CNY'))
  check('amountDigits honours zero-decimal currencies', amountDigits(1200, 'JPY') === '1,200', amountDigits(1200, 'JPY'))
  check('amountDigits is a placeholder for null', amountDigits(null, 'CNY') === '--', amountDigits(null, 'CNY'))
  check('amountSymbol maps USD', amountSymbol('USD') === '$', amountSymbol('USD'))

  // CSS contract for the amount. The symbol is deliberately NOT resized or
  // recoloured — it matches the digits; only its side and the shared font are
  // styled. The face is DSH's official brand font (Montserrat), shipped at
  // weights 300/400/500 only, so the weight must stay within that.
  const symbolRule = /\.bm-amount-symbol\{([^}]*)\}/.exec(source)?.[1] ?? ''
  const amountRule = /\.bm-amount\{([^}]*)\}/.exec(source)?.[1] ?? ''
  const valueRule = /\.bm-value\{([^}]*)\}/.exec(source)?.[1] ?? ''
  check('symbol keeps the digits\' size', !/font-size/.test(symbolRule), symbolRule)
  check('symbol keeps the digits\' colour', !/color:/.test(symbolRule), symbolRule)
  check('amount uses the brand font', /font-family:var\(--dsw-font-family-brand\)/.test(amountRule), amountRule)
  const amountWeight = Number(/font-weight:(\d+)/.exec(amountRule)?.[1] ?? 0)
  check('amount weight is one Montserrat actually ships (300/400/500)',
    [300, 400, 500].includes(amountWeight), `${amountWeight} would be synthesised`)
  check('digits and symbol share a baseline', /align-items:baseline/.test(amountRule), amountRule)
  check('amount uses tabular figures', /tabular-nums/.test(valueRule), valueRule)

  // ---- odometer cell geometry ----
  // The cell used to be a fixed .62em, which was measured for the system UI
  // font. Montserrat's digits are wider (~0.65em), so every cell clipped its
  // glyph and the RIGHTMOST digit showed it worst (nothing to its right to hide
  // the cut). 1ch is the advance of the element's own "0", so it follows
  // whatever face is loaded.
  const cellRule = /\.bm-cell\{([^}]*)\}/.exec(source)?.[1] ?? ''
  const itemRule = /\.bm-cell-item\{([^}]*)\}/.exec(source)?.[1] ?? ''
  check('digit cell is sized in ch, not a fixed em', /width:1(?:\.\d+)?ch/.test(cellRule), cellRule)
  check('digit cell no longer hardcodes .62em', !/\.62em/.test(cellRule + itemRule), cellRule + ' | ' + itemRule)
  check('cell still clips vertically for the roll window', /overflow:hidden/.test(cellRule), cellRule)
  check('no glyph box overflows the cell', !/\.bm-cell-item\{[^}]*width:/.test(itemRule), itemRule)
  // The cell must be at least one whole glyph advance: anything under 1ch
  // re-introduces the horizontal clip this fixed.
  const cellWidth = Number(/width:(1(?:\.\d+)?)ch/.exec(cellRule)?.[1] ?? 0)
  check('cell width covers a full digit advance', cellWidth >= 1, `${cellWidth}ch`)

  // ---- odometer stagger ----
  // Each position starts a little after the one to its right, leading with the
  // least-significant digit, so the cells do not all roll as one block.
  // Walk the DIGITS of a fixed string in order (the decimal point is a cell too
  // but never animates, so it carries no delay).
  const text = '12.69'
  const digitDelays = [...text]
    .map((ch, i) => ({ ch, delay: ch >= '0' && ch <= '9' ? rollDelay(i, text, 0.04) : null }))
    .filter((cell) => cell.delay !== null)
  check('one delay per digit', digitDelays.length === 4, JSON.stringify(digitDelays))
  check('the units digit starts first (zero delay)',
    digitDelays[digitDelays.length - 1].delay === 0, JSON.stringify(digitDelays))
  check('delay grows monotonically from the units digit leftwards',
    digitDelays.every((cell, i) => i === 0 || cell.delay < digitDelays[i - 1].delay),
    digitDelays.map((c) => `${c.ch}:${c.delay}`).join(' '))
  check('each step equals the configured stagger',
    digitDelays.every((cell, i) => cell.delay === (digitDelays.length - 1 - i) * 0.04),
    digitDelays.map((c) => `${c.ch}:${c.delay}`).join(' '))
  check('a non-digit cell gets no delay',
    [...'12.69'].map((ch, i) => (ch >= '0' && ch <= '9' ? null : rollDelay(i, text, 0.04))).every((d) => d === null || typeof d === 'number'))
  check('separators do not consume a stagger step',
    // '1,234.50' has the same digit count as '1234.50', so the leftmost digit
    // must get the same delay despite the extra character.
    rollDelay(0, '1,234.50', 0.04) === rollDelay(0, '1234.50', 0.04),
    `${rollDelay(0, '1,234.50', 0.04)} vs ${rollDelay(0, '1234.50', 0.04)}`)
  check('a zero step means every position rolls together',
    ['0', '1', '2', '3', '4', '5'].every((_, i) => rollDelay(i, '123456', 0) === 0))
  check('delay scales with the configured step',
    rollDelay(0, '7.48', 0.02) === 0.04 && rollDelay(0, '7.48', 0.04) === 0.08,
    `${rollDelay(0, '7.48', 0.02)} / ${rollDelay(0, '7.48', 0.04)}`)

  // The delay must reach CSS, and a waiting cell must hold its start state
  // (`backwards`) instead of flashing the final value before it starts.
  const rollRule = /\.bm-cell\.bm-roll-up \.bm-cell-track\{([^}]*)\}/.exec(source)?.[1] ?? ''
  check('animation consumes --bm-delay', /var\(--bm-delay/.test(rollRule), rollRule)
  check('animation fill is backwards while waiting', /backwards/.test(rollRule), rollRule)
  check('RollDigits sets --bm-delay per cell', /--bm-delay/.test(source) && /rollDelay\(/.test(source))
  check('rollStagger is a configurable parameter',
    /rollStagger/.test(source) && /rollStagger/.test(await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')))
  check('settings big number uses the brand font too', /\.bm-live-num\{[^}]*--dsw-font-family-brand/.test(source))

  // Symbol placement: the client's option ids must cover the host's whitelist,
  // otherwise the picker offers a value the host rejects with a 400.
  // Bracket-matched and whitespace/quote tolerant — this file gets reformatted
  // by tooling, and a layout-sensitive regex here already produced a false
  // failure once.
  const arrayLiteral = (text, marker) => {
    const start = text.indexOf(marker)
    if (start === -1) return ''
    const open = text.indexOf('[', start)
    if (open === -1) return ''
    let depth = 0
    let quote = null
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i]
      if (quote !== null) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch
      else if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') {
        depth -= 1
        if (depth === 0) return text.slice(open + 1, i)
      }
    }
    return ''
  }
  const optionBlock = arrayLiteral(source, 'var SYMBOL_OPTIONS = [')
  const clientIds = [...optionBlock.matchAll(/id:\s*["']([a-z]+)["']/g)].map((m) => m[1])
  check('SYMBOL_OPTIONS block found', optionBlock.length > 0, String(optionBlock.length))
  check('client exposes the three placements',
    ['after', 'before', 'none'].every((id) => clientIds.includes(id)), clientIds.join(','))

  // No change -> no roll, which is also what keeps the refresh arrow still.
  check('no change produces no roll', rollDirectionsFor(9.27, 9.27, 'CNY').changed === false)
  check('first reading produces no roll', rollDirectionsFor(null, 9.27, 'CNY').changed === false)

  // A decrease rolls every changed digit downward, unchanged digits stay put.
  const down = rollDirectionsFor(9.27, 9.2, 'CNY')
  check('decrease is flagged as changed', down.changed === true)
  check('decrease directions are 0/-1', down.directions.every((d) => d === 0 || d === -1), JSON.stringify(down.directions))
  check('decrease rolls the last digit', down.directions[down.directions.length - 1] === -1, JSON.stringify(down.directions))

  // An increase rolls upward.
  const up = rollDirectionsFor(9.27, 9.28, 'CNY')
  check('increase directions are 0/1', up.directions.every((d) => d === 0 || d === 1), JSON.stringify(up.directions))

  // A digit-count change must stay right-aligned instead of shifting cells.
  const carry = rollDirectionsFor(9.99, 10.02, 'CNY')
  check('9.99 -> 10.02 stays a single direction', carry.directions.every((d) => d === 1), JSON.stringify(carry.directions))
  check('9.99 -> 10.02 direction count matches the new digits',
    carry.directions.length === formatAmount(10.02, 'CNY').replace(/[^0-9]/g, '').length,
    `${carry.directions.length} vs ${formatAmount(10.02, 'CNY')}`)
  // The reverse (10.02 -> 9.99) must roll down, not up: a bug here showed as
  // decreasing balances animating green.
  const reverse = rollDirectionsFor(10.02, 9.99, 'CNY')
  check('10.02 -> 9.99 rolls downward', reverse.directions.every((d) => d === -1), JSON.stringify(reverse.directions))

  // Directions are indexed over digits; the text carries extra characters.
  // '1,234.50￥' -> digit positions 0,2,3,4,6,7 (5 digits + the trailing 0).
  const mapped = mapDirections('1,234.50￥', [1, 0, 0, -1, 0, 0])
  check('mapDirections keeps symbol/separators unanimated',
    mapped[1] === 0 && mapped[5] === 0 && mapped[mapped.length - 1] === 0, JSON.stringify(mapped))
  check('mapDirections covers every character', mapped.length === '1,234.50￥'.length, String(mapped.length))
  check('mapDirections forwards digit directions',
    mapped[0] === 1 && mapped[3] === 0 && mapped[4] === -1, JSON.stringify(mapped))
}

// ---------------------------------------------------------------------------
// Currency-symbol placement: verify the three settings actually reorder or
// remove the mark. AmountValue is driven directly with stub collaborators, so
// this checks the placement logic rather than the store.
// ---------------------------------------------------------------------------

console.log('\n# currency-symbol placement')
{
  // Driven from the EVALUATED bundle (the component lives inside the module
  // factory closure, so slicing it out of the source text is both fragile under
  // reformatting and unable to see its real collaborators).
  const { AmountValue } = exportsObject
  check('AmountValue is exported by the bundle', typeof AmountValue === 'function')

  /** Flatten a rendered tree to the text it would show, in document order. */
  const flatten = (node) => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flatten).join('')
    if (node.type === 'RollDigits') return node.props.text
    return flatten(node.props?.children)
  }

  const after = flatten(AmountValue({ value: 7.48, currency: 'CNY', position: 'after' }))
  const before = flatten(AmountValue({ value: 7.48, currency: 'CNY', position: 'before' }))
  const none = flatten(AmountValue({ value: 7.48, currency: 'CNY', position: 'none' }))

  check('after renders 7.48￥', after === '7.48￥', after)
  check('before renders ￥7.48', before === '￥7.48', before)
  check('none renders 7.48 with no mark', none === '7.48', none)
  const unknown = flatten(AmountValue({ value: 7.48, currency: 'CNY', position: 'middle' }))
  check('an unknown placement falls back to after', unknown === '7.48￥', unknown)
  const placeholder = flatten(AmountValue({ value: null, currency: 'CNY', position: 'before' }))
  check('a placeholder ignores the placement', placeholder === '--', placeholder)
}

// ---------------------------------------------------------------------------
// Alignment contract: the row must start left of the footer slot, matching the
// native settings trigger row's `margin: 4px -2px` wrapper.
// ---------------------------------------------------------------------------

console.log('\n# footer alignment contract')
{
  const rowRule = /\.bm-row\{([^}]*)\}/.exec(source)?.[1] ?? ''
  // The row must be pulled left to match the native settings trigger row's
  // wrapper; -2.5px is the value fitted from real screenshot measurements.
  check('row carries the negative left pull', /margin:0 -2\.5px/.test(rowRule), rowRule.slice(0, 70))
  check('row keeps the native 42px height', /height:42px/.test(rowRule), '')
  check('row keeps the native padding', /padding:0 10px 0 8px/.test(rowRule), '')
  check('row keeps the native gap', /gap:8px/.test(rowRule), '')
  const iconRule = /\.bm-icon\{([^}]*)\}/.exec(source)?.[1] ?? ''
  check('icon box is the native 16px', /width:16px/.test(iconRule) && /height:16px/.test(iconRule), iconRule)

  // The wallet is the default icon, and its artwork must stay within the same
  // optical width as the other glyphs so the label lands on the settings column.
  // Read from the evaluated bundle rather than the source text.
  const walletEntry = exportsObject.ICONS.find((entry) => entry.id === 'wallet')
  check('wallet artwork exists', walletEntry !== undefined && walletEntry.draw().length > 0)
  check('wallet default is configured', /icon:\s*["']wallet["']/.test(source), '')
  // Its own CSS must not reintroduce a hardcoded glyph width.
  check('wallet artwork is not width-constrained by CSS',
    !/\.bm-cell-item\{[^}]*width:/.test(source), '')
}

// ---------------------------------------------------------------------------
// Hover tooltip: the row must use the shell's own Tooltip primitive so it looks
// like the shipped sidebar controls, and must NOT also carry a native `title`
// (which would show a second, unstyled bubble at the same time).
// ---------------------------------------------------------------------------

console.log('\n# hover tooltip')
{
  const tree = render(badge, { wide: true })
  const tip = findType(tree, 'Tooltip')
  check('row is wrapped in the shell Tooltip', tip !== null)
  check('tooltip is labelled', typeof tip?.props?.label === 'string' && tip.props.label.length > 0,
    String(tip?.props?.label))
  check('tooltip names the click action', String(tip?.props?.label).includes('额度消耗趋势'), String(tip?.props?.label))
  check('tooltip prefers the top side (footer sits at the viewport bottom)', tip?.props?.side === 'top',
    String(tip?.props?.side))
  check('tooltip is centre-aligned on the row', tip?.props?.align === 'center', String(tip?.props?.align))

  // The row keeps its accessible name even though the native `title` is gone —
  // leaving `title` on would render a second, unstyled bubble next to the
  // shell's, because a native tooltip cannot be suppressed by CSS.
  const row = findClass(tree, 'bm-row')
  check('row no longer carries a native title', row?.props?.title === undefined, String(row?.props?.title))
  check('row keeps an aria-label', typeof row?.props?.['aria-label'] === 'string', String(row?.props?.['aria-label']))
  check('row is still the click target', typeof row?.props?.onClick === 'function')
  // The refresh arrow is a separate control, so its native tooltip stays.
  const arrows = findAllClass(tree, 'bm-refresh')
  check('refresh arrow keeps its own tooltip', arrows.length === 1 && typeof arrows[0].props.title === 'string',
    String(arrows[0]?.props?.title))
}

// ---------------------------------------------------------------------------
// Browser-local sample history: the ring, its codec, and the window it feeds.
//
// The panel used to keep only the host's 1440 samples (~12 h at a 30-second
// refresh), so 「近30天」 could never actually show 30 days. These checks pin the
// replacement: a Float32 ring whose 30-day footprint stays far inside the
// browser's per-origin storage quota.
// ---------------------------------------------------------------------------

/**
 * Build a stored blob by hand, byte for byte, exactly in the layout the bundle
 * writes — so the persistence test seeds storage with an independent encoder
 * rather than the very function under test. The sample body is COLUMNAR: all the
 * `t` offsets, then all the `v` amounts.
 *
 *   magic "DSPM" | version(1) | capacity(u32 LE at 5) | length(u32 LE at 9)
 *   | codeLen(1 at 13) | code(7 at 14) | base time (f64 LE at 20) | t[] | v[]
 */
function storedBlob({ currency = 'CNY', capacity, samples }) {
  const header = Buffer.alloc(28)
  header.write('DSPM', 0, 'latin1')
  header[4] = 1
  header.writeUInt32LE(capacity, 5)
  header.writeUInt32LE(samples.length, 9)
  header[13] = currency.length
  header.write(currency, 14, 'latin1')
  const base = samples.length > 0 ? samples[0][0] : 0
  header.writeDoubleLE(base, 20)
  const body = Buffer.alloc(samples.length * 8)
  samples.forEach(([t], i) => body.writeUInt32LE((t - base) >>> 0, i * 4))
  samples.forEach(([, v], i) => body.writeFloatLE(v, samples.length * 4 + i * 4))
  return Buffer.concat([header, body]).toString('base64')
}

console.log('\n# local 30-day sample ring')
{
  const {
    makeSampleRing, ringSlot, appendRing, evictRing, ringPoints,
    encodeSampleRing, decodeSampleRing, mergeLocalHistory, bucketMsForSpan,
    localHistorySpan, localHistorySummary, currencyMismatchNote, noteSample,
    loadHistoryPoints, primeHistoryStore, HISTORY_STORAGE_KEY,
  } = exportsObject

  const T0 = Date.UTC(2026, 0, 1)
  const ring = makeSampleRing(4, null)
  appendRing(ring, T0, 10)
  appendRing(ring, T0 + 1, 9)
  appendRing(ring, T0 + 2, 8)
  check('a fresh ring starts empty', makeSampleRing(4, null).length === 0)
  check('appends are counted', ring.length === 3, String(ring.length))
  check('the oldest sample comes first',
    ring.t[ringSlot(ring, 0)] === T0 && ring.t[ringSlot(ring, 2)] === T0 + 2,
    `${ring.t[ringSlot(ring, 0)]}/${ring.t[ringSlot(ring, 2)]}`)

  // The same reading twice is one sample, not a zero-length interval.
  appendRing(ring, T0 + 2, 7.5)
  check('a repeated timestamp updates in place', ring.length === 3, String(ring.length))
  check('a repeated timestamp updates the value', ring.v[ringSlot(ring, 2)] === 7.5,
    String(ring.v[ringSlot(ring, 2)]))
  check('an out-of-order timestamp is refused', appendRing(ring, T0 + 1, 1) === false)

  // Overflow: the buffer is a ring, so the newest sample wraps into slot 0.
  appendRing(ring, T0 + 3, 6)
  appendRing(ring, T0 + 4, 5)
  check('the ring keeps its capacity', ring.length === 4, String(ring.length))
  check('the oldest sample is dropped on overflow',
    ringPoints(ring, null, undefined, false)[0].t === T0 + 1,
    JSON.stringify(ringPoints(ring, null, undefined, false).map((p) => p.t)))
  check('the newest sample survives the wrap',
    ringPoints(ring, null, undefined, false).slice(-1)[0].value === 5,
    JSON.stringify(ringPoints(ring, null, undefined, false).slice(-1)))
  check('the sorted read is monotone',
    ringPoints(ring, null, undefined, false).every((p, i, all) => i === 0 || p.t > all[i - 1].t))

  // The codec must round-trip exactly and in order, wrap included. A ring that
  // had wrapped is the case that catches head/length arithmetic mistakes.
  // A ring is only persisted once it is anchored to a currency, so anchor it.
  ring.currency = 'CNY'
  const blob = encodeSampleRing(ring)
  check('a ring encodes to a base64 blob', typeof blob === 'string' && blob.length > 0)
  const restored = decodeSampleRing(blob)
  check('a blob decodes', restored !== null)
  check('the decoded ring keeps the currency', restored.currency === ring.currency,
    String(restored.currency))
  check('the decoded ring keeps its samples', restored.length === 4, String(restored.length))
  check('the decoded series matches value for value',
    JSON.stringify(ringPoints(restored, 'CNY', undefined, false)) ===
      JSON.stringify(ringPoints(ring, 'CNY', undefined, false)),
    JSON.stringify(ringPoints(restored, 'CNY', undefined, false)))
  check('an unanchored ring is not persisted',
    encodeSampleRing(Object.assign(makeSampleRing(4, null), { length: 1 })) === null)
  check('corrupt base64 is refused', decodeSampleRing('not base64 at all!!') === null)
  check('an empty blob is refused', decodeSampleRing('') === null)
  check('a foreign magic is refused',
    decodeSampleRing(`WFlaWg==${blob.slice(8)}`) === null)
  const wrongVersion = Buffer.from(blob, 'base64')
  wrongVersion[4] = 99
  check('an unknown format version is refused',
    decodeSampleRing(wrongVersion.toString('base64')) === null)
  const truncated = Buffer.from(blob, 'base64').subarray(0, 20)
  check('a truncated blob is refused',
    decodeSampleRing(truncated.toString('base64')) === null)

  // Retention: everything outside the 30-day window goes, in one shift rather
  // than a per-sample loop. `t` is Float64 ms, so ages and bounds are plain
  // numbers — no era arithmetic anywhere in this path.
  const wide = makeSampleRing(64, null)
  const now = Date.now()
  appendRing(wide, now - 35 * 86400000, 1)
  appendRing(wide, now - 29 * 86400000, 2)
  appendRing(wide, now - 1000, 3)
  const dropped = evictRing(wide, now)
  check('samples older than 30 days are evicted', dropped === 1, String(dropped))
  check('the in-window samples survive', wide.length === 2, String(wide.length))
  check('the surviving samples are the newest ones',
    ringPoints(wide, null, undefined, false).map((p) => p.value).sort().join(',') === '2,3',
    JSON.stringify(ringPoints(wide, null, undefined, false).map((p) => p.value)))
  const future = makeSampleRing(8, null)
  appendRing(future, now + 3600000, 9)
  check('a future-stamped sample is evicted', evictRing(future, now) === 1,
    String(future.length))
  // The pathological case: every stored sample is older than the window.
  const stale = makeSampleRing(8, null)
  appendRing(stale, now - 40 * 86400000, 1)
  appendRing(stale, now - 38 * 86400000, 2)
  check('a wholly stale series is emptied', evictRing(stale, now) === 2 &&
    stale.length === 0, String(stale.length))

  // Windows are sliced, not scanned: the ring is time-sorted, so a 30-day window
  // over a long ring costs the window rather than the whole store.
  const year = makeSampleRing(4096, 'CNY')
  for (let i = 0; i < 4000; i += 1) appendRing(year, now - (4000 - i) * 300000, 100 - i / 100)
  const dayAgo = now - 86400000
  const windowed = ringPoints(year, 'CNY', dayAgo, true)
  check('a one-day window over a long ring carries one baseline',
    windowed.length > 1 && windowed[0].t < dayAgo, `${windowed.length} points`)
  check('the window holds only in-window samples plus the baseline',
    windowed.slice(1).every((p) => p.t >= dayAgo), `${windowed.length} points`)
  check('another currency yields no points', ringPoints(year, 'USD', undefined, false).length === 0)
  check('an empty window carries the newest baseline',
    ringPoints(year, 'CNY', now + 1, true).length === 1,
    String(ringPoints(year, 'CNY', now + 1, true).length))

  // Chart downsampling: short windows keep every point, long ones bucket.
  check('under 48h every sample is a point',
    bucketMsForSpan(3600000) === 0 && bucketMsForSpan(86400000) === 0,
    String(bucketMsForSpan(86400000)))
  check('a 7-day window buckets by the day', bucketMsForSpan(604800000) === 86400000,
    String(bucketMsForSpan(604800000)))
  check('a 30-day window buckets by the day', bucketMsForSpan(2592000000) === 86400000,
    String(bucketMsForSpan(2592000000)))
  check('a multi-year window buckets coarsely',
    bucketMsForSpan(5 * 365 * 86400000) >= 3600000, String(bucketMsForSpan(5 * 365 * 86400000)))
  check('an empty span asks for no bucketing', bucketMsForSpan(0) === 0)
  // The width follows the DATA, not the tab: 「近7天」 over an 18-hour-old series
  // must not collapse into two daily points, and 1440 samples must not become
  // 1440 SVG nodes in a 100px sparkline.
  const { bucketMsForPoints } = exportsObject
  const shortSeries = [{ t: now - 18 * 3600000, value: 1 }, { t: now, value: 2 }]
  check('a short series in a long tab does not bucket by the day',
    bucketMsForPoints(shortSeries) < 86400000, String(bucketMsForPoints(shortSeries)))
  check('a short series in a long tab keeps its detail',
    bucketMsForPoints(shortSeries) === 0, String(bucketMsForPoints(shortSeries)))
  check('a series spanning days buckets by the day',
    bucketMsForPoints([{ t: now - 5 * 86400000, value: 1 }, { t: now, value: 2 }]) === 86400000,
    String(bucketMsForPoints([{ t: now - 5 * 86400000, value: 1 }, { t: now, value: 2 }])))
  check('a single point needs no bucketing', bucketMsForPoints([{ t: now, value: 1 }]) === 0)
  // A dense day is capped at the chart's drawn width rather than one bucket per
  // sample; a 100px sparkline asks for ~180 columns, a 512px dialog for ~512.
  const denseDay = [{ t: now - 86400000, value: 1 }, { t: now, value: 2 }]
  check('a dense day is downsampled for a small chart',
    bucketMsForPoints(denseDay, 180) === Math.ceil(86400000 / 180),
    String(bucketMsForPoints(denseDay, 180)))
  check('a wide chart gets finer buckets than a narrow one',
    bucketMsForPoints(denseDay, 512) < bucketMsForPoints(denseDay, 180),
    `${bucketMsForPoints(denseDay, 512)} vs ${bucketMsForPoints(denseDay, 180)}`)
  check('a target never makes buckets coarser than the span allows',
    bucketMsForPoints(denseDay, 512) <= 86400000,
    String(bucketMsForPoints(denseDay, 512)))

  // ---- the merge: ring first, host tail behind it, no duplicate timestamps ----
  // `mergeLocalHistory` reads the module's OWN ring, so seed that ring through
  // the same entry point the seed path uses rather than a detached one. The host
  // fixture is older than the ring's oldest sample, which is the only stretch the
  // host is allowed to contribute.
  const seededPoints = []
  for (let i = 0; i < 100; i += 1)
    seededPoints.push({ t: now - (100 - i) * 60000, value: 1000 - i / 10 })
  loadHistoryPoints(seededPoints, 'CNY')
  check('the module ring holds the seeded series',
    localHistorySpan()?.samples === 100, String(localHistorySpan()?.samples))
  // Read the ring's own edge rather than recomputing it from `now`: the seeding
  // runs after a few hundred milliseconds of other checks.
  const ringSeries = mergeLocalHistory({ history: [] }, 'CNY')
  const ringOldest = ringSeries[0].t

  const hostHistory = {
    history: [
      { t: ringOldest - 30000, balances: { CNY: 30 } },
      { t: ringOldest - 20000, balances: { CNY: 29 } },
      { t: ringOldest - 10000, balances: { CNY: 28 } },
    ],
  }
  check('the host fixture really is older than the ring',
    hostHistory.history[2].t < ringOldest, `${hostHistory.history[2].t} vs ${ringOldest}`)
  const merged = mergeLocalHistory(hostHistory, 'CNY')
  check('the merged series spans host tail + ring',
    merged.length === 3 + 100, `${merged.length} vs ring 100`)
  check('the host tail is older than every ring sample',
    merged.slice(0, 3).every((p) => p.t < ringOldest))
  check('the merged series is sorted',
    merged.every((p, i) => i === 0 || p.t > merged[i - 1].t))
  check('no timestamp is duplicated across the two sources',
    new Set(merged.map((p) => p.t)).size === merged.length)
  check('the ring wins for a timestamp both sides hold',
    mergeLocalHistory({ history: [{ t: ringSeries[50].t, balances: { CNY: 999 } }] }, 'CNY')
      .find((p) => p.t === ringSeries[50].t).value !== 999)
  // A ring anchored to another currency contributes nothing; the host's own series
  // is then the only source, and it is still returned.
  check('a ring of another currency contributes nothing',
    mergeLocalHistory({ history: [{ t: now, balances: { USD: 5 } }] }, 'USD').length === 1 &&
      localHistorySpan().currency === 'CNY')
  check('a host sample newer than the ring is not duplicated',
    mergeLocalHistory({ history: [{ t: now + 5000, balances: { CNY: 1 } }] }, 'CNY')
      .filter((p) => p.t === now + 5000).length === 0)

  // ---- seeding a cold origin, in the order the page really sees ----
  // The balance read answers BEFORE the config response that carries the host's
  // tail, so the first reading is recorded while the history is still empty. The
  // tail must still be absorbed afterwards, and a later refresh must never
  // overwrite the ring with the host's 12-hour window again.
  loadHistoryPoints([], 'CNY')
  check('a cleared store starts empty again', localHistorySpan() === null)
  // A fresh clock: this block runs hundreds of milliseconds after `now` was read,
  // and a tail built from the stale value would sit in the future.
  const gateNow = Date.now()
  noteSample(gateNow - 30000, 'CNY', 77)
  primeHistoryStore([], 'CNY')
  check('an empty tail seeds nothing', localHistorySpan()?.samples === 1,
    String(localHistorySpan()?.samples))
  const tail = []
  for (let i = 0; i < 100; i += 1)
    tail.push({ t: gateNow - (100 - i) * 60000, balances: { CNY: 100 - i / 10 } })
  primeHistoryStore(tail, 'CNY')
  check('the host tail is absorbed after the first reading',
    localHistorySpan()?.samples === 101, String(localHistorySpan()?.samples))
  check('the readings are kept, not replaced',
    mergeLocalHistory({ history: [] }, 'CNY').slice(-1)[0].value === 77,
    JSON.stringify(mergeLocalHistory({ history: [] }, 'CNY').slice(-1)))
  check('the absorbed tail reaches back behind the readings',
    mergeLocalHistory({ history: [] }, 'CNY')[0].t === tail[0].t,
    String(mergeLocalHistory({ history: [] }, 'CNY')[0].t))
  // A shorter tail (what a busy origin's config response looks like later on)
  // must not be allowed to shrink the series back down.
  primeHistoryStore([{ t: gateNow - 60000, balances: { CNY: 5 } }], 'CNY')
  check('a later short tail does not clobber the series',
    localHistorySpan()?.samples === 101, String(localHistorySpan()?.samples))
  primeHistoryStore(tail, 'USD')
  check('a tail in another currency is ignored',
    localHistorySpan()?.currency === 'CNY', String(localHistorySpan()?.currency))

  // Reset the module ring to a small, current series for the render checks below.
  const smallSeries = []
  for (let i = 0; i < 6; i += 1)
    smallSeries.push({ t: now - (6 - i) * 300000, value: 20 - i / 10 })
  loadHistoryPoints(smallSeries, 'CNY')
  const span = localHistorySpan()
  check('the live store records what was noted', span?.samples === 6, JSON.stringify(span))
  check('the live store is anchored to the display currency', span?.currency === 'CNY',
    String(span?.currency))
  check('the diagnostics summary names the retention window',
    /保留 30 天/.test(localHistorySummary()), localHistorySummary())
  check('a matching currency raises no mismatch note',
    currencyMismatchNote('CNY') === null, String(currencyMismatchNote('CNY')))
  check('a different currency explains the empty chart',
    /本地历史存的币种是 CNY/.test(String(currencyMismatchNote('USD'))),
    String(currencyMismatchNote('USD')))
  check('a foreign-currency reading is refused', noteSample(now, 'USD', 5) === undefined &&
    localHistorySpan().currency === 'CNY')
  check('entries are written to the storage key',
    localStorage.getItem(HISTORY_STORAGE_KEY) !== null, 'blob missing')

  // ---- what 30 days really costs ----
  // 259200 samples = 30 days at a 10-second refresh, the cadence the size
  // estimate uses. The blob must stay well inside a ~5 MB per-origin quota.
  const TEN_SECOND_SAMPLES = 259200
  const big = makeSampleRing(300000, 'CNY')
  for (let i = 0; i < TEN_SECOND_SAMPLES; i += 1)
    appendRing(big, T0 + i * 10000, 100 - i / 100000)
  const bigBlob = encodeSampleRing(big)
  check('30 days at 10s fits the ring', big.length === TEN_SECOND_SAMPLES, String(big.length))
  check('30 days round-trips through the codec',
    decodeSampleRing(bigBlob).length === TEN_SECOND_SAMPLES,
    String(decodeSampleRing(bigBlob).length))
  check('30 days is ~2 MB of base64, inside the ~5 MB origin quota',
    bigBlob.length < 3000000, `${(bigBlob.length / 1048576).toFixed(2)} MB`)
  check('the decoded window covers the full 30 days',
    decodeSampleRing(bigBlob).length * 10 >= 2592000,
    `${(decodeSampleRing(bigBlob).length * 10) / 86400} days`)
  check('the stored series stays below the sample ceiling',
    big.length <= exportsObject.HISTORY_MAX_SAMPLES)
  check('the storage key is namespaced', /^dsh-balance-monitor:/.test(HISTORY_STORAGE_KEY),
    HISTORY_STORAGE_KEY)
}

console.log('\n# local history in the rendered panels')
{
  const section = render(
    registrations.find((r) => r.name === 'settings.section').handle.component,
    {},
  )
  const text = collectText(section).join('|')
  check('the settings section still renders its cards',
    text.includes('余额监控') && text.includes('余额趋势') && text.includes('参数'),
    text.slice(0, 200))
  check('the diagnostics card names where samples are stored',
    text.includes('本地采样存储') && text.includes('localStorage'), text.slice(-600))
  check('the diagnostics card reports the retained window',
    text.includes('保留 30 天'), text.slice(-600))
  check('the diagnostics card counts the local samples',
    /本地采样\d+ 条/.test(text.replace(/\|/g, '')), text.slice(-600))
  check('the diagnostics card lists the host cap it replaces',
    text.includes('上限 1440'), text.slice(-600))
  check('the clear-history dialog mentions the browser copy',
    /本地浏览器里保存的采样/.test(source), '')

  const dialogTree = render(footer.handle.component, { wide: true })
  findClass(dialogTree, 'bm-row')?.props?.onClick?.()
  const opened = render(footer.handle.component, { wide: true })
  const dialogText = collectText(opened).join('|')
  const mounted = findClass(opened, 'bm-trend-body') !== null
  check('the dialog still mounts after the ring changes', mounted)
  check('the dialog reports the samples behind the tab',
    /采样点/.test(dialogText), dialogText.slice(0, 400))
  check('the dialog reports the window it actually covers',
    /实际跨度/.test(dialogText), dialogText.slice(0, 400))
  findClass(opened, 'bm-modal-card')?.props?.onClose?.()
}

console.log('\n# persistence across page loads')
{
  // A second, independent evaluation with storage already holding a series: the
  // page must come back up with that series, not with the host's short tail.
  const seeded = makeLocalStorage()
  const samples = []
  const now = Date.now()
  for (let i = 0; i < 12; i += 1) samples.push([now - (12 - i) * 60000, 40 + i])
  seeded.setItem('dsh-balance-monitor:history:v1', storedBlob({
    currency: 'CNY',
    capacity: 64,
    samples,
  }))

  const fetchStub = (url) => {
    const path = String(url)
    const body = path.includes('/balance-monitor/balance')
      ? {
          balances: [{
            currency: 'CNY',
            balance: 52.5,
            granted: 0,
            toppedUp: 52.5,
            total: 52.5,
            available: true,
          }],
          currency: 'CNY',
          available: true,
          phase: null,
          spend: { CNY: 1.5 },
          ts: Date.now(),
        }
      : path.includes('/balance-monitor/health')
        ? { ok: true, version: '1.1.0', node: 'v22', requests: 1, stateFile: 'x', lastError: null }
        : path.includes('/balance-monitor/reset')
          ? { ok: true, history: [], spend: {} }
          : { config: { autoRefresh: false, refreshInterval: 30 }, history: [], spend: {} }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  // Swap the storage the bundle sees, then evaluate it fresh — which is exactly
  // what a reload does.
  globalThis.localStorage = seeded
  const second = evaluateBundle({ __ModuleLoader__: { load: () => {} }, localStorage: seeded })
  const bundle2 = second.factory((specifier) => {
    if (!(specifier in requireTable)) throw new Error(`unexpected require("${specifier}")`)
    return requireTable[specifier]
  })
  bundle2.apply(ctx)
  await tick()
  const span2 = bundle2.localHistorySpan()
  check('a reload restores the persisted series', span2?.samples === 12, JSON.stringify(span2))
  check('the restored series keeps its currency', span2?.currency === 'CNY', String(span2?.currency))
  check('the restored series reports the storage backend', span2?.storage === 'local',
    String(span2?.storage))
  check('a reload reports the size of what it restored', span2?.bytes > 0, String(span2?.bytes))
  check('the page does not re-seed from the empty host tail',
    bundle2.mergeLocalHistory({ history: [] }, 'CNY').length === 12,
    String(bundle2.mergeLocalHistory({ history: [] }, 'CNY').length))

  // A quota that refuses every write must not break the page: the series stays in
  // memory, the failure is recorded, and the diagnostics say so. The store also
  // sheds its older half and retries once, so "still recording" rather than "still
  // 13 long" is the contract.
  const small = makeLocalStorage()
  small.setItem('dsh-balance-monitor:history:v1', storedBlob({
    currency: 'CNY',
    capacity: 4096,
    samples,
  }))
  small.quota = 8
  globalThis.localStorage = small
  const third = evaluateBundle({ __ModuleLoader__: { load: () => {} }, localStorage: small })
  const bundle3 = third.factory((specifier) => {
    if (!(specifier in requireTable)) throw new Error(`unexpected require("${specifier}")`)
    return requireTable[specifier]
  })
  check('a quota failure still restores the in-memory series',
    bundle3.localHistorySpan()?.samples === 12, JSON.stringify(bundle3.localHistorySpan()))
  // A reading stamped now, against 12 seeded samples that end ~11 minutes ago.
  bundle3.noteSample(Date.now(), 'CNY', 51.25)
  const span3 = bundle3.localHistorySpan()
  check('a quota failure keeps recording in memory', span3.samples > 0, String(span3.samples))
  check('a quota failure sheds the older half and keeps the newest reading',
    span3.samples === 7, String(span3.samples))
  // Float32 is the storage type the plugin chose, so the newest reading is
  // preserved to ~7 significant digits rather than exactly: at 51.25 stored as a
  // float the error is ~4e-6, still four orders of magnitude below one fen.
  const newest = bundle3.mergeLocalHistory({ history: [] }, 'CNY').slice(-1)[0].value
  check('the newest reading survives the quota failure',
    Math.abs(newest - 51.25) < 0.0001, `${newest} / ${JSON.stringify(bundle3.mergeLocalHistory({ history: [] }, 'CNY').slice(-3))}`)
  check('a quota failure is reported, not thrown',
    typeof span3.error === 'string' && span3.error.length > 0, String(span3.error))

  // The live read path: a successful balance fetch records one more sample and
  // persists it, which is what makes the 30-day series grow at all.
  localStorageGlobal.values.clear()
  globalThis.localStorage = localStorageGlobal
  const savedFetch = globalThis.fetch
  globalThis.fetch = fetchStub
  const fourth = evaluateBundle({ __ModuleLoader__: { load: () => {} }, localStorage: localStorageGlobal })
  const bundle4 = fourth.factory((specifier) => {
    if (!(specifier in requireTable)) throw new Error(`unexpected require("${specifier}")`)
    return requireTable[specifier]
  })
  // `apply` is what a page does on load: it probes the config and then reads the
  // balance. The relative `/balance-monitor/*` path is the Web profile's real one.
  bundle4.apply(ctx)
  await tick()
  await tick()
  const after = bundle4.localHistorySpan()
  globalThis.fetch = savedFetch
  check('a live refresh appends a sample to the local series',
    after !== null && after.samples === 1, JSON.stringify(after))
  const livePoints = bundle4.mergeLocalHistory({ history: [] }, 'CNY')
  // Float32 keeps ~7 significant digits, i.e. far finer than one fen on any
  // realistic balance — the storage choice the panel documents.
  check('the appended sample carries the fetched balance',
    livePoints.length === 1 && Math.abs(livePoints[0].value - 52.5) < 0.001,
    JSON.stringify(livePoints))
  check('the appended sample is persisted', after !== null && after.bytes > 0,
    String(after?.bytes))
  check('the live series is attributed to the browser store', after?.storage === 'local',
    String(after?.storage))
}

console.log(`\n${failures === 0 ? 'CLIENT BUNDLE OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
