/**
 * Render a before/after alignment sheet to SVG.
 *
 * Two cards, each showing the balance row stacked directly on the native
 * Settings row, with dashed guides at the icon's left edge and at the label's
 * left edge:
 *
 *   BEFORE — the 18px icon box the badge first shipped with. The extra 2px of
 *            box plus its 1px vertical offset push 「余额」 2px right of
 *            「设置」, which is the misalignment that was reported.
 *   AFTER  — the 16px box, matching the native gear exactly.
 *
 * Artwork is extracted from lib/client.js, so this cannot drift from the plugin.
 *
 * Run with: node tools/make-alignment-preview.mjs
 * Output:   design/alignment-preview.svg
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// Reuse the plugin's own icon artwork.
// ---------------------------------------------------------------------------

const start = source.indexOf('var ICONS = [')
const end = source.indexOf('\n    ]\n', start)
const literal = source.slice(start + 'var ICONS = '.length, end + '\n    ]'.length)
const createElement = (type, props) => ({ type, props: props ?? {} })
const p = (key, d) => createElement('path', { key, d })
const c = (key, cx, cy, r) => createElement('circle', { key, cx, cy, r })
const ICONS = new Function('react', 'p', 'c', 'yuanMark', `return ${literal}`)(
  { createElement }, p, c,
  () => [p('y1', 'M6.5 5.6 8 7.5l1.5-1.9'), p('y2', 'M8 7.5v4'), p('y3', 'M6.4 8.4h3.2'), p('y4', 'M6.4 9.6h3.2')],
)
// The badge's default icon is the wallet, so the preview must show what ships.
const WALLET = ICONS.find((entry) => entry.id === 'wallet') ?? ICONS[0]
const COIN = WALLET

// ---------------------------------------------------------------------------
// Geometry — mirrors the .bm-row / .bm-icon rules in lib/client.js.
// ---------------------------------------------------------------------------

const ROW_H = 42
const PAD_L = 8
const PAD_R = 10
const GAP = 8
const FS = 14
const CARD_W = 232
const PANEL_GAP = 26
const SCALE = 2.6
const HEAD_H = 34 // two lines of card caption

const INK = '#1b1f27'
const MUTED = '#7c8598'
const LINE = '#e6e9f0'
const GUIDE = '#3b82f6'
const HILITE = '#eef1f6'

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Re-emit one collected icon at (x, y) with the given box size. */
function glyph(entry, x, y, size) {
  const parts = entry.draw().map((child) => {
    const { type, props } = child
    if (type === 'path') return `<path d="${esc(props.d)}"/>`
    if (type === 'circle') return `<circle cx="${props.cx}" cy="${props.cy}" r="${props.r}"/>`
    if (type === 'ellipse') return `<ellipse cx="${props.cx}" cy="${props.cy}" rx="${props.rx}" ry="${props.ry}"/>`
    if (type === 'rect') return `<rect x="${props.x}" y="${props.y}" width="${props.width}" height="${props.height}" rx="${props.rx ?? 0}"/>`
    throw new Error(`unsupported child ${type}`)
  })
  return `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="currentColor" color="${INK}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</g>`
}

/** The native settings gear, drawn to the original artwork's r ~= 6.08 extent. */
function gear(x, y, size) {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 + Math.PI / 8
    const r1 = 5.25
    const r2 = 5.45
    return `<path d="M${(8 + Math.cos(a) * r1).toFixed(2)} ${(8 + Math.sin(a) * r1).toFixed(2)}L${(8 + Math.cos(a) * r2).toFixed(2)} ${(8 + Math.sin(a) * r2).toFixed(2)}"/>`
  }).join('')
  return `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="none" stroke="currentColor" color="${INK}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`
    + `<circle cx="8" cy="8" r="5.25"/><circle cx="8" cy="8" r="2.05"/>${teeth}</g>`
}

const REFRESH = '<g fill="none" stroke="' + MUTED + '" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M13.4 8a5.4 5.4 0 0 1-9.22 3.82"/><path d="M2.6 8a5.4 5.4 0 0 1 9.22-3.82"/>'
  + '<path d="M11.85 1.9v2.35h-2.35"/><path d="M4.15 14.1v-2.35h2.35"/></g>'

/** One footer row drawn at the top-left of its own coordinate space. */
function row({ label, value, iconBox, gearInstead = false, highlight = false, refresh = false, phase = null }) {
  const parts = []
  const iconY = (ROW_H - iconBox) / 2 // centred, exactly as align-items:center does
  parts.push(gearInstead ? gear(PAD_L, iconY, iconBox) : glyph(WALLET, PAD_L, iconY, iconBox))

  const labelX = PAD_L + iconBox + GAP
  parts.push(`<text x="${labelX}" y="${ROW_H / 2}" dominant-baseline="central" font-size="${FS}" fill="${INK}" font-family="'Microsoft YaHei','Segoe UI',sans-serif">${esc(label)}</text>`)

  if (phase !== null) {
    // Fixed 26x16 column, 10px text — mirrors .bm-phase, including the measured
    // `top` nudge onto the label glyphs' optical centre (see the CSS comment).
    const boxX = labelX + label.length * FS + GAP
    const boxY = (ROW_H - 16) / 2 + PHASE_TOP
    const tint = phase.peak ? '#ff8f1f' : '#00c878'
    parts.push(`<rect x="${boxX}" y="${boxY}" width="26" height="16" rx="4" fill="${tint}" opacity="0.12"/>`)
    parts.push(`<text x="${boxX + 13}" y="${boxY + 8}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="600" fill="${tint}" font-family="'Microsoft YaHei','Segoe UI',sans-serif">${esc(phase.text)}</text>`)
  }

  if (value !== null) {
    const right = CARD_W - PAD_R - (refresh ? 24 : 0)
    parts.push(`<text x="${right}" y="${ROW_H / 2}" text-anchor="end" dominant-baseline="central" font-size="${FS}" fill="${INK}" font-family="'Segoe UI',sans-serif" font-variant-numeric="tabular-nums">${esc(value)}</text>`)
  }
  if (refresh) {
    parts.push(`<g transform="translate(${CARD_W - PAD_R - 22} ${(ROW_H - 16) / 2})">${REFRESH}</g>`)
  }

  const bg = highlight ? `<rect x="0" y="0" width="${CARD_W}" height="${ROW_H}" rx="12" fill="${HILITE}"/>` : ''
  return bg + parts.join('')
}

/**
 * One captioned card holding the balance row over the Settings row.
 * @param rowShift - horizontal offset applied to the balance row only, in px.
 *        The native settings row is shifted left 2px by its wrapper's
 *        `margin: 4px -2px`; BEFORE omitted the matching pull on our row, which
 *        is the real cause of the misalignment (AFTER passes 0 and relies on
 *        .bm-row's own `margin: 0 -2px`).
 */
function card(title, subtitle, iconBox, rowShift = 0) {
  const guideH = ROW_H * 2
  const iconEdge = PAD_L + rowShift
  const labelEdge = PAD_L + iconBox + GAP + rowShift
  const rows = [
    `<line x1="${PAD_L}" y1="0" x2="${PAD_L}" y2="${guideH}" stroke="${GUIDE}" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>`,
    `<line x1="${PAD_L + iconBox + GAP}" y1="0" x2="${PAD_L + iconBox + GAP}" y2="${guideH}" stroke="${GUIDE}" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>`,
    `<g transform="translate(${rowShift} 0)">${row({ label: '余额', value: '10.31￥', iconBox, highlight: true, refresh: true, phase: { text: '周末', peak: false } })}</g>`,
    `<g transform="translate(0 ${ROW_H})">${row({ label: '设置', value: null, iconBox, gearInstead: true })}</g>`,
  ].join('')

  return [
    `<text x="0" y="0" font-size="13" font-weight="600" fill="${INK}" font-family="'Microsoft YaHei','Segoe UI',sans-serif">${esc(title)}</text>`,
    `<text x="0" y="18" font-size="11" fill="${MUTED}" font-family="'Microsoft YaHei','Segoe UI',sans-serif">${esc(subtitle)}</text>`,
    `<g transform="translate(0 ${HEAD_H})">${rows}</g>`,
  ].join('')
}

// ---------------------------------------------------------------------------
// Compose.
// ---------------------------------------------------------------------------

const cardH = HEAD_H + ROW_H * 2
const contentW = CARD_W
const contentH = cardH

// The BEFORE panel shows the 3px remainder measured on a real screenshot
// (settings icon x=20 / label x=66 vs this row at x=23 / x=70); the AFTER panel
// uses whatever the plugin's own CSS now pulls, read from the source so the
// preview cannot drift from the shipped rule.
const rowMargin = /\.bm-row\{[^}]*margin:0 (-?[\d.]+)px/.exec(source)?.[1]
const appliedPull = rowMargin === undefined ? 0 : Math.abs(Number(rowMargin))
// The tag's vertical nudge, read from source so the preview tracks the CSS.
const PHASE_TOP = Number(/\.bm-phase\{[^}]*top:(-?[\d.]+)px/.exec(source)?.[1] ?? 0)

const panels = [
  { title: 'BEFORE · 没有对齐补偿', subtitle: '「余额」比「设置」右移 3px：图标与文字都没对齐', box: 16, shift: 3 },
  { title: `AFTER · margin:0 -${appliedPull}px 对齐补偿`, subtitle: '两条虚线对齐，图标与文字都与「设置」同列', box: 16, shift: 0 },
]

const body = panels.map((panel, index) => {
  const y = index * (cardH + PANEL_GAP)
  return `<g transform="translate(12 ${12 + y})">`
    + `<rect x="0" y="0" width="${contentW}" height="${contentH}" rx="14" fill="#ffffff" stroke="${LINE}"/>`
    + `<g transform="translate(14 12)">${card(panel.title, panel.subtitle, panel.box, panel.shift)}</g>`
    + '</g>'
}).join('')

const logicalW = contentW + 24
const logicalH = 12 * 2 + panels.length * cardH + (panels.length - 1) * PANEL_GAP
const outW = Math.round(logicalW * SCALE)
const outH = Math.round(logicalH * SCALE)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${logicalW} ${logicalH}">`
  + `<rect width="${logicalW}" height="${logicalH}" fill="#ffffff"/>`
  + body
  + '</svg>\n'

await mkdir(join(root, 'design'), { recursive: true })
const outPath = join(root, 'design', 'alignment-preview.svg')
await writeFile(outPath, svg, 'utf8')
console.log(`wrote ${outPath} (${outW}x${outH}, drawn at ${SCALE}x)`)
