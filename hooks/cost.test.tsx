import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FULL_OUT = `500
10
17179869184
{ 1.00 1.00 1.00 }
  500     1  50.0 400000 10:00 claude
  501   500  10.0 100000 09:00 node
0m0.00s 0m0.00s
0m0.01s 0m0.01s
`
const SLIM_OUT = '  500     1  50.0 400000\n  501   500  10.0 100000\n0m0.00s 0m0.00s\n0m0.01s 0m0.01s\n'
const BAR = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
} as const
const run = (args: string) => ({
  command: 'session-stats',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}) as const
const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Counts each probe the mod runs, under a store holding `entries`. The session
// burns 1 J per energy reading; `power.onBattery` is what pmset reports.
const world = (on: On, entries: Record<string, unknown>) => {
  mock.store(on, entries)
  const clock = mock.clock(on, { now: 1_000_000 })
  const calls = { full: 0, slim: 0, energy: 0, net: 0 }
  const power = { onBattery: false }
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    // A tiny 0.12 Wh (432 J) battery, so a few joules read as a clear share
    if (cmd.includes('ioreg')) return ok('"Voltage" = 12000\n"BatteryData" = {"NominalChargeCapacity"=10}\n')
    if (cmd.includes('pmset')) return ok(`Now drawing from '${power.onBattery ? 'Battery' : 'AC'} Power'\n`)
    if (cmd.includes('etime=')) return (calls.full++, ok(FULL_OUT))
    if (cmd.includes('ps -axo pid=,ppid=,pcpu=,rss=;')) return (calls.slim++, ok(SLIM_OUT))
    if (cmd.includes('nettop')) return (calls.net++, ok(''))
    calls.energy++
    return ok(`500 0 0 ${calls.energy * 1e9}\n501 0 0 0\n`)
  })
  on('command.register', (() => ({ value: undefined })) as never)
  on('session.start', (($: never, e: unknown) => e) as never)
  on('prompt.submit', (($: never, e: unknown) => e) as never)
  return { clock, calls, power }
}

test('a session that never draws the bar does not sample for it', async ($, on) => {
  const { clock, calls } = world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  const atStart = { ...calls }
  await clock.advance(60_000)
  expect(calls).toEqual(atStart)
  expect(atStart.full).toBe(1)
})

test('a drawn bar in lite takes the nameless ps and the energy probe every 10 s, and no nettop', async ($, on) => {
  const { clock, calls } = world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  const energyAtStart = calls.energy
  await clock.advance(30_000)
  expect(calls.slim).toBe(3)
  expect(calls.full).toBe(1)
  expect(calls.energy - energyAtStart).toBe(3)
  expect(calls.net).toBe(0)
  await ui.unmount()
})

const drawnText = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('battery used counts only on battery, pauses on AC, and starts over at the next unplug', async ($, on) => {
  const { clock, power } = world(on, { bar: true })
  power.onBattery = true
  await $.session.start({ cwd: '/tmp' } as never)
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  await clock.advance(30_000)
  // 1 J per reading after the first: 3 J of the 432 J battery
  expect(await drawnText(ui)).toContain('🔋 0.69% used')
  expect(await drawnText(ui)).toContain('⚡ 0.10 W')

  power.onBattery = false
  await clock.advance(70_000)
  expect(await drawnText(ui)).toContain('🔌')
  expect(await drawnText(ui)).not.toContain('🔋')

  power.onBattery = true
  await clock.advance(70_000)
  const text = await drawnText(ui)
  expect(text).toContain('🔋')
  expect(text).not.toContain('0.69%')
  await ui.unmount()
})

test('prompt energy shows on the bar only once turned on', async ($, on) => {
  world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  await $.prompt.submit({ text: 'go' } as never)
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  expect(await drawnText(ui)).not.toContain(' now')
  expect((await $.command.run(run('bar prompt on'))).text).toContain('on')
  await ui.unmount()
  const again = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  expect(await drawnText(again)).toContain(' J now')
  await again.unmount()
})

test('mode full is remembered and samples every 2 s with the full probe', async ($, on) => {
  const { clock, calls } = world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  const reply = await $.command.run(run('mode full'))
  expect(reply.text).toContain('mode full')
  const before = calls.full
  await clock.advance(10_000)
  expect(calls.full - before).toBe(5)
  expect(calls.slim).toBe(0)
  expect(calls.net).toBe(0)
  await ui.unmount()
})

test('an unknown mode is refused and changes nothing', async ($, on) => {
  world(on, {})
  const reply = await $.command.run(run('mode turbo'))
  expect(reply.text).toContain('Unknown mode "turbo"')
  expect((await $.command.run(run('mode'))).text).toContain('Mode lite')
})
