/**
 * Render a design preview of the sidebar footer rows plus the whole icon
 * collection to a standalone SVG, using the same geometry as the plugin's CSS
 * (42px rows, 8px left padding, 8px gap, 16px icon box, 1.3px stroke).
 *
 * The icon artwork is the single source of truth in lib/client.js: this script
 * extracts the path/circle/rect/ellipse data from the bundle and re-emits it as
 * plain SVG, so a typo in an icon's `d` attribute shows up here.
 *
 * Run with: node tools/make-icon-preview.mjs
 * Output:   design/icon-preview.svg
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// Extract the icon collection from the bundle.
// ---------------------------------------------------------------------------

/** Evaluate the ICONS literal out of the bundle with stub React factories. */
function extractIcons() {
  const start = source.indexOf('var ICONS = [')
  if (start === -1) throw new Error('ICONS literal not found in lib/client.js')
  const end = source.indexOf('\n    ]\n', start)
  if (end === -1) throw new Error('ICONS literal is not terminated as expected')
  const literal = source.slice(start + 'var ICONS = '.length, end + '\n    ]'.length)

  // The literal calls three helpers plus react.createElement; provide them.
  const createElement = (type, props) => ({ type, props: props ?? {} })
  const p = (key, d) => createElement('path', { key, d })
  const c = (key, cx, cy, r) => createElement('circle', { key, cx, cy, r })
  const react = { createElement }
  // eslint-disable-next-line no-new-func
  const value = new Function('react', 'p', 'c', 'yuanMark', `return ${literal}`)(react, p, c, () => [
    p('y1', 'M6.5 5.6 8 7.5l1.5-1.9'),
    p('y2', 'M8 7.5v4'),
    p('y3', 'M6.4 8.4h3.2'),
    p('y4', 'M6.4 9.6h3.2'),
  ])
  return value
}

const ICONS = extractIcons()
if (!Array.isArray(ICONS) || ICONS.length === 0) throw new Error('icon collection is empty')

// ---------------------------------------------------------------------------
// Geometry, mirroring the plugin CSS.
// ---------------------------------------------------------------------------

const ROW_H = 42
const PAD_L = 8
const PAD_R = 10
const GAP = 8
const ICON_BOX = 16
const LABEL = 14
const VALUE = 14
const CARD_W = 236
const CARD_PAD = 6

const INK = '#1f2430'
const MUTED = '#8b93a3'
const LINE = '#e4e7ee'
const ACCENT = '#3b82f6'

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One icon's children, scaled from the 16px design grid into a square box. */
function iconChildren(entry, x, y, size) {
  const scale = size / 16
  const parts = []
  for (const child of entry.draw()) {
    const { type, props } = child
    if (type === 'path') {
      parts.push(`<path d="${esc(props.d)}"/>`)
    } else if (type === 'circle') {
      parts.push(`<circle cx="${props.cx}" cy="${props.cy}" r="${props.r}"/>`)
    } else if (type === 'ellipse') {
      parts.push(`<ellipse cx="${props.cx}" cy="${props.cy}" rx="${props.rx}" ry="${props.ry}"/>`)
    } else if (type === 'rect') {
      parts.push(`<rect x="${props.x}" y="${props.y}" width="${props.width}" height="${props.height}" rx="${props.rx ?? 0}"/>`)
    } else {
      throw new Error(`unsupported icon child type: ${type}`)
    }
  }
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</g>`
}

/**
 * A native-shaped footer row.
 * @param label - row text.
 * @param value - right-aligned value, or null for none.
 * @param iconId - collection id, or null to draw the native gear.
 * @param options - { accent: boolean, refresh: boolean }
 */
function row({ label, value, iconId, accent = false, refresh = false }) {
  const y = 0
  const iconX = PAD_L
  const labelX = iconX + ICON_BOX + GAP
  const parts = []

  parts.push(iconId === null
    ? gearIcon(iconX, y + (ROW_H - ICON_BOX) / 2, ICON_BOX)
    : iconChildren(ICONS.find((i) => i.id === iconId) ?? ICONS[0], iconX, y + (ROW_H - ICON_BOX) / 2, ICON_BOX))

  parts.push(`<text x="${labelX}" y="${y + ROW_H / 2}" dominant-baseline="central" font-size="${LABEL}" fill="${INK}">${esc(label)}</text>`)

  if (value !== null) {
    const refreshW = refresh ? 22 + 2 : 0
    const valueRight = CARD_W - CARD_PAD * 2 - PAD_R - refreshW
    parts.push(`<text x="${valueRight}" y="${y + ROW_H / 2}" text-anchor="end" dominant-baseline="central" font-size="${VALUE}" fill="${INK}" font-variant-numeric="tabular-nums">${esc(value)}</text>`)
  }

  if (refresh) {
    const rx = CARD_W - CARD_PAD * 2 - PAD_R - 22
    parts.push(`<g transform="translate(${rx} ${y + (ROW_H - 16) / 2})" fill="none" stroke="${MUTED}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`
      + '<path d="M13.4 8a5.4 5.4 0 0 1-9.22 3.82"/><path d="M2.6 8a5.4 5.4 0 0 1 9.22-3.82"/>'
      + '<path d="M11.85 1.9v2.35h-2.35"/><path d="M4.15 14.1v-2.35h2.35"/></g>')
  }

  const bg = accent ? ` fill="#f2f4f8"` : ''
  return `<rect x="0" y="${y}" width="${CARD_W - CARD_PAD * 2}" height="${ROW_H}" rx="12"${bg}/>`
    + `<g color="${INK}">${parts.join('')}</g>`
}

/** The native settings gear (IconSettingsOutline, simplified outline + teeth). */
function gearIcon(x, y, size) {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const x1 = 8 + Math.cos(a) * 5.4
    const y1 = 8 + Math.sin(a) * 5.4
    const x2 = 8 + Math.cos(a) * 6.9
    const y2 = 8 + Math.sin(a) * 6.9
    return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}"/>`
  }).join('')
  const scale = size / 16
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`
    + `<circle cx="8" cy="8" r="4.6"/><circle cx="8" cy="8" r="1.9"/>${teeth}</g>`
}

// ---------------------------------------------------------------------------
// Compose the sheet.
// ---------------------------------------------------------------------------

const rowsY = CARD_PAD
const row1 = row({ label: '余额', value: '10.31￥', iconId: 'coin', accent: true, refresh: true })
const row2 = row({ label: '设置', value: null, iconId: null })
const settingsBlock = `<g transform="translate(${CARD_PAD} ${rowsY})">${row1}${row2}</g>`

// Alignment guides: the left edge of the icon box and of the label text.
const guideY0 = rowsY
const guideY1 = rowsY + ROW_H * 2
const guides = [
  `<line x1="${CARD_PAD + PAD_L}" y1="${guideY0}" x2="${CARD_PAD + PAD_L}" y2="${guideY1}" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>`,
  `<line x1="${CARD_PAD + PAD_L + ICON_BOX + GAP}" y1="${guideY0}" x2="${CARD_PAD + PAD_L + ICON_BOX + GAP}" y2="${guideY1}" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>`,
].join('')

const cardH = CARD_PAD * 2 + ROW_H * 2
const card = `<rect x="0" y="0" width="${CARD_W}" height="${cardH}" rx="14" fill="#ffffff" stroke="${LINE}"/>`

// Icon grid, three columns of 64px tiles.
const TILE_W = 64
const TILE_H = 58
const TILE_GAP = 6
const GRID_COLS = 3
const gridTop = cardH + 26
const grid = ICONS.map((entry, index) => {
  const col = index % GRID_COLS
  const rowIndex = Math.floor(index / GRID_COLS)
  const x = col * (TILE_W + TILE_GAP)
  const y = gridTop + rowIndex * (TILE_H + TILE_GAP)
  return `<g transform="translate(${x} ${y})">`
    + `<rect x="0" y="0" width="${TILE_W}" height="${TILE_H}" rx="8" fill="#ffffff" stroke="${LINE}"/>`
    + `<g color="${INK}">${iconChildren(entry, (TILE_W - 18) / 2, 8, 18)}</g>`
    + `<text x="${TILE_W / 2}" y="46" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(entry.id)}</text>`
    + '</g>'
}).join('')

const gridRows = Math.ceil(ICONS.length / GRID_COLS)
const width = Math.max(CARD_W, GRID_COLS * TILE_W + (GRID_COLS - 1) * TILE_GAP) + 32
const height = gridTop + gridRows * (TILE_H + TILE_GAP) + 8

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<g transform="translate(16 16)">${card}${settingsBlock}${guides}</g>
<g transform="translate(16 0)">${grid}</g>
</svg>
`

await mkdir(join(root, 'design'), { recursive: true })
const outPath = join(root, 'design', 'icon-preview.svg')
await writeFile(outPath, svg, 'utf8')

console.log(`icons in the collection: ${ICONS.length}`)
console.log(`ids: ${ICONS.map((i) => i.id).join(', ')}`)
console.log(`wrote ${outPath} (${width}x${height})`)
