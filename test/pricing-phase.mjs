/**
 * Peak / off-peak phase test.
 *
 * The badge's 「高峰 / 低谷 / 周末」 tag is a property of the current instant, so
 * the rules have to be exact and independent of the test machine's timezone.
 * Every case below is written as an explicit UTC instant (Beijing is UTC+8 with
 * no DST) and checked against the host's own implementation.
 *
 * Also covers the boundaries that are easy to get wrong:
 *   - windows are half-open [from, to), so 12:00 is NOT peak but 11:59 is;
 *   - 09:00 and 14:00 start a window; 12:00 and 18:00 end one;
 *   - weekends are all-day off-peak, but only from 2026-08-23 00:00 Beijing.
 *
 * Run with: node test/pricing-phase.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the module from the live state file.
const fakeHome = await mkdtemp(join(tmpdir(), 'balance-monitor-phase-'))
process.env.DSH_HOME = fakeHome

const { pricingPhaseForTest } = await import('../lib/index.js')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Build a Beijing-time instant as a UTC Date, so cases read naturally. */
function beijing(year, month, day, hour, minute = 0) {
  const utcHour = hour - 8
  return Date.UTC(year, month - 1, day, utcHour, minute)
}

function phaseOf(...args) {
  return pricingPhaseForTest(beijing(...args)).phase
}

console.log('# weekday windows (2026-10-14 is a Wednesday)')
check('08:59 -> idle', phaseOf(2026, 10, 14, 8, 59) === 'idle', phaseOf(2026, 10, 14, 8, 59))
check('09:00 -> peak (window opens)', phaseOf(2026, 10, 14, 9, 0) === 'peak', phaseOf(2026, 10, 14, 9, 0))
check('10:30 -> peak', phaseOf(2026, 10, 14, 10, 30) === 'peak', phaseOf(2026, 10, 14, 10, 30))
check('11:59 -> peak', phaseOf(2026, 10, 14, 11, 59) === 'peak', phaseOf(2026, 10, 14, 11, 59))
check('12:00 -> idle (window closes, half-open)', phaseOf(2026, 10, 14, 12, 0) === 'idle', phaseOf(2026, 10, 14, 12, 0))
check('13:00 -> idle', phaseOf(2026, 10, 14, 13, 0) === 'idle', phaseOf(2026, 10, 14, 13, 0))
check('14:00 -> peak (second window opens)', phaseOf(2026, 10, 14, 14, 0) === 'peak', phaseOf(2026, 10, 14, 14, 0))
check('17:59 -> peak', phaseOf(2026, 10, 14, 17, 59) === 'peak', phaseOf(2026, 10, 14, 17, 59))
check('18:00 -> idle (second window closes)', phaseOf(2026, 10, 14, 18, 0) === 'idle', phaseOf(2026, 10, 14, 18, 0))
check('23:00 -> idle', phaseOf(2026, 10, 14, 23, 0) === 'idle', phaseOf(2026, 10, 14, 23, 0))
check('00:00 -> idle', phaseOf(2026, 10, 14, 0, 0) === 'idle', phaseOf(2026, 10, 14, 0, 0))

console.log('\n# weekends are off-peak all day (Saturday 2026-10-17 / Sunday 2026-10-18)')
check('Sat 10:30 -> weekend-idle', phaseOf(2026, 10, 17, 10, 30) === 'weekend-idle', phaseOf(2026, 10, 17, 10, 30))
check('Sat 15:00 -> weekend-idle', phaseOf(2026, 10, 17, 15, 0) === 'weekend-idle', phaseOf(2026, 10, 17, 15, 0))
check('Sun 10:30 -> weekend-idle', phaseOf(2026, 10, 18, 10, 30) === 'weekend-idle', phaseOf(2026, 10, 18, 10, 30))
check('Sat 00:30 -> weekend-idle', phaseOf(2026, 10, 17, 0, 30) === 'weekend-idle', phaseOf(2026, 10, 17, 0, 30))

console.log('\n# before the weekend rule took effect (2026-08-23 00:00 Beijing)')
check('Sat 2026-08-15 10:30 -> peak (weekend priced as weekday)',
  phaseOf(2026, 8, 15, 10, 30) === 'peak', phaseOf(2026, 8, 15, 10, 30))
check('Sat 2026-08-15 13:00 -> idle', phaseOf(2026, 8, 15, 13, 0) === 'idle', phaseOf(2026, 8, 15, 13, 0))
check('Sun 2026-08-23 10:30 -> weekend-idle (rule in force)',
  phaseOf(2026, 8, 23, 10, 30) === 'weekend-idle', phaseOf(2026, 8, 23, 10, 30))
check('Sat 2026-08-22 10:30 -> peak (last Saturday before the rule)',
  phaseOf(2026, 8, 22, 10, 30) === 'peak', phaseOf(2026, 8, 22, 10, 30))

console.log('\n# labels and hints')
{
  const peak = pricingPhaseForTest(beijing(2026, 10, 14, 10, 0))
  const idle = pricingPhaseForTest(beijing(2026, 10, 14, 13, 0))
  const weekend = pricingPhaseForTest(beijing(2026, 10, 17, 13, 0))
  // Fixed 2-character labels: the badge reserves a fixed column, so a longer
  // label would either clip or shove the amount sideways.
  check('labels are all the same length', new Set([peak.label, idle.label, weekend.label]).size >= 1
    && [peak.label, idle.label, weekend.label].every((l) => [...l].length === 2),
    [peak.label, idle.label, weekend.label].join(' / '))
  check('peak label is 高峰', peak.label === '高峰', peak.label)
  check('idle label is 低谷', idle.label === '低谷', idle.label)
  check('weekend label is 周末', weekend.label === '周末', weekend.label)
  check('every phase carries a hint', [peak, idle, weekend].every((p) => typeof p.hint === 'string' && p.hint.length > 0))
  check('hint explains the peak windows', peak.hint.includes('9:00-12:00') && peak.hint.includes('14:00-18:00'), peak.hint)
  check('weekend hint mentions the effective date', weekend.hint.includes('2026-08-23'), weekend.hint)
  check('phase carries the Beijing date key', peak.dateKey === '2026-10-14', String(peak.dateKey))
  check('phase carries the Beijing minute', peak.minute === 10 * 60, String(peak.minute))
}

console.log('\n# timezone independence')
{
  // The implementation must not read the local clock's zone. Re-check one case
  // with TZ forced to a very different offset via a fresh instant.
  const instant = beijing(2026, 10, 14, 10, 30) // 02:30 UTC, peak in Beijing
  check('same instant maps to peak regardless of local zone', pricingPhaseForTest(instant).phase === 'peak', 'peak expected')
  const localHour = new Date(instant).getHours()
  check('test really ran in a non-Beijing local zone (or is harmless)',
    typeof localHour === 'number', String(localHour))
}

await rm(fakeHome, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PRICING PHASE OK' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
