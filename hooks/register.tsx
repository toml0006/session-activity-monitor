import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Io, Mode, Snapshot, Stats, Turn } from '../types'
import type { Counters } from './stats'
import {
  BATTERY_PROBE,
  NET_PROBE,
  POWER_SOURCE_PROBE,
  PROBE,
  SLIM_PROBE,
  bytes,
  gb,
  ioProbe,
  joules,
  parseBattery,
  parseNettop,
  parsePowerSource,
  parseProbe,
  parseRusage,
  parseSlim,
  parseTimes,
  rates,
  sparkline,
  watts,
} from './stats'

const PANE = 'session-stats'
// What each mode costs, measured on an M-series Mac: the full ps is ~86 ms of CPU,
// the nameless one ~44 ms, the python energy probe ~55 ms, nettop ~128 ms
const MODES: Record<Mode, { ms: number; note: string }> = {
  lite: { ms: 10000, note: 'every 10 s, CPU, RAM and power, about 1% of one core' },
  normal: { ms: 5000, note: 'every 5 s, with live energy and disk, about 3% of one core' },
  full: { ms: 2000, note: 'every 2 s, everything, about 7% of one core (plus nettop with the pane open)' },
}
const MODE_KEY = 'mode'
const BAR_PROMPT_KEY = 'barPrompt'
const POWER_CHECK_MS = 60_000
const HISTORY = 120
// Each history in the bar is at most this many cells (one minute of samples)
const BAR_SPAN = 30
const BAR_KEY = 'bar'
// A prompt whose tree used at least this much energy raises a toast
const TOAST_JOULES = 300
const EMPTY: Stats = {
  snapshot: null,
  error: null,
  cpuHistory: [],
  ramHistory: [],
  io: null,
  isRusageAvailable: true,
  net: null,
  netHistory: [],
  diskHistory: [],
  energyHistory: [],
  allWatts: null,
  cpuSeconds: 0,
  turn: null,
  lastTurn: null,
  batteryWh: null,
  ownCpuSeconds: 0,
  ownSince: null,
  isOnBattery: null,
  batteryJoules: 0,
  batterySince: null,
}
const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, EMPTY)
const isBarOn = atom({ plugin: 'session-stats', key: 'isBarOn' } as const, false)
const modeAtom = atom({ plugin: 'session-stats', key: 'mode' } as const, 'lite' as Mode)
// Per-prompt joules on the bar: off by default, the bar leads with watts and battery
const isBarPromptOn = atom({ plugin: 'session-stats', key: 'isBarPromptOn' } as const, false)

// "<0.01%" for a trace, two decimals under 1%, one above
const batteryShare = (j: number, wh: number) => {
  const pct = (j / (wh * 3600)) * 100
  return pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(pct >= 1 ? 1 : 2)}%`
}

const wattsColor = (w: number) => (w >= 5 ? 'red' : w >= 1 ? 'yellow' : 'green')
const batteryColor = (j: number, wh: number | null) => {
  const pct = wh ? (j / (wh * 3600)) * 100 : 0
  return pct >= 5 ? 'red' : pct >= 2 ? 'yellow' : 'green'
}
const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

// "0.31% of the battery used by this session since 08:12" or "on AC power"
function batterySummary(st: Stats): string {
  if (st.isOnBattery === null) return 'battery: unknown'
  if (!st.isOnBattery) return 'on AC power'
  const used = st.batteryWh ? batteryShare(st.batteryJoules, st.batteryWh) : joules(st.batteryJoules)
  return `${used} of the battery used by this session${st.batterySince ? ` since ${clockTime(st.batterySince)}` : ''}`
}

const joulesColor = (j: number) => (j >= TOAST_JOULES ? 'red' : j >= TOAST_JOULES / 3 ? 'yellow' : 'green')
const duration = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${sec.toFixed(0)}s`)

const cpuColor = (cpu: number) => (cpu >= 100 ? 'red' : cpu >= 50 ? 'yellow' : 'green')
const ramColor = (kb: number) => (kb >= 4194304 ? 'red' : kb >= 2097152 ? 'yellow' : 'green')

// One sampler serves the bar, the pane and a running prompt, and runs only
// while one of them needs it. A reload resets these; session.start restarts it.
let timer: Timer | undefined
let isPaneOpen = false
let isTurnRunning = false
let prevSampleAt: number | undefined
let timerMs = 0
let mode: Mode = 'lite'
// When this session last drew the bar: a session that doesn't draw it (a
// background spare, no surface attached) has no reason to sample for it
let lastBarDrawnAt: number | undefined
let lastPowerCheckAt: number | undefined

// The pane shows everything, so it samples at full while it's open
const effectiveMode = (): Mode => (isPaneOpen ? 'full' : mode)

// The previous cumulative counters, to turn the next ones into rates
let prevRusage: { at: number; counters: Counters } | undefined
let prevNet: { at: number; counters: Counters } | undefined
let isNetBusy = false

const push = (list: readonly number[], v: number) => [...list, v].slice(-HISTORY)

// The host keeps $.state across reloads and updates, so a value written by an
// older version can lack fields this one reads: fill them in on every read.
async function readStats($: EngineInterface): Promise<Stats> {
  return { ...EMPTY, ...(await read($, stats)) }
}

async function updateStats($: EngineInterface, fn: (s: Stats) => Stats) {
  await update($, stats, s => fn({ ...EMPTY, ...s }))
}

// "running 45s · 120 J (0.1% of battery) · 30 CPU-s · peak 3.2 cores"
function promptSummary(st: Stats): string {
  const t = st.turn ?? st.lastTurn
  if (!t) return 'no prompt measured yet'
  const energy = st.batteryWh ? `${batteryShare(t.joules, st.batteryWh)} of battery (${joules(t.joules)})` : joules(t.joules)
  return `${st.turn ? 'running' : 'last'} ${duration(t.seconds)} · ${energy} · ${t.cpuSeconds.toFixed(0)} CPU-s · peak ${(t.peakCpu / 100).toFixed(1)} cores`
}

// A periodic tick: skipped when only an undrawn bar wants it, the nameless ps
// in lite, the full probe otherwise. `force` (a prompt's start and end, the
// sampler starting) always takes a full reading with energy.
async function sample($: EngineInterface, force = false) {
  try {
    const now = await $.clock.now()
    const isBarUnseen = lastBarDrawnAt === undefined || now - lastBarDrawnAt > 3 * MODES[effectiveMode()].ms + 2000
    if (!force && !isPaneOpen && !isTurnRunning && isBarUnseen) return
    await checkPower($, now)
    const { snapshot } = await readStats($)
    if (!force && effectiveMode() === 'lite' && snapshot && (await sampleSlim($, snapshot))) return

    const ps = await $.process.run(PROBE, { env: { LC_ALL: 'C' }, timeoutMs: 5000 })
    const snap = parseProbe(ps.stdout)
    const pids = snap.procs.map(p => p.pid)

    // One rusage call covers every Claude tree, so this session's share is known
    const probe = ioProbe(snap.allClaude.pids)
    const io$ = await $.process.run(probe.argv, { env: probe.env, timeoutMs: 5000 })
    const usage = parseRusage(io$.stdout)
    const at = await $.clock.now()
    const sinceLast = prevSampleAt === undefined ? 0 : (at - prevSampleAt) / 1000
    prevSampleAt = at

    let io: Io | null = null
    let allWatts: number | null = null
    let seconds = 0
    if (prevRusage && usage.size > 0) {
      seconds = (at - prevRusage.at) / 1000
      const { total, perPid } = rates(prevRusage.counters, usage, seconds, pids)
      const hasEnergy = [...usage.values()].every(c => (c[2] ?? -1) >= 0)
      for (const p of snap.procs) {
        const r = perPid.get(p.pid)
        p.watts = r && hasEnergy ? (r[2] ?? 0) / 1e9 : null
      }
      const watts = hasEnergy ? (total[2] ?? 0) / 1e9 : 0
      io = { diskRead: total[0] ?? 0, diskWrite: total[1] ?? 0, watts, hasEnergy, joules: 0 }
      if (hasEnergy) allWatts = (rates(prevRusage.counters, usage, seconds, snap.allClaude.pids).total[2] ?? 0) / 1e9
    }
    prevRusage = usage.size > 0 ? { at, counters: usage } : undefined
    const cpuDelta = (snap.cpu / 100) * sinceLast
    const ownDelta = parseTimes(ps.stdout) + parseTimes(io$.stdout)

    await updateStats($, s => {
      const energy = io ? io.watts * seconds : 0
      const turn: Turn | null = s.turn && {
        ...s.turn,
        seconds: (at - s.turn.startedAt) / 1000,
        joules: s.turn.joules + energy,
        cpuSeconds: s.turn.cpuSeconds + cpuDelta,
        peakCpu: Math.max(s.turn.peakCpu, snap.cpu),
      }
      return {
        ...s,
        snapshot: snap,
        error: null,
        cpuHistory: push(s.cpuHistory, snap.cpu),
        ramHistory: push(s.ramHistory, snap.rssKb),
        isRusageAvailable: usage.size > 0,
        io: io ? { ...io, joules: (s.io?.joules ?? 0) + energy } : s.io,
        diskHistory: io ? push(s.diskHistory, io.diskRead + io.diskWrite) : s.diskHistory,
        energyHistory: io?.hasEnergy ? push(s.energyHistory, io.watts) : s.energyHistory,
        allWatts: allWatts ?? s.allWatts,
        batteryJoules: s.batteryJoules + (s.isOnBattery ? energy : 0),
        cpuSeconds: s.cpuSeconds + cpuDelta,
        turn,
        ownCpuSeconds: s.ownCpuSeconds + ownDelta,
        ownSince: s.ownSince ?? at,
      }
    })
    if (isPaneOpen && !isNetBusy) void sampleNet($, pids)
  } catch (err) {
    await updateStats($, s => ({ ...s, error: String(err) }))
  }
}

// Lite: CPU, RAM and power of the tree under the known root (no names, no
// other sessions, no disk history). False when the root is gone, so the caller
// takes a full reading instead.
async function sampleSlim($: EngineInterface, snap: Snapshot): Promise<boolean> {
  const { stdout } = await $.process.run(SLIM_PROBE, { env: { LC_ALL: 'C' }, timeoutMs: 5000 })
  const tree = parseSlim(stdout, snap.rootPid)
  if (!tree) return false
  const probe = ioProbe(tree.pids)
  const io$ = await $.process.run(probe.argv, { env: probe.env, timeoutMs: 5000 })
  const usage = parseRusage(io$.stdout)
  const at = await $.clock.now()
  const sinceLast = prevSampleAt === undefined ? 0 : (at - prevSampleAt) / 1000
  prevSampleAt = at
  let io: Io | null = null
  let seconds = 0
  if (prevRusage && usage.size > 0) {
    seconds = (at - prevRusage.at) / 1000
    const { total } = rates(prevRusage.counters, usage, seconds, tree.pids)
    const hasEnergy = [...usage.values()].every(c => (c[2] ?? -1) >= 0)
    io = { diskRead: total[0] ?? 0, diskWrite: total[1] ?? 0, watts: hasEnergy ? (total[2] ?? 0) / 1e9 : 0, hasEnergy, joules: 0 }
  }
  if (usage.size > 0) prevRusage = { at, counters: usage }
  const cpuDelta = (tree.cpu / 100) * sinceLast
  const own = parseTimes(stdout) + parseTimes(io$.stdout)
  const energy = io ? io.watts * seconds : 0
  await updateStats($, s => ({
    ...s,
    io: io ? { ...io, joules: (s.io?.joules ?? 0) + energy } : s.io,
    energyHistory: io?.hasEnergy ? push(s.energyHistory, io.watts) : s.energyHistory,
    batteryJoules: s.batteryJoules + (s.isOnBattery ? energy : 0),
    snapshot: s.snapshot && { ...s.snapshot, cpu: tree.cpu, rssKb: tree.rssKb },
    error: null,
    cpuHistory: push(s.cpuHistory, tree.cpu),
    ramHistory: push(s.ramHistory, tree.rssKb),
    cpuSeconds: s.cpuSeconds + cpuDelta,
    turn: s.turn && {
      ...s.turn,
      seconds: (at - s.turn.startedAt) / 1000,
      joules: s.turn.joules + energy,
      cpuSeconds: s.turn.cpuSeconds + cpuDelta,
      peakCpu: Math.max(s.turn.peakCpu, tree.cpu),
    },
    ownCpuSeconds: s.ownCpuSeconds + own,
    ownSince: s.ownSince ?? at,
  }))
  return true
}

// On battery or AC, about once a minute. Unplugging (or the first look finding
// the Mac on battery) starts the battery count from zero; plugging in pauses it.
async function checkPower($: EngineInterface, at: number) {
  if (lastPowerCheckAt !== undefined && at - lastPowerCheckAt < POWER_CHECK_MS) return
  lastPowerCheckAt = at
  const onBattery = await $.process
    .run(POWER_SOURCE_PROBE, { timeoutMs: 5000 })
    .then(r => parsePowerSource(r.stdout))
    .catch(() => null)
  await updateStats($, s => {
    if (onBattery === s.isOnBattery) return s
    if (onBattery) return { ...s, isOnBattery: true, batteryJoules: 0, batterySince: at }
    return { ...s, isOnBattery: onBattery }
  })
}

async function sampleNet($: EngineInterface, pids: readonly number[]) {
  isNetBusy = true
  try {
    const { stdout } = await $.process.run(NET_PROBE, { timeoutMs: 15000 })
    const counters = parseNettop(stdout)
    const at = await $.clock.now()
    const own = parseTimes(stdout)
    await updateStats($, s => ({ ...s, ownCpuSeconds: s.ownCpuSeconds + own }))
    if (prevNet) {
      const { total } = rates(prevNet.counters, counters, (at - prevNet.at) / 1000, pids)
      const net = { bytesIn: total[0] ?? 0, bytesOut: total[1] ?? 0 }
      await updateStats($, s => ({ ...s, net, netHistory: push(s.netHistory, net.bytesIn + net.bytesOut) }))
    }
    prevNet = { at, counters }
  } catch {
    // Network is a nice-to-have: a failed nettop leaves the last reading
  } finally {
    isNetBusy = false
  }
}

async function syncSampler($: EngineInterface) {
  const isNeeded = isPaneOpen || isTurnRunning || (await read($, isBarOn))
  const ms = MODES[effectiveMode()].ms
  if (isNeeded && timer && timerMs !== ms) {
    timer.cancel()
    timer = undefined
  }
  if (isNeeded && !timer) {
    await sample($, true)
    timer = $.clock.every(ms, () => void sample($))
    timerMs = ms
  } else if (!isNeeded && timer) {
    timer.cancel()
    timer = undefined
    prevSampleAt = undefined
  }
}

// Closes the pane, turns the bar off (remembered), and stops every sampler
async function stopAll($: EngineInterface) {
  isPaneOpen = false
  await $.store.set(BAR_KEY, false)
  await update($, isBarOn, () => false)
  await syncSampler($)
  prevRusage = undefined
  prevNet = undefined
  await $.ui.close({ id: PANE }).catch(() => undefined)
  return 'Session stats stopped: pane closed, bar off, nothing sampling. /session-stats starts it again.'
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Session stats' })
  if (!opened.isPlaced) return `Session stats pane not shown: ${opened.reason}`
  isPaneOpen = true
  await syncSampler($)
  return 'Session stats pane opened.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-stats',
      description:
        'Show live CPU, RAM and processes of this session; "bar" toggles the strip above the prompt, "mode" sets how much the monitor itself costs, "stop" shuts everything off',
      argumentHint: '[bar [on|off|prompt [on|off]] | mode [lite|normal|full] | stop]',
    })
    const isOn = (await $.store.get(BAR_KEY)) === true
    await update($, isBarOn, () => isOn)
    const stored = await $.store.get(MODE_KEY)
    mode = stored === 'normal' || stored === 'full' ? stored : 'lite'
    await update($, modeAtom, () => mode)
    const isPromptOn = (await $.store.get(BAR_PROMPT_KEY)) === true
    await update($, isBarPromptOn, () => isPromptOn)
    const batteryWh = await $.process
      .run(BATTERY_PROBE, { timeoutMs: 5000 })
      .then(r => parseBattery(r.stdout))
      .catch(() => null)
    await updateStats($, s => ({ ...s, batteryWh }))
    // A reload keeps an open pane open but forgets it here; ask, so it keeps updating
    isPaneOpen = await $.ui
      .panes()
      .then(panes => panes.some(pane => pane.id === PANE))
      .catch(() => false)
    await syncSampler($)
    return next(e)
  })

  // A prompt's cost: sample from its submit to its turn's end, whatever is showing
  on('prompt.submit', async ($, e, next) => {
    // A full reading first is the prompt's baseline, so earlier energy isn't counted
    isTurnRunning = true
    if (timer) await sample($, true)
    await syncSampler($)
    const startedAt = await $.clock.now()
    await updateStats($, s => ({ ...s, turn: { startedAt, seconds: 0, joules: 0, cpuSeconds: 0, peakCpu: 0 } }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside the prompt's; only the main loop's ends it
    if (e.agentId !== undefined) return next(e)
    // A full reading at the end, so even lite counts the prompt's whole energy
    await sample($, true)
    const { turn, batteryWh } = await readStats($)
    isTurnRunning = false
    if (turn) {
      const done = { ...turn, seconds: ((await $.clock.now()) - turn.startedAt) / 1000 }
      await updateStats($, s => ({ ...s, turn: null, lastTurn: done }))
      if (done.joules >= TOAST_JOULES) {
        const peak = `peak ${(done.peakCpu / 100).toFixed(1)} cores`
        $.ui.toast(
          batteryWh
            ? `That prompt used ${batteryShare(done.joules, batteryWh)} of your battery (${joules(done.joules)}, ${peak})`
            : `That prompt used ${joules(done.joules)} (${peak})`,
        )
      }
    }
    await syncSampler($)
    return next(e)
  })

  on('command.run', { command: 'session-stats' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'stop' || sub === 'off' || sub === 'kill') return { text: await stopAll($) }
    if (sub === 'mode') {
      const list = (Object.keys(MODES) as Mode[]).map(m => `${m}: ${MODES[m].note}`).join('; ')
      if (!arg) return { text: `Mode ${mode}. ${list}. The pane runs full while it's open.` }
      if (!(Object.keys(MODES) as string[]).includes(arg)) return { text: `Unknown mode "${arg}". ${list}.` }
      mode = arg as Mode
      await $.store.set(MODE_KEY, mode)
      await update($, modeAtom, () => mode)
      await syncSampler($)
      return { text: `Session stats mode ${mode}: ${MODES[mode].note}.` }
    }
    if (sub !== 'bar') return { text: await openPane($) }
    if (arg === 'prompt') {
      const choice = e.args.trim().split(/\s+/)[2]
      const isOn = choice === 'on' ? true : choice === 'off' ? false : !(await read($, isBarPromptOn))
      await $.store.set(BAR_PROMPT_KEY, isOn)
      await update($, isBarPromptOn, () => isOn)
      return { text: `Prompt energy on the bar ${isOn ? 'on' : 'off'}.` }
    }

    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isBarOn))
    await $.store.set(BAR_KEY, isOn)
    await update($, isBarOn, () => isOn)
    await syncSampler($)
    return { text: `Session stats bar ${isOn ? 'on' : 'off'}.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    await syncSampler($)
    return next(e)
  })

  // The strip above the prompt: numbers first, then each history at its full
  // width from the first sample, filling left to right and then scrolling. One
  // Button, so a click anywhere on it opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBarOn))) return next(e)
    lastBarDrawnAt = await $.clock.now()

    const { Button, Text } = $.ui.resolve(e)
    const st = await readStats($)
    const { snapshot: s, cpuHistory, ramHistory, turn, lastTurn, io } = st
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    // Power now, then the battery this session used since the last unplug
    const power = `  ⚡ ${io?.hasEnergy ? watts(io.watts) : '…'}`
    const battery =
      st.isOnBattery && st.batteryWh
        ? `  🔋 ${batteryShare(st.batteryJoules, st.batteryWh)} used`
        : st.isOnBattery === false
          ? '  🔌'
          : ''
    // Optional: the prompt's energy, the one running or else the last one
    const shown = (await read($, isBarPromptOn)) ? (turn ?? lastTurn) : null
    const prompt = shown ? `  ${joules(shown.joules)} ${turn ? 'now' : 'last'}` : ''
    // Emoji draw two cells wide: one more each than their length counts
    const extra = power.length + battery.length + prompt.length + (battery ? 2 : 1)
    // "⚙ CPU 100% " + " " + " RAM 10.0G " + " " is 26 cells around the two histories
    const span = Math.max(6, Math.min(BAR_SPAN, Math.floor((width - 26 - extra) / 2)))
    const cpu = sparkline(cpuHistory.slice(-span))
    const ram = sparkline(ramHistory.slice(-span))

    return (
      <Button key="open-pane" plain onPress={() => void openPane($)}>
        <Text dimColor>⚙ CPU </Text>
        <Text color={cpuColor(s?.cpu ?? 0)}>{(s ? `${s.cpu.toFixed(0)}%` : '…').padStart(4)} </Text>
        <Text color="cyan">{cpu}</Text>
        <Text dimColor>{'·'.repeat(span - cpu.length)}  RAM </Text>
        <Text color={ramColor(s?.rssKb ?? 0)}>{(s ? `${gb(s.rssKb)}G` : '…').padStart(5)} </Text>
        <Text color="magenta">{ram}</Text>
        <Text dimColor>{'·'.repeat(span - ram.length)}</Text>
        <Text color={io?.hasEnergy ? wattsColor(io.watts) : undefined} dimColor={!io?.hasEnergy}>{power}</Text>
        {battery && <Text color={st.isOnBattery ? batteryColor(st.batteryJoules, st.batteryWh) : undefined} dimColor={!st.isOnBattery}>{battery}</Text>}
        {shown && <Text color={joulesColor(shown.joules)}>{prompt}</Text>}
      </Button>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const st = await readStats($)
    const { snapshot: s, error, cpuHistory, ramHistory, io, net, netHistory, diskHistory, energyHistory, isRusageAvailable } = st
    const now = await $.clock.now()
    const chosen = await read($, modeAtom)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const noRusage = isRusageAvailable ? null : 'needs the Xcode Command Line Tools'

    if (!s) return <Text dimColor>{error ?? 'Sampling…'}</Text>

    const machinePct = (s.cpu / s.cores).toFixed(0)
    const ramPct = ((s.rssKb * 1024 * 100) / s.memBytes).toFixed(1)
    const spark = Math.max(10, Math.min(HISTORY, width - 14))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 21)
    const nameCols = Math.max(10, width - 31)
    const pad = (v: string, n: number) => v.padStart(n)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>CPU </Text>
          <Text color={cpuColor(s.cpu)}>{s.cpu.toFixed(0)}%</Text>
          <Text dimColor> ({machinePct}% of {s.cores} cores)</Text>
        </Text>
        <Text color="cyan">{sparkline(cpuHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>RAM </Text>
          <Text color={ramColor(s.rssKb)}>{gb(s.rssKb)} GB</Text>
          <Text dimColor> ({ramPct}% of {gb(s.memBytes / 1024)} GB)</Text>
        </Text>
        <Text color="magenta">{sparkline(ramHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>NET </Text>
          {net ? `↓ ${bytes(net.bytesIn)}/s  ↑ ${bytes(net.bytesOut)}/s` : <Text dimColor>measuring…</Text>}
        </Text>
        <Text color="blue">{sparkline(netHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>DISK </Text>
          {io ? `read ${bytes(io.diskRead)}/s  write ${bytes(io.diskWrite)}/s` : <Text dimColor>{noRusage ?? 'measuring…'}</Text>}
        </Text>
        <Text color="yellow">{sparkline(diskHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>ENERGY </Text>
          {io?.hasEnergy ? `${watts(io.watts)} now` : <Text dimColor>{io ? 'needs macOS 13 or later' : noRusage ?? 'measuring…'}</Text>}
          <Text dimColor> · {batterySummary(st)}</Text>
        </Text>
        <Text color="red">{sparkline(energyHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>PROMPT </Text>
          {promptSummary(st)}
        </Text>
        <Text>
          <Text bold>ALL CLAUDE </Text>
          {s.allClaude
            ? `${s.allClaude.trees} trees · ${st.allWatts === null ? '…' : st.allWatts.toFixed(2)} W · ${s.allClaude.cpu.toFixed(0)}% CPU · ${gb(s.allClaude.rssKb)} GB`
            : '…'}
          {s.allClaude && st.allWatts && io?.hasEnergy ? (
            <Text dimColor> · this session {((io.watts / st.allWatts) * 100).toFixed(0)}% of the power</Text>
          ) : null}
        </Text>
        <Text dimColor>
          mode {chosen}
          {chosen === 'full' ? '' : ' (full while this pane is open)'}
          {st.ownSince !== null && now > st.ownSince
            ? ` · monitor itself: ${((st.ownCpuSeconds / ((now - st.ownSince) / 1000)) * 100).toFixed(1)}% of one core`
            : ''}
        </Text>
        <Text dimColor>
          {s.procs.length} processes · session pid {s.rootPid} up {s.procs[0]?.elapsed} · load {s.load.map(l => l.toFixed(2)).join(' ')}
        </Text>
        <Text> </Text>
        <Text bold>{'  PID  CPU%   MEM     W NAME'}</Text>
        {s.procs.slice(0, room).map(p => (
          <Text>
            {pad(String(p.pid), 5)} {pad(p.cpu.toFixed(1), 5)} {pad(gb(p.rssKb) + 'G', 5)} {pad(p.watts == null ? '–' : p.watts.toFixed(2), 5)}{' '}
            <Text dimColor={p.cpu < 1}>{('  '.repeat(p.depth) + p.name).slice(0, nameCols)}</Text>
          </Text>
        ))}
        {s.procs.length > room && <Text dimColor>…{s.procs.length - room} more</Text>}
        {error && <Text color="red">last sample failed: {error}</Text>}
      </Box>
    )
  })
}
