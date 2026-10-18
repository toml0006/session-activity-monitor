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

// Counts each probe the mod runs, under a store holding `entries`
const world = (on: On, entries: Record<string, unknown>) => {
  mock.store(on, entries)
  const clock = mock.clock(on, { now: 1_000_000 })
  const calls = { full: 0, slim: 0, energy: 0, net: 0 }
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.includes('ioreg')) return ok('')
    if (cmd.includes('etime=')) return (calls.full++, ok(FULL_OUT))
    if (cmd.includes('ps -axo pid=,ppid=,pcpu=,rss=;')) return (calls.slim++, ok(SLIM_OUT))
    if (cmd.includes('nettop')) return (calls.net++, ok(''))
    calls.energy++
    return ok(`500 0 0 ${calls.energy * 1e9}\n501 0 0 0\n`)
  })
  on('command.register', (() => ({ value: undefined })) as never)
  on('session.start', (($: never, e: unknown) => e) as never)
  return { clock, calls }
}

test('a session that never draws the bar does not sample for it', async ($, on) => {
  const { clock, calls } = world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  const atStart = { ...calls }
  await clock.advance(60_000)
  expect(calls).toEqual(atStart)
  expect(atStart.full).toBe(1)
})

test('a drawn bar in lite takes the nameless ps every 10 s and no energy probe', async ($, on) => {
  const { clock, calls } = world(on, { bar: true })
  await $.session.start({ cwd: '/tmp' } as never)
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  const energyAtStart = calls.energy
  await clock.advance(30_000)
  expect(calls.slim).toBe(3)
  expect(calls.full).toBe(1)
  expect(calls.energy).toBe(energyAtStart)
  expect(calls.net).toBe(0)
  await ui.unmount()
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
