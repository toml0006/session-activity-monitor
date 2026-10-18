import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A session (pid 500) whose claude process burns 600 J between samples
const PS_OUT = `500
10
17179869184
{ 1.00 1.00 1.00 }
  500     1  50.0 400000 10:00 claude
  501   500  10.0 100000 09:00 node
0m0.00s 0m0.00s
0m0.01s 0m0.01s
`
const TURN = { answer: 'done', durationMs: 2000, isAborted: false, turnId: 't1', reason: 'answer' }
const BATTERY = '"AppleRawMaxCapacity" = 6000\n"Voltage" = 12000\n'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const world = (on: On) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  let samples = 0
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd.includes('ioreg')) return ok(BATTERY)
    if (cmd.includes('ps -axo')) return ok(PS_OUT)
    if (cmd.includes('nettop')) return ok('')
    samples += 1
    return ok(`500 0 0 ${samples * 600e9}\n501 0 0 0\n0m0.00s 0m0.00s\n0m0.01s 0m0.01s\n`)
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined as never }
  })
  on('prompt.submit', (($: never, e: unknown) => e) as never)
  on('turn.complete', (() => ({ text: '' })) as never)
  on('command.register', (() => ({ value: undefined })) as never)
  on('session.start', (($: never, e: { cwd: string }) => e) as never)
  on('ui.render', (($: never, e: never) => h(($ as { ui: { resolve: (e: never) => { Text: never } } }).ui.resolve(e).Text, {}, 'engine')) as never)
  return { clock, toasts }
}

test('a prompt is measured from submit to turn end, and an expensive one raises a toast', async ($, on) => {
  const { clock, toasts } = world(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.prompt.submit({ text: 'build everything' } as never)
  await clock.advance(2000)
  // A subagent finishing inside the prompt does not end it
  await $.turn.complete({ ...TURN, agentId: 'sub-1' } as never)
  expect(toasts.length).toBe(0)
  await $.turn.complete(TURN as never)

  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('600 J')
  expect(toasts[0]).toContain('0.23% of your battery')

  const ui = await $.ui.mount({
    plugin: 'session-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-stats',
    props: { bodyColumns: 90 } as never,
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('last 2s · 600 J (0.23% of battery)')
  expect(drawn).toContain('ALL CLAUDE')
})
