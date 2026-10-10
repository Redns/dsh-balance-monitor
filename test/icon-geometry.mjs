/**
 * Icon collection geometry check.
 *
 * Every glyph must read as the same optical weight as the native Settings gear
 * beside it, so two properties have to hold for all of them:
 *
 *   1. no artwork escapes the 16x16 box (an escaping glyph looks clipped or
 *      oversized and inflates the flex row);
 *   2. the visual half-extent stays close to the gear's, whose artwork reaches
 *      r ~= 6.08 from the centre. A glyph filling r = 6.6+ reads visibly heavier
 *      than the gear — exactly the "too big / not aligned" look being fixed.
 *
 * Bounds come from a real SVG path-data parser (absolute + relative commands,
 * curves, arcs, H/V shorthand), so the numbers below are true extents rather
 * than a naive reading of the coordinate list.
 *
 * Run with: node test/icon-geometry.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// Extract the collection from the bundle.
// ---------------------------------------------------------------------------

const start = source.indexOf('var ICONS = [')
const end = source.indexOf('\n    ]\n', start)
if (start === -1 || end === -1) throw new Error('could not locate the ICONS literal in lib/client.js')
const literal = source.slice(start + 'var ICONS = '.length, end + '\n    ]'.length)

const createElement = (type, props) => ({ type, props: props ?? {} })
const p = (key, d) => createElement('path', { key, d })
const c = (key, cx, cy, r) => createElement('circle', { key, cx, cy, r })
const react = { createElement }
const ICONS = new Function('react', 'p', 'c', 'yuanMark', `return ${literal}`)(react, p, c, () => [
  p('y1', 'M6.5 5.6 8 7.5l1.5-1.9'),
  p('y2', 'M8 7.5v4'),
  p('y3', 'M6.4 8.4h3.2'),
  p('y4', 'M6.4 9.6h3.2'),
])

// ---------------------------------------------------------------------------
// A real SVG path-data parser, sufficient for the command set in use and for
// general path data: M m L l H h V v C c S s Q q T t A a Z z.
// ---------------------------------------------------------------------------

const PATH_COMMANDS = 'MmLlHhVvCcSsQqTtAaZz'
const PARAM_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** Tokenize path data into commands with their numeric parameters. */
function tokenizePath(d) {
  const tokens = []
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g
  let match
  let command = null
  while ((match = pattern.exec(d)) !== null) {
    if (match[1] !== undefined) {
      command = match[1]
      tokens.push({ command, numbers: [] })
    } else {
      if (command === null) throw new Error(`path data starts with a number: ${d}`)
      tokens[tokens.length - 1].numbers.push(Number(match[2]))
    }
  }
  return tokens
}

/**
 * Absolute end/control points for one path.
 * @returns a list of points that bound the drawn shape (exact for lines and
 *          curves, since control points bound a Bezier and the arc box is
 *          computed from its endpoints and radii).
 */
function pathPoints(d) {
  const points = []
  const tokens = tokenizePath(d)
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  let prevControl = null // for S/T shorthand
  let prevCommand = ''

  const push = (x, y) => points.push({ x, y })

  for (const token of tokens) {
    const upper = token.command.toUpperCase()
    const relative = token.command !== upper
    const params = token.numbers
    const arity = PARAM_COUNT[upper]

    if (arity === 0) {
      // Z / z: close back to the subpath start.
      push(startX, startY)
      cx = startX
      cy = startY
      prevControl = null
      prevCommand = token.command
      continue
    }

    if (params.length === 0 || params.length % arity !== 0) {
      throw new Error(`command ${token.command} in "${d}" has ${params.length} parameters, expected a multiple of ${arity}`)
    }

    for (let i = 0; i < params.length; i += arity) {
      const a = params.slice(i, i + arity)
      if (upper === 'M') {
        const x = relative ? cx + a[0] : a[0]
        const y = relative ? cy + a[1] : a[1]
        cx = x
        cy = y
        startX = x
        startY = y
        push(x, y)
        prevControl = null
      } else if (upper === 'L') {
        const x = relative ? cx + a[0] : a[0]
        const y = relative ? cy + a[1] : a[1]
        cx = x
        cy = y
        push(x, y)
        prevControl = null
      } else if (upper === 'H') {
        const x = relative ? cx + a[0] : a[0]
        cx = x
        push(cx, cy)
        prevControl = null
      } else if (upper === 'V') {
        const y = relative ? cy + a[0] : a[0]
        cy = y
        push(cx, cy)
        prevControl = null
      } else if (upper === 'C') {
        const x1 = relative ? cx + a[0] : a[0]
        const y1 = relative ? cy + a[1] : a[1]
        const x2 = relative ? cx + a[2] : a[2]
        const y2 = relative ? cy + a[3] : a[3]
        const x = relative ? cx + a[4] : a[4]
        const y = relative ? cy + a[5] : a[5]
        push(x1, y1)
        push(x2, y2)
        push(x, y)
        // Sample the curve too: control points bound it, sampling tightens it.
        for (let t = 0.25; t < 1; t += 0.25) {
          const mt = 1 - t
          push(
            mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
            mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
          )
        }
        prevControl = { x: x2, y: y2 }
        cx = x
        cy = y
      } else if (upper === 'S') {
        const x2 = relative ? cx + a[0] : a[0]
        const y2 = relative ? cy + a[1] : a[1]
        const x = relative ? cx + a[2] : a[2]
        const y = relative ? cy + a[3] : a[3]
        const x1 = prevCommand !== null && 'CS'.includes(prevCommand.toUpperCase()) && prevControl !== null
          ? 2 * cx - prevControl.x
          : cx
        const y1 = prevCommand !== null && 'CS'.includes(prevCommand.toUpperCase()) && prevControl !== null
          ? 2 * cy - prevControl.y
          : cy
        push(x1, y1)
        push(x2, y2)
        push(x, y)
        prevControl = { x: x2, y: y2 }
        cx = x
        cy = y
      } else if (upper === 'Q') {
        const x1 = relative ? cx + a[0] : a[0]
        const y1 = relative ? cy + a[1] : a[1]
        const x = relative ? cx + a[2] : a[2]
        const y = relative ? cy + a[3] : a[3]
        push(x1, y1)
        push(x, y)
        prevControl = { x: x1, y: y1 }
        cx = x
        cy = y
      } else if (upper === 'T') {
        const x = relative ? cx + a[0] : a[0]
        const y = relative ? cy + a[1] : a[1]
        const x1 = prevCommand !== null && 'QT'.includes(prevCommand.toUpperCase()) && prevControl !== null
          ? 2 * cx - prevControl.x
          : cx
        const y1 = prevCommand !== null && 'QT'.includes(prevCommand.toUpperCase()) && prevControl !== null
          ? 2 * cy - prevControl.y
          : cy
        push(x1, y1)
        push(x, y)
        prevControl = { x: x1, y: y1 }
        cx = x
        cy = y
      } else if (upper === 'A') {
        const x = relative ? cx + a[5] : a[5]
        const y = relative ? cy + a[6] : a[6]
        const rx = Math.abs(a[0])
        const ry = Math.abs(a[1])
        // Conservative bound: the arc cannot leave the box around its segment
        // endpoints grown by the radii.
        push(cx - rx, cy - ry)
        push(cx + rx, cy + ry)
        push(x - rx, y - ry)
        push(x + rx, y + ry)
        push(x, y)
        prevControl = null
        cx = x
        cy = y
      }
      prevCommand = token.command
    }
  }

  return points
}

/** True bounds of one icon across all of its elements. */
function boundsOf(entry) {
  const points = []
  for (const child of entry.draw()) {
    const { type, props } = child
    if (type === 'circle') {
      points.push({ x: props.cx - props.r, y: props.cy - props.r }, { x: props.cx + props.r, y: props.cy + props.r })
    } else if (type === 'ellipse') {
      points.push({ x: props.cx - props.rx, y: props.cy - props.ry }, { x: props.cx + props.rx, y: props.cy + props.ry })
    } else if (type === 'rect') {
      points.push({ x: props.x, y: props.y }, { x: props.x + props.width, y: props.y + props.height })
    } else if (type === 'path') {
      points.push(...pathPoints(props.d))
    } else {
      throw new Error(`unsupported child type ${type} in ${entry.id}`)
    }
  }
  const xs = points.map((pt) => pt.x)
  const ys = points.map((pt) => pt.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// ---------------------------------------------------------------------------
// Collection contract.
// ---------------------------------------------------------------------------

console.log(`# collection (${ICONS.length} icons)`)

const ids = ICONS.map((i) => i.id)
check('at least 12 icons collected', ICONS.length >= 12, String(ICONS.length))
check('ids are unique', new Set(ids).size === ids.length, ids.join(','))
check('every id is a plain slug', ids.every((id) => /^[a-z][a-z0-9]*$/.test(id)), ids.filter((id) => !/^[a-z][a-z0-9]*$/.test(id)).join(','))
check('every icon has a label', ICONS.every((i) => typeof i.label === 'string' && i.label.length > 0),
  ICONS.filter((i) => !i.label).map((i) => i.id).join(','))
check('the first icon is the default (coin)', ids[0] === 'coin', ids[0])
check('every icon has artwork', ICONS.every((i) => Array.isArray(i.draw()) && i.draw().length > 0),
  ICONS.filter((i) => !Array.isArray(i.draw()) || i.draw().length === 0).map((i) => i.id).join(','))
check('every path parses without an arity error', (() => {
  try {
    for (const entry of ICONS) boundsOf(entry)
    return true
  } catch (err) {
    console.log(`       parser: ${err.message}`)
    return false
  }
})())

// ---------------------------------------------------------------------------
// Geometry contract.
// ---------------------------------------------------------------------------

console.log('\n# geometry (16px box, native gear weight)')

const GEAR_EXTENT = 6.08 // IconSettingsOutline artwork reaches r ~= 6.08
const MAX_EXTENT = 6.45

for (const entry of ICONS) {
  const b = boundsOf(entry)
  check(`${entry.id}: inside the 16px box`,
    b.minX >= 0.4 && b.maxX <= 15.6 && b.minY >= 0.4 && b.maxY <= 15.6,
    `x ${b.minX.toFixed(2)}..${b.maxX.toFixed(2)}  y ${b.minY.toFixed(2)}..${b.maxY.toFixed(2)}`)
}

for (const entry of ICONS) {
  const b = boundsOf(entry)
  const extent = Math.max((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2)
  check(`${entry.id}: matches the gear's optical weight (<= ${MAX_EXTENT})`,
    extent <= MAX_EXTENT, `half-extent ${extent.toFixed(2)} vs gear ~${GEAR_EXTENT}`)
}

// ---------------------------------------------------------------------------
// The badge row geometry contract itself.
// ---------------------------------------------------------------------------

console.log('\n# badge row geometry')

const rowRule = source.match(/\.bm-row\{([^}]*)\}/)?.[1] ?? ''
const iconRule = source.match(/\.bm-icon\{([^}]*)\}/)?.[1] ?? ''
check('.bm-icon is a 16px box (matches the wide-sidebar gear)', /width:16px/.test(iconRule) && /height:16px/.test(iconRule), iconRule)
check('.bm-row keeps the native 42px height', /height:42px/.test(rowRule), rowRule.slice(0, 80))
check('.bm-row keeps the native left padding', /padding:0 10px 0 8px/.test(rowRule), '')
check('.bm-row keeps the native 8px gap', /gap:8px/.test(rowRule), '')
check('rail icon grows to the native 18px', /\.bm-row\.bm-rail \.bm-icon\{width:18px;height:18px\}/.test(source), '')

console.log(`\n${failures === 0 ? 'ICON GEOMETRY OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
