import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function bottom(on: On) {
  const status: (string | undefined)[] = []
  const forks: string[] = []
  const writes: string[] = []
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.status', (_$, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement) // the engine's own (empty) band
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: '# Handoff', usage } }
  })
  on('fs.write', (_$, e) => { writes.push(e.path); return { value: undefined } })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return { status, forks, writes, toasts }
}

async function step($: Engine) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of s);
}

const BAND = {
  plugin: 'cache-timer',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// The band's "ago" text (plus the expired note), or undefined when it draws nothing of its own.
async function band($: Engine) {
  const ui = await $.ui.mount(BAND)
  const ago = await ui.find({ type: 'Text', text: /ago/ })
  const expired = await ui.find({ type: 'Text', text: /expired/ })
  await ui.unmount()
  return ago && [ago.text, expired?.text].filter(Boolean).join('').trim()
}

const start = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

test('default: counts down, then expires, never forks', async ($, on) => {
  const clock = mock.clock(on)
  const b = bottom(on)
  await start($)
  expect(await band($)).toBeUndefined()
  await $.prompt.submit({ text: 'hi', asUser: true })
  await step($)
  await clock.advance(60_000)
  expect(await band($)).toBe('1 minute ago')
  for (let i = 0; i < 6; i++) await clock.advance(i ? 6000_000 : 5940_000) // advance caps at 10000 ticks
  expect(await band($)).toBe('600 minutes ago (cache expired)')
  expect(b.forks.length).toBe(0)
})

test('keepwarm: pings 1 min before, up to the cap', { options: { mode: 'keepwarm', maxKeepwarmPings: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  const b = bottom(on)
  await start($)
  await $.prompt.submit({ text: 'hi', asUser: true })
  await step($)
  await clock.advance(239_000)
  expect(b.forks.length).toBe(0)
  await clock.advance(1000)
  expect(b.forks.length).toBe(1)
  await clock.advance(240_000)
  expect(b.forks.length).toBe(2)
  await clock.advance(600_000)
  expect(b.forks.length).toBe(2)
  expect(await band($)).toBe('18 minutes ago (cache expired)')
})

test('auto-handoff: writes once', { options: { mode: 'auto-handoff' } }, async ($, on) => {
  const clock = mock.clock(on)
  const b = bottom(on)
  await start($)
  await step($)
  await clock.advance(900_000)
  expect(b.writes.length).toBe(1)
  expect(b.writes[0]?.endsWith('/.claude/HANDOFF.md')).toBe(true)
})

test('bar: elapsed since input over ttl x max pings', { options: { mode: 'keepwarm', maxKeepwarmPings: 12 } }, async ($, on) => {
  const clock = mock.clock(on)
  bottom(on)
  await start($)
  await $.prompt.submit({ text: 'hi', asUser: true })
  await step($)
  await clock.advance(30 * 60_000) // half of 12 x 5m
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /░/ }))?.text?.trim()).toBe('███░░')
  await ui.unmount()
})

test('handoff button: off by default, on writes once', async ($, on) => {
  const clock = mock.clock(on)
  const b = bottom(on)
  await start($)
  await $.prompt.submit({ text: 'hi', asUser: true })
  await step($)
  await clock.advance(1000)
  let ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'handoff' }))?.text).toBe('🔁')
  await ui.unmount()
  await clock.advance(900_000)
  expect(b.writes.length).toBe(0)
  await step($) // fresh cache: the button is hidden once expired
  await clock.advance(1000)
  ui = await $.ui.mount(BAND)
  await ui.press({ key: 'handoff' })
  expect(b.toasts.at(-1)).toMatch(/^auto-handoff on/)
  expect((await ui.find({ key: 'handoff' }))?.text).toBe('->✏️')
  await ui.unmount()
  await clock.advance(900_000)
  expect(b.writes.length).toBe(1)
})
