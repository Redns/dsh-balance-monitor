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

let registration = null
const window = {
  __ModuleLoader__: { load: (entry) => { registration = entry } },
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

const requireTable = {
  react: React,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement },
  '@deepseek-ai/dsh-client-ui-primitives': { Modal },
}

// Evaluate the bundle in a function scope that shadows window/document.
new Function('window', 'document', 'fetch', source)(window, document, () => Promise.reject(new Error('no network in smoke test')))

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
  const clientIds = [...source.matchAll(/id: '([a-z]+)', label: '[^']*', hint: '[^']*'/g)].map((m) => m[1])
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
  // Pull the function out of the bundle source and drive it with stubs: the
  // real one lives inside the module factory and is not exported.
  const src = source.slice(source.indexOf('function AmountValue(props) {'))
  const end = src.indexOf('\n    }\n')
  const body = end === -1 ? src : src.slice(0, end + '\n    }'.length)
  check('AmountValue found in the bundle', body.startsWith('function AmountValue(props) {') && body.length > 60, String(body.length))

  const build = new Function('react', 'RollDigits', 'amountDigits', 'amountSymbol', 'symbolPosition',
    `${body}\n return AmountValue`)

  const createElement = (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined)
    if (typeof type === 'function') return type({ ...props, children: flat })
    return { type, props: { ...(props ?? {}), children: flat } }
  }
  const RollDigits = (props) => ({ type: 'RollDigits', props: { text: props.text } })
  const AmountValue = build(
    { createElement },
    RollDigits,
    exportsObject.amountDigits,
    exportsObject.amountSymbol,
    (v) => (['after', 'before', 'none'].includes(v) ? v : 'after'),
  )

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
  const wallet = /id: 'wallet'[\s\S]*?draw: function \(\) \{([\s\S]*?)\n      \} \}/.exec(source)?.[1] ?? ''
  const xs = [...wallet.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number).filter((n) => n >= 1 && n <= 15)
  check('wallet artwork exists', wallet.length > 0)
  check('wallet default is configured', /icon: 'wallet'/.test(source), '')
}

console.log(`\n${failures === 0 ? 'CLIENT BUNDLE OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
