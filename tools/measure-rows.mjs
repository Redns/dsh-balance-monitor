/**
 * Measure row geometry from a screenshot of the sidebar footer.
 *
 * Finds, per text row, the left edge of the icon artwork, the left edge of the
 * label text, and — when the hover highlight is visible — the row's background
 * extent, so the balance row and the native Settings row can be compared in
 * absolute pixels instead of by eye.
 *
 * Run with: node tools/measure-rows.mjs <image.png> [--scale N]
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/measure-rows.mjs <image.png>')
  process.exit(2)
}
const scaleArg = process.argv.indexOf('--scale')
const scale = scaleArg === -1 ? 1 : Number(process.argv[scaleArg + 1])

// ---------------------------------------------------------------------------
// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced).
// ---------------------------------------------------------------------------

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
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
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`unsupported color type ${colorType}`)

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
const luminance = (x, y) => {
  const i = (y * width + x) * channels
  if (channels === 1) return pixels[i]
  return (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000
}

// Ink = clearly darker than the page background (handles light themes).
const INK_THRESHOLD = 150
const isInk = (x, y) => luminance(x, y) < INK_THRESHOLD

// ---------------------------------------------------------------------------
// Row bands: horizontal strips that contain ink.
// ---------------------------------------------------------------------------

const inkPerRow = []
for (let y = 0; y < height; y += 1) {
  let count = 0
  for (let x = 0; x < width; x += 1) if (isInk(x, y)) count += 1
  inkPerRow.push(count)
}

const bands = []
let start = -1
for (let y = 0; y <= height; y += 1) {
  const hasInk = y < height && inkPerRow[y] > 0
  if (hasInk && start === -1) start = y
  if (!hasInk && start !== -1) {
    bands.push({ top: start, bottom: y - 1 })
    start = -1
  }
}

console.log(`image: ${width}x${height}, channels=${channels}, scale=${scale}`)
console.log(`ink bands (rows): ${bands.map((b) => `${b.top}..${b.bottom}`).join('  ')}\n`)

/** RGB at a pixel (greyscale files are expanded). */
function rgb(x, y) {
  const i = (y * width + x) * channels
  if (channels === 1) return [pixels[i], pixels[i], pixels[i]]
  return [pixels[i], pixels[i + 1], pixels[i + 2]]
}

/** Column ink profile of one band, with gaps marked. */
function profile(band) {
  const columns = []
  for (let x = 0; x < width; x += 1) {
    let count = 0
    for (let y = band.top; y <= band.bottom; y += 1) if (isInk(x, y)) count += 1
    columns.push(count)
  }
  // Group contiguous inked columns into runs, recording gaps > 3px as breaks.
  const runs = []
  let runStart = -1
  let lastInk = -1
  for (let x = 0; x < width; x += 1) {
    if (columns[x] > 0) {
      if (runStart === -1) runStart = x
      else if (x - lastInk > 3) {
        runs.push({ from: runStart, to: lastInk })
        runStart = x
      }
      lastInk = x
    }
  }
  if (runStart !== -1) runs.push({ from: runStart, to: lastInk })
  return runs
}

/**
 * Horizontal extent of the row's own background (the hover highlight), found by
 * scanning a text-free scanline for pixels that differ from the page colour.
 */
function highlightExtent(band) {
  const pageTop = rgb(width - 3, 1)
  const pageBottom = rgb(width - 3, height - 2)
  // Use the corner on the opposite half of the image as the page reference.
  const mid = Math.floor((band.top + band.bottom) / 2)
  const reference = band.top < height / 2 ? pageBottom : pageTop
  let from = -1
  let to = -1
  for (let x = 0; x < width; x += 1) {
    const [r, g, b] = rgb(x, mid)
    const differs = Math.abs(r - reference[0]) + Math.abs(g - reference[1]) + Math.abs(b - reference[2]) > 12
    if (differs) {
      if (from === -1) from = x
      to = x
    }
  }
  return from === -1 ? null : { from, to }
}

/**
 * Vertical ink extents inside an x-range, used to compare how two things on the
 * same row sit relative to each other (e.g. the 余额 label vs the phase tag).
 * @param band - the row band.
 * @param from - inclusive left column.
 * @param to - inclusive right column.
 * @param threshold - luminance below which a pixel counts as ink.
 * @returns `{ top, bottom, height, mid }` or null when nothing is inked there.
 */
function verticalExtent(band, from, to, threshold = INK_THRESHOLD) {
  let top = -1
  let bottom = -1
  for (let y = band.top; y <= band.bottom; y += 1) {
    let inked = false
    for (let x = from; x <= to; x += 1) {
      if (luminance(x, y) < threshold) {
        inked = true
        break
      }
    }
    if (inked) {
      if (top === -1) top = y
      bottom = y
    }
  }
  if (top === -1) return null
  return { top, bottom, height: bottom - top + 1, mid: (top + bottom) / 2 }
}

/**
 * Vertical extent of a *tinted* region (the phase tag's rounded background),
 * which is lighter than ink but differs from the page background.
 * @returns `{ top, bottom, height, mid }` or null.
 */
function tintExtent(band, from, to) {
  const reference = rgb(width - 3, band.top)
  let top = -1
  let bottom = -1
  for (let y = band.top; y <= band.bottom; y += 1) {
    let tinted = 0
    for (let x = from; x <= to; x += 1) {
      const [r, g, b] = rgb(x, y)
      if (Math.abs(r - reference[0]) + Math.abs(g - reference[1]) + Math.abs(b - reference[2]) > 8
        && luminance(x, y) >= INK_THRESHOLD) {
        tinted += 1
      }
    }
    if (tinted >= 3) {
      if (top === -1) top = y
      bottom = y
    }
  }
  if (top === -1) return null
  return { top, bottom, height: bottom - top + 1, mid: (top + bottom) / 2 }
}

const measured = []
for (const band of bands) {
  const runList = profile(band)
  const iconRun = runList[0]
  const labelRun = runList[1]
  const highlight = highlightExtent(band)
  measured.push({ band, runList, iconRun, labelRun, highlight })

  console.log(`band y=${band.top}..${band.bottom}  height=${band.bottom - band.top + 1}`)
  console.log('  inked runs (x ranges, px):')
  for (const run of runList) {
    console.log(`    ${String(run.from).padStart(4)} .. ${String(run.to).padStart(4)}   (w=${run.to - run.from + 1})`)
  }
  if (iconRun !== undefined) console.log(`  icon left edge:  ${iconRun.from}px  (${(iconRun.from / scale).toFixed(2)} logical)`)
  if (labelRun !== undefined) console.log(`  label left edge: ${labelRun.from}px  (${(labelRun.from / scale).toFixed(2)} logical)`)
  if (iconRun !== undefined && labelRun !== undefined) console.log(`  icon->label gap: ${labelRun.from - iconRun.to - 1}px`)
  console.log(`  row highlight:   ${highlight === null ? '(not visible)' : `${highlight.from}..${highlight.to}  (w=${highlight.to - highlight.from + 1})`}`)

  // Vertical detail: every horizontal run gets its own ink extent, so a label
  // and a tinted tag on the same row can be compared directly.
  for (const run of runList) {
    const ink = verticalExtent(band, run.from, run.to)
    const tint = tintExtent(band, run.from, run.to)
    if (ink === null && tint === null) continue
    const parts = [`x=${run.from}..${run.to}`]
    if (ink !== null) parts.push(`ink y=${ink.top}..${ink.bottom} (h=${ink.height}, mid=${ink.mid})`)
    if (tint !== null) parts.push(`tint y=${tint.top}..${tint.bottom} (h=${tint.height}, mid=${tint.mid})`)
    console.log(`    ${parts.join('  ')}`)
  }
  console.log('')
}

// The last band is the Settings row (it has no right-aligned amount).
if (measured.length >= 2) {
  const balance = measured[0]
  const settings = measured[measured.length - 1]
  console.log('# comparison (balance vs settings)')
  const diff = (a, b, name) => {
    if (a === undefined || b === undefined) return
    console.log(`  ${name}: ${a - b >= 0 ? '+' : ''}${a - b}px`)
  }
  diff(balance.iconRun?.from, settings.iconRun?.from, 'icon left offset')
  diff(balance.labelRun?.from, settings.labelRun?.from, 'label left offset')
  diff(balance.highlight?.from, settings.highlight?.from, 'row left offset')
  if (balance.highlight !== null && settings.highlight !== null) {
    console.log(`  row width: balance=${balance.highlight.to - balance.highlight.from + 1} settings=${settings.highlight.to - settings.highlight.from + 1}`)
  }
}
