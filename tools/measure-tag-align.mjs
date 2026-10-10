/**
 * Vertical alignment of the 余额 label against the peak/off-peak tag's
 * background box.
 *
 * The tag is a tinted rounded rectangle (light green / light orange) whose text
 * is a different colour from the page background, so its box can be found by
 * scanning a horizontal strip for pixels that differ from the page colour. The
 * label's cap height is found from its ink. Comparing the two mid-lines is the
 * only way to tell whether they are optically centred on each other.
 *
 * Run with: node tools/measure-tag-align.mjs <image.png> [--label-x A-B] [--tag-x A-B]
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/measure-tag-align.mjs <image.png> [--label-x A-B] [--tag-x A-B]')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// PNG decode (8-bit, non-interlaced).
// ---------------------------------------------------------------------------

function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev === null ? 0 : prev[x]
      const c = prev === null || x < channels ? 0 : prev[x - channels]
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = value & 0xff
    }
  }
  return { width, height, channels, pixels }
}

const { width, height, channels, pixels } = decodePng(readFileSync(file))
const rgb = (x, y) => {
  const i = (y * width + x) * channels
  return channels === 1 ? [pixels[i], pixels[i], pixels[i]] : [pixels[i], pixels[i + 1], pixels[i + 2]]
}
const luminance = (x, y) => {
  const [r, g, b] = rgb(x, y)
  return (r * 299 + g * 587 + b * 114) / 1000
}

function rangeArg(flag, fallback) {
  const at = process.argv.indexOf(flag)
  if (at === -1) return fallback
  const [a, b] = process.argv[at + 1].split('-').map(Number)
  return [a, b]
}

// The label and the tag sit just right of the icon; the values below come from
// tools/measure-rows.mjs output for this screenshot.
const [labelFrom, labelTo] = rangeArg('--label-x', [71, 124])
const [tagFrom, tagTo] = rangeArg('--tag-x', [149, 186])

console.log(`image ${width}x${height}  label x=${labelFrom}..${labelTo}  tag x=${tagFrom}..${tagTo}`)

// Page background, sampled far from any content.
const pageRef = rgb(width - 3, 2)
const isPage = (x, y) => {
  const [r, g, b] = rgb(x, y)
  return Math.abs(r - pageRef[0]) + Math.abs(g - pageRef[1]) + Math.abs(b - pageRef[2]) <= 6
}

/** Vertical extent of the rows in `yFrom..yTo` where at least `minCount` pixels in the x-range differ from the page. */
function notPageRows(from, to, minCount, yFrom, yTo) {
  const rows = []
  for (let y = yFrom; y <= yTo; y += 1) {
    let count = 0
    for (let x = from; x <= to; x += 1) if (!isPage(x, y)) count += 1
    if (count >= minCount) rows.push(y)
  }
  return rows
}

const span = (rows) => (rows.length === 0 ? null : { top: rows[0], bottom: rows[rows.length - 1], height: rows[rows.length - 1] - rows[0] + 1, mid: (rows[0] + rows[rows.length - 1]) / 2 })

// Confine the scan to the balance row's band: the same x columns also contain
// the 设置 row further down, which would otherwise blow the span wide open.
const bandArg = rangeArg('--band-y', [30, 62])
const [bandFrom, bandTo] = bandArg
console.log(`  band restricted to y=${bandFrom}..${bandTo}`)

// The tag: its tinted box spans the whole range, so a low threshold is enough.
const tagSpan = span(notPageRows(tagFrom, tagTo, Math.ceil((tagTo - tagFrom + 1) * 0.6), bandFrom, bandTo))
// The label: only the glyphs are non-page, and they are a minority of columns.
const labelSpan = span(notPageRows(labelFrom, labelTo, 1, bandFrom, bandTo))

console.log('')
console.log('  tag background box :', tagSpan === null ? '(not found)' : `y ${tagSpan.top}..${tagSpan.bottom}  h=${tagSpan.height}  mid=${tagSpan.mid}`)
console.log('  label glyph ink    :', labelSpan === null ? '(not found)' : `y ${labelSpan.top}..${labelSpan.bottom}  h=${labelSpan.height}  mid=${labelSpan.mid}`)

if (tagSpan !== null && labelSpan !== null) {
  console.log('')
  console.log(`  mid-line difference (tag - label): ${(tagSpan.mid - labelSpan.mid).toFixed(1)}px`)
  console.log(`  top difference   : ${tagSpan.top - labelSpan.top}px`)
  console.log(`  bottom difference: ${tagSpan.bottom - labelSpan.bottom}px`)

  // Cap-height centre: CJK glyphs have no descender, so the ink span IS the
  // cap box, and its mid-line is the optical centre to match.
  const capMid = labelSpan.mid
  const tagMid = tagSpan.mid
  const delta = tagMid - capMid
  console.log('')
  if (Math.abs(delta) < 0.5) {
    console.log('  => already optically centred')
  } else {
    console.log(`  => tag sits ${delta > 0 ? 'LOW' : 'HIGH'} by ${Math.abs(delta).toFixed(1)}px`)
    console.log(`     fix: translateY(${-delta > 0 ? '+' : ''}${(-delta).toFixed(2)}px) or an equal margin adjustment`)
  }
}
