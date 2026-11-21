import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cells, fit, lastMermaid, pngSize } from '../hooks/register'

const PANE = {
  plugin: 'mermaid',
  component: 'Pane',
  requestId: 'mermaid',
  props: { title: 'Mermaid', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const PANE_MODE = { options: { placement: 'pane' } }

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

test('a streamed reply draws its diagram in the pane, on every surface', PANE_MODE, async ($, on) => {
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

test('with autoOpen off, a streamed diagram is kept but the pane stays shut', { options: { placement: 'pane', autoOpen: false } }, async ($, on) => {
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

test('a diagram wider than the pane shows its source and says so', PANE_MODE, async ($, on) => {
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

// 640 by 480, as a PNG's IHDR holds them at bytes 16 to 24.
const SIZE = btoa(String.fromCharCode(0, 0, 2, 128, 0, 0, 1, 224))

test('reads a PNG size and fits it to the pane', async () => {
  expect(pngSize(SIZE)).toEqual({ width: 640, height: 480 })
  expect(cells(800, 400, 80, 100)).toEqual({ columns: 80, rows: 20 })
  expect(cells(400, 800, 80, 20)).toEqual({ columns: 20, rows: 20 })
})

function imageWorld(on: On, run = { exitCode: 0, stderr: '' }, theme = 'dark', appearance = '') {
  const argv: string[][] = []
  const writes: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? '/tmp-x/' : undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', (_$, e) => { writes.push(e.path); return { value: undefined } })
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'defaults') return { value: { exitCode: appearance ? 0 : 1, stdout: appearance, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    argv.push([...e.argv])
    return { value: { ...run, stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: SIZE } }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: REPLY.join('\n') } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { argv, writes }
}

// The picture is made after the hook returns: let its queued work run out.
const settle = async () => { for (let i = 0; i < 500; i++) await null }
const stream = async ($: Engine) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 }));
  await settle()
}

test('image view: a finished diagram becomes a PNG drawn in the pane', { options: { placement: 'pane', view: 'image', mmdc: '/bin/mmdc' } }, async ($, on) => {
  const { argv, writes } = imageWorld(on)
  await stream($)
  expect(writes).toEqual(['/tmp-x/claude-mermaid/s1.mmd'])
  expect(argv[0]?.slice(0, 5)).toEqual(['/bin/mmdc', '-i', '/tmp-x/claude-mermaid/s1.mmd', '-o', '/tmp-x/claude-mermaid/s1.png'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /s1\.png/ })).toMatchObject({ props: { href: 'file:///tmp-x/claude-mermaid/s1.png', label: '/tmp-x/claude-mermaid/s1.png' } })
  expect((await ui.find({ key: 'view' }))?.text).toBe('Show text')
  await ui.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ key: 'view' })).toBe(undefined)
  await desk.unmount()
})

test('the button switches text to image, making the picture then', PANE_MODE, async ($, on) => {
  const { argv } = imageWorld(on)
  await stream($)
  expect(argv.length).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'view' }))?.text).toBe('Show image')
  await ui.press({ key: 'view' })
  await settle()
  expect(argv.length).toBe(1)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('an mmdc failure shows the box art and why', { options: { placement: 'pane', view: 'image' } }, async ($, on) => {
  imageWorld(on, { exitCode: 1, stderr: 'Error: no browser' })
  await stream($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No image/ }))?.text).toBe('No image: Error: no browser')
  expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  await ui.unmount()
})

const themeArg = (argv: string[][]) => argv[0]?.[argv[0].indexOf('-t') + 1]

test('image theme follows Claude Code, then macOS when that is auto', { options: { placement: 'pane', view: 'image' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'light-daltonized')
  await stream($)
  expect(themeArg(argv)).toBe('default')
})

test('theme auto with macOS in light mode draws light', { options: { placement: 'pane', view: 'image' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'auto', '')
  await stream($)
  expect(themeArg(argv)).toBe('default')
})

test('theme auto with macOS in dark mode draws dark', { options: { placement: 'pane', view: 'image' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'auto', 'Dark\n')
  await stream($)
  expect(themeArg(argv)).toBe('dark')
})

test('the Image theme setting overrides', { options: { placement: 'pane', view: 'image', imageTheme: 'light' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'dark')
  await stream($)
  expect(themeArg(argv)).toBe('default')
})

const MESSAGE = {
  plugin: 'mermaid',
  component: 'AssistantMessage',
  requestId: 'msg1',
  props: { text: REPLY.join('\n'), isFirstOfReply: true },
} as const

test('inline (the default): box art drawn under the reply, the reply kept; no pane', async ($, on) => {
  let opened = 0
  on('ui.open', () => { opened++; return { value: { isPlaced: true } } })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: REPLY.join('\n') } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 }));
  expect(opened).toBe(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MESSAGE, surface })
    expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
    await ui.unmount()
  }
  const open = await $.ui.mount({ ...MESSAGE, surface: 'terminal', props: { ...MESSAGE.props, text: REPLY.slice(0, 4).join('\n') } })
  expect(await open.find({ type: 'Text', text: /Start/ })).toBe(undefined) // still streaming: nothing drawn yet
  await open.unmount()
})

test('inline image: one PNG per diagram, drawn under the reply', { options: { view: 'image', mmdc: '/bin/mmdc' } }, async ($, on) => {
  const { argv } = imageWorld(on)
  const ui = await $.ui.mount({ ...MESSAGE, surface: 'terminal' })
  await settle()
  expect(argv[0]?.[4]).toMatch(/^\/tmp-x\/claude-mermaid\/s1-[a-z0-9]+\.png$/)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test("a session's files are its own and go when it ends", PANE_MODE, async ($, on) => {
  const { argv } = imageWorld(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.session.end({ reason: 'other', sessionId: 's1' } as Parameters<typeof $.session.end>[0])
  expect(argv).toEqual([['rm', '-f', '/tmp-x/claude-mermaid/s1.mmd', '/tmp-x/claude-mermaid/s1.png']])
})
