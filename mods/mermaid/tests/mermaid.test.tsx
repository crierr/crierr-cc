import { expect, test } from 'claude-code/testing'
import { fit, lastMermaid } from '../hooks/register'

const PANE = {
  plugin: 'mermaid',
  component: 'Pane',
  requestId: 'mermaid',
  props: { title: 'Mermaid', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const REPLY = ['Here:', '```mermaid', 'flowchart LR', '  A[Start] --> B[End]', '```', 'Done.', '']

test('finds the last mermaid block, open or closed, skipping other fences', async () => {
  expect(lastMermaid(REPLY.join('\n'))).toEqual({ source: 'flowchart LR\n  A[Start] --> B[End]', isDone: true })
  expect(lastMermaid(REPLY.slice(0, 3).join('\n'))).toEqual({ source: 'flowchart LR', isDone: false })
  expect(lastMermaid('````md\n```mermaid\ngraph TD\n```\n````\n')).toBe(null)
  expect(lastMermaid('no diagram')).toBe(null)
})

test('a sideways flowchart too wide for the pane is drawn top to bottom', async () => {
  const src = 'flowchart LR\n  A[Boil water] --> B[Add tea bag to cup]\n  B --> C[Pour water and steep]\n  C --> D[Remove bag and serve]'
  const wide = fit(src, 500)
  expect(wide.isTurned).toBe(false)
  const narrow = fit(src, 60)
  expect(narrow.isTurned).toBe(true)
  expect(narrow.art!.width).toBeLessThanOrEqual(60)
})

test('/mermaid opens the pane, and closes it when it is showing', async ($, on) => {
  const open = new Set<string>()
  on('command.register', () => ({ value: { command: 'mermaid' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => { open.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { open.delete(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // origin and presentation are the engine's to set; the hook reads neither.
  const run = { command: 'mermaid', args: '' } as Parameters<typeof $.command.run>[0]
  expect((await $.command.run(run)).text).toBe('Mermaid pane opened.')
  expect(open.has('mermaid')).toBe(true)
  expect((await $.command.run(run)).text).toBe('Mermaid pane closed.')
  expect(open.has('mermaid')).toBe(false)
})

test('a streamed reply draws its diagram in the pane, on every surface', async ($, on) => {
  let opened = 0
  on('ui.open', () => { opened++; return { value: { isPlaced: true } } })
  on('turn.step', async function* (_$, e) {
    for (const line of REPLY) yield { kind: 'text', index: 0, text: line + '\n' } as const
    return { turnId: e.turnId, index: e.index, answer: REPLY.join('\n'), toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of s);
  expect(opened).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
    expect(await ui.find({ type: 'Text', text: /streaming/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /to close/ }))?.text).toBe('/mermaid to close')
    await ui.unmount()
  }
})

test('with autoOpen off, a streamed diagram is kept but the pane stays shut', { options: { autoOpen: false } }, async ($, on) => {
  let opened = 0
  on('ui.open', () => { opened++; return { value: { isPlaced: true } } })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: REPLY.join('\n') } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 }));
  expect(opened).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  await ui.unmount()
})

test('a diagram wider than the pane shows its source and says so', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: REPLY.join('\n') } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 }));
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 5 } })
  expect((await ui.find({ type: 'Text', text: /widen the pane/ }))?.text).toContain('columns wide')
  await ui.unmount()
})
