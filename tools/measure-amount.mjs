/**
 * Measure the numerals of a balance amount in a screenshot.
 *
 * Reports, per ink run, the vertical extent (so the digit cap height can be
 * compared with the currency symbol's size) and the horizontal advance of each
 * glyph (so tabular vs proportional figures can be told apart).
 *
 * Run with: node tools/measure-amount.mjs <image.png> [--band-y A-B]
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/measure-amount.mjs <image.png> [--band-y A-B]')
  process.exit(2)
}
const bandAt = process.argv.indexOf('--band-y')
const [bandFrom, bandTo] = bandAt === -1
  ? [0, Number.MAX_SAFE_INTEGER]
  : process.argv[bandAt + 1].split('-').map(Number)

// --- PNG decode (8-bit, non-interlaced) -----------------------------------
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

const yFrom = Math.max(0, bandFrom)
const yTo = Math.min(height - 1, bandTo)

// Ink threshold: the amount is near-black on a light card.
const INK = 128
const inked = (x, y) => luminance(x, y) < INK

// Column runs within the band.
const runs = []
let runStart = -1
let lastInk = -1
for (let x = 0; x < width; x += 1) {
  let has = false
  for (let y = yFrom; y <= yTo; y += 1) {
    if (inked(x, y)) {
      has = true
      break
    }
  }
  if (has) {
    if (runStart === -1) runStart = x
    else if (x - lastInk > 1) {
      runs.push({ from: runStart, to: lastInk })
      runStart = x
    }
    lastInk = x
  }
}
if (runStart !== -1) runs.push({ from: runStart, to: lastInk })

/** Vertical ink extent inside one x range. */
function extent(from, to) {
  let top = -1
  let bottom = -1
  for (let y = yFrom; y <= yTo; y += 1) {
    let has = false
    for (let x = from; x <= to; x += 1) {
      if (inked(x, y)) {
        has = true
        break
      }
    }
    if (has) {
      if (top === -1) top = y
      bottom = y
    }
  }
  return top === -1 ? null : { top, bottom, height: bottom - top + 1 }
}

console.log(`image ${width}x${height}  band y=${yFrom}..${yTo}  ink runs: ${runs.length}`)
console.log('')
for (const run of runs) {
  const e = extent(run.from, run.to)
  const w = run.to - run.from + 1
  console.log(`  x=${String(run.from).padStart(4)}..${String(run.to).padStart(4)}  w=${String(w).padStart(3)}`
    + (e === null ? '' : `  y=${String(e.top).padStart(3)}..${String(e.bottom).padStart(3)}  cap=${String(e.height).padStart(3)}`))
}

// Digit baseline/height summary over the tall (numeric) runs.
const numeric = runs.map((r) => ({ r, e: extent(r.from, r.to) })).filter((x) => x.e !== null)
if (numeric.length > 0) {
  const maxCap = Math.max(...numeric.map((x) => x.e.height))
  const tall = numeric.filter((x) => x.e.height >= maxCap - 1)
  const bottoms = new Set(numeric.map((x) => x.e.bottom))
  console.log('')
  console.log(`  tallest glyph cap height : ${maxCap}px`)
  console.log(`  distinct baselines       : ${[...bottoms].sort((a, b) => a - b).join(', ')}`)
  console.log(`  advances (px)            : ${tall.map((x) => x.r.to - x.r.from + 1).join(', ')}`)
  console.log(`  total width of tall runs : ${tall.reduce((a, x) => a + (x.r.to - x.r.from + 1), 0)}px`)
}
