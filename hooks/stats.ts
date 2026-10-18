import type { Proc, Snapshot } from '../types'

// One shell call gathers everything: the spawner's pid (the engine, or a child
// of it), machine facts, then every process. LC_ALL=C keeps ps's decimals dots.
export const PROBE = [
  '/bin/sh',
  '-c',
  'echo $PPID; sysctl -n hw.ncpu hw.memsize vm.loadavg; ps -axo pid=,ppid=,pcpu=,rss=,etime=,comm=; times',
] as const

/**
 * CPU seconds a probe's own commands used, from the \`times\` its shell prints
 * last (children's user and system time), so the monitor can report its cost.
 */
export function parseTimes(stdout: string): number {
  const last = stdout.trim().split('\n').pop() ?? ''
  const parts = [...last.matchAll(/(\d+)m([\d.]+)s/g)].map(m => Number(m[1]) * 60 + Number(m[2]))
  return parts.length === 2 ? (parts[0] ?? 0) + (parts[1] ?? 0) : 0
}

const ROW = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/

const PROBE_COMMANDS = ['ps', 'nettop', 'Python', 'python3']

// "claude bg-spare" and "/Users/x/.local/bin/claude" both name a claude process
const isClaude = (name: string) => name.split(' ')[0]?.split('/').pop() === 'claude'

// A full path may hold spaces ("Application Support"); a renamed title holds words
const shortName = (name: string) => {
  if (name.startsWith('/')) return name.split('/').pop() ?? name
  const [head = '', ...rest] = name.split(' ')
  return [head.split('/').pop(), ...rest].join(' ')
}

export function parseProbe(stdout: string): Snapshot {
  const [spawner = '', ncpu, memsize, loadavg = '', ...rows] = stdout.trim().split('\n')

  const all = new Map<number, Omit<Proc, 'depth' | 'watts'>>()
  for (const row of rows) {
    const m = ROW.exec(row)
    if (!m) continue
    const pid = Number(m[1])
    all.set(pid, {
      pid,
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssKb: Number(m[4]),
      elapsed: m[5] ?? '',
      name: (m[6] ?? '').trim(),
    })
  }

  // The session is the nearest claude ancestor of whatever ran the probe
  let rootPid = Number(spawner)
  while (rootPid > 1 && !isClaude(all.get(rootPid)?.name ?? '')) {
    rootPid = all.get(rootPid)?.ppid ?? 1
  }
  if (rootPid <= 1) throw new Error(`no claude process above pid ${spawner}`)

  const children = new Map<number, Omit<Proc, 'depth' | 'watts'>[]>()
  for (const p of all.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid)!.push(p)
  }

  // Depth-first so the table reads as a tree; busiest siblings first. The probe's
  // own sh and ps are left out, since they exist only because we asked.
  // The mod's own probes: an sh under the spawner or the session running ps,
  // nettop or python, and those children. They exist only because we asked.
  const probePids = new Set<number>()
  for (const sh of [...(children.get(Number(spawner)) ?? []), ...(children.get(rootPid) ?? [])]) {
    const kids = children.get(sh.pid) ?? []
    if (shortName(sh.name) === 'sh' && kids.some(k => PROBE_COMMANDS.includes(shortName(k.name)))) {
      probePids.add(sh.pid)
      for (const k of kids) probePids.add(k.pid)
    }
  }
  const procs: Proc[] = []
  // The io probes (nettop, and python under sh) are the session's direct children
  const isIoProbe = (p: Omit<Proc, 'depth' | 'watts'>, depth: number) =>
    depth === 1 && ['nettop', 'Python', 'python3'].includes(shortName(p.name))
  const walk = (p: Omit<Proc, 'depth' | 'watts'>, depth: number) => {
    if (probePids.has(p.pid) || isIoProbe(p, depth)) return
    procs.push({ ...p, depth, name: shortName(p.name), watts: null })
    const kids = [...(children.get(p.pid) ?? [])].sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
    for (const k of kids) walk(k, depth + 1)
  }
  walk(all.get(rootPid)!, 0)

  // Every Claude process tree on the machine: each process counts toward its
  // nearest claude ancestor, so nested sessions (a background session under the
  // daemon) are counted once, under the session that owns them.
  const owner = new Map<number, number | null>()
  const ownerOf = (pid: number): number | null => {
    if (owner.has(pid)) return owner.get(pid)!
    const p = all.get(pid)
    const o = !p ? null : isClaude(p.name) ? pid : p.ppid > 1 ? ownerOf(p.ppid) : null
    owner.set(pid, o)
    return o
  }
  const trees = new Set<number>()
  const claudePids: number[] = []
  let allCpu = 0
  let allRss = 0
  for (const p of all.values()) {
    const o = ownerOf(p.pid)
    if (o === null || probePids.has(p.pid)) continue
    trees.add(o)
    claudePids.push(p.pid)
    allCpu += p.cpu
    allRss += p.rssKb
  }

  return {
    rootPid,
    rootName: shortName(all.get(rootPid)!.name),
    allClaude: { trees: trees.size, cpu: allCpu, rssKb: allRss, pids: claudePids },
    cores: Number(ncpu),
    memBytes: Number(memsize),
    load: loadavg.replace(/[{}]/g, '').trim().split(/\s+/).map(Number),
    cpu: procs.reduce((s, p) => s + p.cpu, 0),
    rssKb: procs.reduce((s, p) => s + p.rssKb, 0),
    procs,
  }
}

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[], max?: number): string {
  const top = max ?? Math.max(1, ...values)
  return values.map(v => BARS[Math.min(7, Math.max(0, Math.round((v / top) * 7)))]).join('')
}

export const gb = (kb: number) => (kb / 1048576).toFixed(kb >= 10485760 ? 0 : 1)

// Disk and energy per process come from proc_pid_rusage (what Activity Monitor
// reads), called through the system python. It runs only where the Command
// Line Tools are installed, so a bare Mac never sees an install prompt; there
// the probe prints nothing and the pane says why.
const RUSAGE_PY = `
import ctypes, sys
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
class RU(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [('f%d' % i, ctypes.c_uint64) for i in range(56)]
for pid in map(int, sys.argv[1:]):
    r = RU()
    if lib.proc_pid_rusage(pid, 6, ctypes.byref(r)) == 0:
        print(pid, r.f16, r.f17, r.f40)
    elif lib.proc_pid_rusage(pid, 4, ctypes.byref(r)) == 0:
        print(pid, r.f16, r.f17, -1)
`
// Fields after the uuid: 16 diskio_bytesread, 17 diskio_byteswritten, and in
// rusage_info_v6 (macOS 13+) 40 energy_nj. v4's billed_energy reads 0 on Apple
// silicon, so before v6 the energy column is -1, unknown.

export const ioProbe = (pids: readonly number[]) => ({
  argv: ['/bin/sh', '-c', 'xcode-select -p >/dev/null 2>&1 && /usr/bin/python3 -I -c "$PY" "$@"; times', 'sh', ...pids.map(String)],
  env: { PY: RUSAGE_PY },
})

// One nettop sample takes about 5 s, so it runs beside the 2 s sampler, not in it
export const NET_PROBE = ['/bin/sh', '-c', '/usr/bin/nettop -P -L 1 -x -J bytes_in,bytes_out; times'] as const

// The battery's full charge in watt-hours, to put a prompt's energy in battery terms
export const BATTERY_PROBE = ['/usr/sbin/ioreg', '-rn', 'AppleSmartBattery'] as const

/**
 * Full-charge capacity in Wh from ioreg, or null on a Mac without a battery.
 * Capacity is in mAh in the nested battery data (NominalChargeCapacity, else
 * AppleRawMaxCapacity); the top-level MaxCapacity is a percentage, never used.
 */
export function parseBattery(stdout: string): number | null {
  const field = (k: string) => new RegExp(`"${k}"\\s*=\\s*(\\d+)`).exec(stdout)?.[1]
  const mah = field('NominalChargeCapacity') ?? field('AppleRawMaxCapacity')
  const mv = field('Voltage')
  if (!mah || !mv) return null
  return (Number(mah) * Number(mv)) / 1e6
}

/** "340 J", "1.2 kJ" */
export const joules = (j: number) => (j >= 1000 ? `${(j / 1000).toFixed(1)} kJ` : `${j.toFixed(0)} J`)

export type Counters = Map<number, number[]>

/** "pid read written energyNj" lines: cumulative disk bytes and energy (-1 when unknown). */
export function parseRusage(stdout: string): Counters {
  const out: Counters = new Map()
  for (const line of stdout.trim().split('\n')) {
    const [pid, ...rest] = line.trim().split(/\s+/).map(Number)
    if (pid && rest.length === 3) out.set(pid, rest)
  }
  return out
}

/** nettop's "name.pid,bytes_in,bytes_out," lines: cumulative bytes per process. */
export function parseNettop(stdout: string): Counters {
  const out: Counters = new Map()
  for (const line of stdout.split('\n')) {
    const m = /\.(\d+),(\d+),(\d+),$/.exec(line.trim())
    if (m) out.set(Number(m[1]), [Number(m[2]), Number(m[3])])
  }
  return out
}

/**
 * Per-second rates between two counter samples, over the pids in `pids` that
 * both samples hold (a process that started or ended in between is skipped,
 * as is a counter that went backwards). Returns the summed rates and each pid's.
 */
export function rates(prev: Counters, cur: Counters, seconds: number, pids: Iterable<number>) {
  const perPid = new Map<number, number[]>()
  let total: number[] = []
  for (const pid of pids) {
    const a = prev.get(pid)
    const b = cur.get(pid)
    if (!a || !b || seconds <= 0) continue
    const r = b.map((v, i) => Math.max(0, v - (a[i] ?? v)) / seconds)
    perPid.set(pid, r)
    total = r.map((v, i) => v + (total[i] ?? 0))
  }
  return { total, perPid }
}

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

// The lite probe: no command names (half the CPU of the full ps), so the tree
// hangs off a session root the last full probe found.
export const SLIM_PROBE = ['/bin/sh', '-c', 'ps -axo pid=,ppid=,pcpu=,rss=; times'] as const

/** CPU and RSS of the tree under `rootPid` from the lite probe; null when the root is gone. */
export function parseSlim(stdout: string, rootPid: number): { cpu: number; rssKb: number; pids: number[] } | null {
  const rows = new Map<number, number[]>()
  const kids = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const [pid, ppid, cpu, rss] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    rows.set(pid, [cpu, rss])
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  }
  if (!rows.has(rootPid)) return null
  const pids: number[] = []
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()!
    pids.push(pid)
    stack.push(...(kids.get(pid) ?? []))
  }
  // Without names the probe's own sh and ps can't be told apart and are counted;
  // they read ~0% CPU (just started) and ~2 MB, too little to matter on the bar
  return {
    cpu: pids.reduce((s, p) => s + (rows.get(p)?.[0] ?? 0), 0),
    rssKb: pids.reduce((s, p) => s + (rows.get(p)?.[1] ?? 0), 0),
    pids,
  }
}

// Whether the Mac runs on battery: checked about once a minute (~9 ms of CPU)
export const POWER_SOURCE_PROBE = ['/usr/bin/pmset', '-g', 'batt'] as const

/** On battery or AC from `pmset -g batt`; null on a Mac that doesn't say (no battery). */
export function parsePowerSource(stdout: string): boolean | null {
  if (stdout.includes("'Battery Power'")) return true
  if (stdout.includes("'AC Power'") || stdout.includes("'UPS Power'")) return false
  return null
}

/** "0.42 W", "12 W" */
export const watts = (w: number) => `${w >= 10 ? w.toFixed(0) : w.toFixed(2)} W`
