export type Proc = {
  pid: number
  ppid: number
  depth: number
  cpu: number
  rssKb: number
  elapsed: string
  name: string
  /** Average power over the last sample, in watts; null until two samples */
  watts: number | null
}

/** Every Claude process tree on the machine, this session's included */
export type AllClaude = { trees: number; cpu: number; rssKb: number; pids: number[] }

export type Snapshot = {
  rootPid: number
  rootName: string
  allClaude: AllClaude
  cores: number
  memBytes: number
  load: number[]
  cpu: number
  rssKb: number
  procs: Proc[]
}

/** Rates over the last sample, per second, for the whole tree */
export type Io = {
  /** Disk bytes read and written per second, and watts; null without rusage */
  diskRead: number
  diskWrite: number
  watts: number
  /** False before macOS 13, where per-process energy is not reported */
  hasEnergy: boolean
  /** Energy since the pane or bar started sampling, in joules */
  joules: number
}

export type Net = { bytesIn: number; bytesOut: number }

/** One prompt, from its submit to its turn's end */
export type Turn = {
  /** Clock time it started, in ms */
  startedAt: number
  seconds: number
  /** Energy the session's tree used, in joules */
  joules: number
  /** CPU time the session's tree used, in seconds */
  cpuSeconds: number
  /** Highest CPU % sampled during it (100 = one core) */
  peakCpu: number
}

export type Stats = {
  snapshot: Snapshot | null
  error: string | null
  cpuHistory: number[]
  ramHistory: number[]
  /** null until two rusage samples; also null where rusage is unavailable */
  io: Io | null
  isRusageAvailable: boolean
  /** null until two nettop samples */
  net: Net | null
  netHistory: number[]
  diskHistory: number[]
  energyHistory: number[]
  /** Power of every Claude tree on the machine, in watts; null until two samples */
  allWatts: number | null
  /** Running totals for the session's tree since sampling began */
  cpuSeconds: number
  /** The prompt running now (its totals so far) and the last one that finished */
  turn: Turn | null
  lastTurn: Turn | null
  /** Full battery in Wh; null on a Mac without one */
  batteryWh: number | null
  /** CPU seconds the monitor's own probes used, and since when (clock ms) */
  ownCpuSeconds: number
  ownSince: number | null
}

/** How much the monitor itself may cost: lite every 10 s, normal 5 s, full 2 s */
export type Mode = 'lite' | 'normal' | 'full'

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: Stats; isBarOn: boolean; mode: Mode }
  }
}
