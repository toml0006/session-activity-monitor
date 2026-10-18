import { expect, test } from 'claude-code/testing'

import { bytes, joules, parseBattery, parsePowerSource, watts, parseNettop, parseProbe, parseRusage, parseSlim, parseTimes, rates, sparkline } from './stats'

// 900 is the engine-side spawner; 950/951 are the probe's own sh and ps.
const PROBE_OUT = `900
10
17179869184
{ 1.50 2.00 2.50 }
    1     0   0.0   1000 10-00:00:00 /sbin/launchd
  100     1   0.0   5000 01:00:00 /Users/x/.local/bin/claude
  800   100  12.5 600000 30:00 claude bg-spare
  900   800   1.0  40000 29:00 claude
  810   800  50.0 200000 05:00 /opt/homebrew/bin/node
  811   810   0.5  10000 04:00 /bin/zsh
  950   900   0.0    800 00:00 /bin/sh
  951   950   0.0    900 00:00 ps
  999     1  99.0 900000 10:00 /Applications/Other.app/Other
`

test('sums the nearest claude ancestor and its descendants only', () => {
  const s = parseProbe(PROBE_OUT)
  expect(s.rootPid).toBe(900)
  expect(s.procs.map(p => p.pid)).toEqual([900])
})

test('a renamed background session process counts as claude', () => {
  const s = parseProbe(PROBE_OUT.replace(/^900\n/, '811\n'))
  expect(s.rootPid).toBe(800)
  expect(s.rootName).toBe('claude bg-spare')
  expect(s.procs.map(p => [p.pid, p.depth])).toEqual([[800, 0], [810, 1], [811, 2], [900, 1], [950, 2], [951, 3]])
  expect(s.cpu).toBe(64)
  expect(s.cores).toBe(10)
  expect(s.load).toEqual([1.5, 2, 2.5])
})

test('leaves out the probe sh and ps under the spawner', () => {
  const s = parseProbe(PROBE_OUT.replace(/^900\n/, '810\n').replace('  950   900', '  950   810'))
  expect(s.rootPid).toBe(800)
  expect(s.procs.map(p => p.pid)).toEqual([800, 810, 811, 900])
})

test('sparkline scales to the max', () => {
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
})

test('rusage lines become disk and energy counters per pid', () => {
  const c = parseRusage('800 1000 2000 5000000000\n900 0 0 0\n')
  expect(c.get(800)).toEqual([1000, 2000, 5000000000])
  expect(c.size).toBe(2)
})

test('nettop lines become byte counters, names with dots and spaces included', () => {
  const c = parseNettop(',bytes_in,bytes_out,\nclaude bg-spare.800,100,50,\ncom.apple.x.900,7,8,\n')
  expect(c.get(800)).toEqual([100, 50])
  expect(c.get(900)).toEqual([7, 8])
})

test('rates are per second over pids both samples hold', () => {
  const prev = new Map([[1, [0, 0]], [2, [10, 10]], [3, [5, 5]]])
  const cur = new Map([[1, [100, 50]], [2, [30, 10]], [4, [9, 9]]])
  const { total, perPid } = rates(prev, cur, 2, [1, 2, 3, 4])
  expect(total).toEqual([60, 25])
  expect(perPid.get(2)).toEqual([10, 0])
  expect(perPid.has(3)).toBe(false)
})

test('bytes reads like Activity Monitor', () => {
  expect(bytes(512)).toBe('512 B')
  expect(bytes(1536)).toBe('1.5 KB')
  expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB')
})

test('the io probes the mod starts are left out, a nettop the person runs is kept', () => {
  const out = PROBE_OUT.replace('  950   900   0.0    800 00:00 /bin/sh', '  950   800   0.0    800 00:00 /usr/bin/nettop')
    .replace('  951   950   0.0    900 00:00 ps', '  951   811   0.0    900 00:00 nettop')
  const s = parseProbe(out.replace(/^900\n/, '811\n'))
  expect(s.procs.map(p => p.pid)).toEqual([800, 810, 811, 951, 900])
})

test('every Claude tree on the machine is totalled, each process under its nearest claude', () => {
  const s = parseProbe(PROBE_OUT.replace(/^900\n/, '811\n'))
  expect(s.allClaude.trees).toBe(3)
  // 950/951 are a probe of the session 900's, not of this one: real activity there
  expect([...s.allClaude.pids].sort((a, b) => a - b)).toEqual([100, 800, 810, 811, 900, 950, 951])
  expect(s.allClaude.cpu).toBe(64)
})

test('times gives the CPU seconds the probe commands used', () => {
  expect(Math.round(parseTimes('0m0.010s 0m0.020s\n1m0.500s 0m0.250s') * 100)).toBe(6075)
  expect(parseTimes('no times here')).toBe(0)
})

test('battery capacity in Wh, and none on a desktop', () => {
  expect(parseBattery('"AppleRawMaxCapacity" = 6000\n"Voltage" = 12000')).toBe(72)
  // As ioreg prints it on Apple silicon: MaxCapacity is a percent, mAh is nested
  expect(parseBattery('"Voltage" = 12000\n"MaxCapacity" = 100\n"BatteryData" = {"NominalChargeCapacity"=6000,"DesignCapacity"=8694}')).toBe(72)
  expect(parseBattery('"MaxCapacity" = 100')).toBe(null)
  expect(parseBattery('nothing')).toBe(null)
  expect(joules(340)).toBe('340 J')
  expect(joules(1250)).toBe('1.3 kJ')
})

test('the lite probe totals the tree under a known root, and says when the root is gone', () => {
  const out = '  800     1  12.5 600000\n  810   800  50.0 200000\n  811   810   0.5  10000\n  999     1  99.0 900000\n0m0.00s 0m0.00s\n'
  expect(parseSlim(out, 800)).toEqual({ cpu: 63, rssKb: 810000, pids: [800, 810, 811] })
  expect(parseSlim(out, 1234)).toBe(null)
})

test('pmset says battery or AC', () => {
  expect(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t46%; discharging;")).toBe(true)
  expect(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t23%; charging;")).toBe(false)
  expect(parsePowerSource('')).toBe(null)
  expect(watts(0.4249)).toBe('0.42 W')
  expect(watts(12.3)).toBe('12 W')
})
