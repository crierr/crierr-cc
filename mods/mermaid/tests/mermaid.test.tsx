import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cells, fit, hash, mermaidBlocks, mmdFiles, pngSize } from '../hooks/register'

const REPLY = ['Here:', '```mermaid', 'flowchart LR', '  A[Start] --> B[End]', '```', 'Done.', '']

test('finds the mermaid blocks, open or closed, skipping other fences', async () => {
  expect(mermaidBlocks(REPLY.join('\n'))).toEqual([{ source: 'flowchart LR\n  A[Start] --> B[End]', isDone: true }])
  expect(mermaidBlocks(REPLY.slice(0, 3).join('\n'))).toEqual([{ source: 'flowchart LR', isDone: false }])
  expect(mermaidBlocks('````md\n```mermaid\ngraph TD\n```\n````\n')).toEqual([])
  expect(mermaidBlocks('no diagram')).toEqual([])
})

test('a sideways flowchart too wide for the terminal is drawn top to bottom', async () => {
  const src = 'flowchart LR\n  A[Boil water] --> B[Add tea bag to cup]\n  B --> C[Pour water and steep]\n  C --> D[Remove bag and serve]'
  const wide = fit(src, 500)
  expect(wide.isTurned).toBe(false)
  const narrow = fit(src, 60)
  expect(narrow.isTurned).toBe(true)
  expect(narrow.art!.width).toBeLessThanOrEqual(60)
})

// 640 by 480, as a PNG's IHDR holds them at bytes 16 to 24.
const SIZE = btoa(String.fromCharCode(0, 0, 2, 128, 0, 0, 1, 224))

test('reads a PNG size and fits it to the terminal', async () => {
  expect(pngSize(SIZE)).toEqual({ width: 640, height: 480 })
  expect(cells(800, 400, 80, 100, 1)).toEqual({ columns: 80, rows: 20 })
  expect(cells(400, 800, 80, 20, 1)).toEqual({ columns: 20, rows: 20 })
  // density: a small picture keeps its size, a big one still fits the terminal
  expect(cells(320, 160, 80, 100, 16)).toEqual({ columns: 20, rows: 5 })
  expect(cells(3200, 1600, 80, 100, 16)).toEqual({ columns: 80, rows: 20 })
})

function imageWorld(on: On, run = { exitCode: 0, stderr: '' }, theme = 'dark', appearance = '') {
  const argv: string[][] = []
  const writes: string[] = []
  const stdins: (string | undefined)[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? '/tmp-x/' : undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', (_$, e) => { writes.push(e.path); return { value: undefined } })
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'defaults') return { value: { exitCode: appearance ? 0 : 1, stdout: appearance, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    argv.push([...e.argv])
    stdins.push(e.init?.stdin)
    return { value: { ...run, stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: SIZE } }))
  return { argv, writes, stdins }
}

// The picture is made after the hook returns: let its queued work run out.
const settle = async () => { for (let i = 0; i < 500; i++) await null }
const IMAGE = { options: { view: 'image' } }
const themeArg = (argv: string[][]) => argv[0]?.[argv[0].indexOf('-t') + 1]
// Mounts a mermaid fence in image view and lets its PNG be made.
const drawImage = async ($: Engine) => {
  const ui = await $.ui.mount(CODE)
  await settle()
  return ui
}

test('image theme follows Claude Code, then macOS when that is auto', IMAGE, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'light-daltonized')
  await drawImage($)
  expect(themeArg(argv)).toBe('redux-color')
})

test('theme auto with macOS in light mode draws light', IMAGE, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'auto', '')
  await drawImage($)
  expect(themeArg(argv)).toBe('redux-color')
})

test('theme auto with macOS in dark mode draws dark', IMAGE, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'auto', 'Dark\n')
  await drawImage($)
  expect(themeArg(argv)).toBe('redux-dark-color')
})

test('auto switch off: the Image theme setting overrides', { options: { view: 'image', autoSwitch: false, theme: 'forest' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'dark')
  await drawImage($)
  expect(themeArg(argv)).toBe('forest')
})

test('auto switch on: dark draws the Image dark theme', { options: { view: 'image', darkTheme: 'neo-dark' } }, async ($, on) => {
  const { argv } = imageWorld(on, undefined, 'dark')
  await drawImage($)
  expect(themeArg(argv)).toBe('neo-dark')
})

test('/config hides Image theme while auto switch is on, the light and dark ones while it is off', async ($, on) => {
  on('config.set', (_$, e) => ({ value: e.value }))
  on('config.describe', (_$, e) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
  const row = (key: string) => ({ key, label: key, isHidden: false, provider: { plugin: 'mermaid' } }) as never
  const hidden = async (key: string) => (await $.config.describe(row(key))).isHidden
  expect([await hidden('mermaid.theme'), await hidden('mermaid.lightTheme'), await hidden('mermaid.darkTheme')]).toEqual([true, false, false])
  await $.config.set({ key: 'mermaid.autoSwitch', value: false } as never)
  expect([await hidden('mermaid.theme'), await hidden('mermaid.lightTheme'), await hidden('mermaid.darkTheme')]).toEqual([false, true, true])
})

const MESSAGE = {
  plugin: 'mermaid',
  component: 'AssistantMessage',
  requestId: 'msg1',
  props: { text: REPLY.join('\n'), isFirstOfReply: true },
} as const

test('box art drawn under the reply off the terminal, the reply kept', async $ => {
  const desktop = await $.ui.mount({ ...MESSAGE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  await desktop.unmount()
  const under = await $.ui.mount({ ...MESSAGE, surface: 'terminal' })
  expect(await under.find({ type: 'Text', text: /Start/ })).toBe(undefined) // the terminal draws it in the fence's place
  await under.unmount()
})

const CODE = {
  plugin: 'mermaid',
  component: 'CodeBlock',
  requestId: 'code1',
  surface: 'terminal',
  props: { language: 'mermaid', source: REPLY.slice(2, 4).join('\n'), isClosed: true },
} as const

test('inline, terminal: a closed mermaid fence is drawn in its own place, its source hidden', async ($, on) => {
  let copied = ''
  on('ui.copy', (_$, c) => { copied = c.text; return { value: { isCopied: true } } })
  const ui = await $.ui.mount(CODE)
  expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  expect(await ui.find({ type: 'Text', text: /-->/ })).toBe(undefined)
  expect(await ui.find({ type: 'Button', key: `open:${hash(CODE.props.source)}` })).toBe(undefined) // no PNG in text view: nothing to open
  await ui.press({ key: `copy:${hash(CODE.props.source)}` })
  expect(copied).toBe(CODE.props.source) // text view has the copy button too
  await ui.unmount()
  const open = await $.ui.mount({ ...CODE, props: { ...CODE.props, source: '', isClosed: false } })
  expect(await open.find({ type: 'Text', text: /Drawing diagram/ })).toBeDefined()
  await open.unmount()
  const bad = await $.ui.mount({ ...CODE, props: { ...CODE.props, source: 'not a diagram %%%' } })
  expect(await bad.find({ type: 'Text', text: /│/ })).toBe(undefined) // undrawable: the engine's code block, with its source
  await bad.unmount()
})

test('inline image: one PNG per diagram, drawn in the fence', { options: { view: 'image', mmdc: '/bin/mmdc' } }, async ($, on) => {
  let copied = ''
  on('ui.copy', (_$, c) => { copied = c.text; return { value: { isCopied: true } } })
  const { argv, writes, stdins } = imageWorld(on)
  const ui = await drawImage($)
  expect(writes).toEqual(['/tmp-x/claude-mermaid/s1.mmd'])
  // over a pipe, Chrome exits with mmdc: a killed run leaves no orphan browser
  expect(JSON.parse(stdins[0] ?? '')).toEqual({ pipe: true })
  expect(argv[0]?.[4]).toMatch(/^\/tmp-x\/claude-mermaid\/s1-[a-z0-9]+\.png$/)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  const png = argv[0]?.[4]
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(`file://${png}`) // the ↗ icon: a hyperlink for Rex's Quick Look
  await ui.press({ key: `open:${hash(CODE.props.source)}` })
  expect(argv.at(-1)).toEqual(['open', png]) // the open button opens the PNG
  await ui.press({ key: `copy:${hash(CODE.props.source)}` })
  expect(copied).toBe(CODE.props.source) // ⎘ code puts the mermaid source on the clipboard
  await ui.press({ key: `img:${hash(CODE.props.source)}` })
  expect(argv.at(-1)?.[0]).toBe('osascript') // ⎘ img puts the PNG itself there
  expect(argv.at(-1)?.at(-1)).toBe(png)
  await ui.unmount()
})

test('inline image: no taller than the terminal, less room for the prompt', { options: { view: 'image', density: 1 } }, async ($, on) => {
  imageWorld(on)
  const ui = await $.ui.mount({ ...CODE, viewport: { columns: 80, rows: 20 } })
  await settle()
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ rows: 16 })
  await ui.unmount()
})

test('an mmdc failure shows the box art and why', IMAGE, async ($, on) => {
  imageWorld(on, { exitCode: 1, stderr: 'Error: no browser' })
  const ui = await drawImage($)
  expect((await ui.find({ type: 'Text', text: /No image/ }))?.text).toBe('No image: Error: no browser')
  expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  await ui.unmount()
})

test("a session's files are its own and go when it ends", IMAGE, async ($, on) => {
  const { argv } = imageWorld(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const ui = await drawImage($)
  await ui.unmount()
  const png = argv[0]?.[4]
  await $.session.end({ reason: 'other', sessionId: 's1' } as Parameters<typeof $.session.end>[0])
  expect(argv.at(-1)).toEqual(['rm', '-f', '/tmp-x/claude-mermaid/s1.mmd', png])
})

test('finds the .mmd files a reply names, not those in code fences', async () => {
  expect(mmdFiles('See docs/flow.mmd and [seq](./seq.mmd), `~/a.mmd`, file:///x/y.mmd, z.mermaid. Again docs/flow.mmd.')).toEqual(['docs/flow.mmd', './seq.mmd', '~/a.mmd', 'file:///x/y.mmd', 'z.mermaid'])
  expect(mmdFiles('```\ncat flow.mmd\n```\nflow.mmdx notes.md')).toEqual([])
})

test('inline: a .mmd file the reply names is drawn under it; a missing one is not', async ($, on) => {
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', (_$, e) => (e.path === '/proj/docs/flow.mmd' ? { value: 'flowchart LR\n  A[Start] --> B[End]' } : { deny: 'ENOENT' }))
  const props = (text: string) => ({ ...MESSAGE, surface: 'terminal' as const, props: { ...MESSAGE.props, text } })
  const ui = await $.ui.mount(props('I wrote docs/flow.mmd.'))
  expect((await ui.find({ type: 'Text', text: /Start/ }))?.text).toContain('│')
  await ui.unmount()
  const both = await $.ui.mount(props('I wrote docs/flow.mmd:\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n'))
  expect((await both.findAll({ type: 'Text', text: /Start/ })).length).toBe(0) // its fence draws it in place
  await both.unmount()
  const none = await $.ui.mount(props('I wrote docs/gone.mmd.'))
  expect(await none.find({ type: 'Text', text: /Start/ })).toBe(undefined)
  await none.unmount()
})
