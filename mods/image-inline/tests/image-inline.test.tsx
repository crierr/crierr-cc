import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cells, findImages, gifDelays, hash, isAnimatedSvg, loopMs, pngSize } from '../hooks/register'

// A PNG's first 24 bytes: signature, IHDR length and type, then 640 by 480.
const HEAD = btoa('\x89PNG\r\n\x1a\n' + String.fromCharCode(0, 0, 0, 13) + 'IHDR' + String.fromCharCode(0, 0, 2, 128, 0, 0, 1, 224))
const JPEG = btoa('\xff\xd8\xff\xe0' + '\0'.repeat(20))

test('finds markdown images, URLs and bare paths, once each, outside fenced code', async () => {
  const text = [
    'See ![chart](out/chart.png "Chart") and https://example.com/a/b.jpg?x=1.',
    'Saved to `/tmp/shot.webp`, also ~/Desktop/pic.GIF and ./logo.png, again out/chart.png.',
    '```sh',
    'convert in.png out.png',
    '```',
    'Not images: notes.txt, image.pngx, http://example.com/page',
  ].join('\n')
  expect(findImages(text)).toEqual(['out/chart.png', 'https://example.com/a/b.jpg?x=1', '/tmp/shot.webp', '~/Desktop/pic.GIF', './logo.png'])
  expect(findImages('logo.svg, photo.AVIF and icon.svgz')).toEqual(['logo.svg', 'photo.AVIF'])
  expect(findImages('a.png then ![b](b.png) then https://x.io/c.png')).toEqual(['a.png', 'b.png', 'https://x.io/c.png'])
  expect(findImages('file:///Users/me/My%20Pic.png')).toEqual(['file:///Users/me/My%20Pic.png'])
})

test('reads a PNG size, refuses other bytes, and fits it to the rows', async () => {
  expect(pngSize(HEAD)).toEqual({ width: 640, height: 480 })
  expect(pngSize(JPEG)).toBe(null)
  expect(cells(640, 480, 200, 20)).toEqual({ columns: 53, rows: 20 })
  expect(cells(160, 80, 200, 20)).toEqual({ columns: 20, rows: 5 })
})

test('tells animated SVGs from still ones, and reads loop lengths and GIF delays', async () => {
  expect(isAnimatedSvg('<svg><circle><animate attributeName="r" dur="2s"/></circle></svg>')).toBe(true)
  expect(isAnimatedSvg('<svg><g><animateTransform type="rotate"/></g></svg>')).toBe(true)
  expect(isAnimatedSvg('<svg><style>@keyframes spin { to { transform: rotate(1turn) } }</style></svg>')).toBe(true)
  expect(isAnimatedSvg('<svg><rect class="animated-ish" width="2"/><settings/></svg>')).toBe(false)
  expect(loopMs('<animate dur="2s"/><animate dur="500ms"/>')).toBe(2000)
  expect(loopMs('<style>.a { animation: spin 3.5s linear infinite }</style>')).toBe(3500)
  expect(loopMs('<animate dur="indefinite"/>')).toBe(2000)
  expect(loopMs('<animate dur="5min"/>')).toBe(10_000)
  expect(gifDelays('5\n0\n1\n12\n')).toEqual([50, 100, 100, 120])
})

type Files = Record<string, string> // path -> first bytes, base64

function world(on: On, files: Files, curl = { exitCode: 0, stdout: 'image/png', stderr: '' }) {
  const argv: string[][] = []
  const writes: Record<string, string> = {}
  on('fs.write', (_$, e) => { writes[e.path] = e.text; return { value: undefined } })
  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? '/tmp-x' : e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.stat', (_$, e) => (e.path in files ? { value: { kind: 'file', size: 100, mtimeMs: 7, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', (_$, e) => ({ value: e.as === 'bytes' ? { base64: files[e.path] ?? '' } : atob(files[e.path] ?? '') }) as never)
  on('process.run', (_$, e) => {
    argv.push([...e.argv])
    const out = e.argv.includes('-o') ? e.argv[e.argv.indexOf('-o') + 1] : e.argv.includes('--out') ? e.argv[e.argv.indexOf('--out') + 1] : undefined
    if (e.argv[0] === 'curl' && out) files[out] = files['web'] ?? HEAD
    if (e.argv[0] === 'sips' && out) files[out] = HEAD
    // magick writing frames: a GIF's are counted by identify below (3), an SVG sheet's by its tiles.
    const pattern = e.argv[0] === 'magick' && e.argv.at(-1)?.includes('%03d') ? e.argv.at(-1)! : undefined
    if (pattern) for (let i = 0; i < (e.argv.includes('-crop') ? 20 : 3); i++) files[pattern.replace('%03d', String(i).padStart(3, '0'))] = HEAD
    if (e.argv[0] === 'mv') files[e.argv[3]!] = files[e.argv[2]!]!
    const stdout = e.argv[1] === 'identify' ? '5\n0\n3\n' : e.argv[0] === 'sh' ? '/x/chrome\n' : ''
    const r = e.argv[0] === 'curl' ? curl : { exitCode: 0, stdout, stderr: '' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { argv, writes }
}

const settle = async () => { for (let i = 0; i < 500; i++) await null }
const reply = (text: string) => ({ plugin: 'image-inline', component: 'AssistantMessage', requestId: 'm1', props: { text, isFirstOfReply: true } }) as const

test('a local PNG named in a reply is drawn under it; a missing one draws nothing', async ($, on) => {
  const { argv } = world(on, { '/proj/out/chart.png': HEAD })
  const ui = await $.ui.mount({ ...reply('Made out/chart.png and gone.png.'), surface: 'terminal' })
  await settle()
  const img = await ui.find({ type: 'Image' })
  expect(img?.props).toMatchObject({ source: { file: '/proj/out/chart.png', format: 'png' } })
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('file:///proj/out/chart.png') // the ↗ icon: a hyperlink for Rex's Quick Look
  await ui.press({ key: `open-${hash('out/chart.png')}` })
  expect(argv.at(-1)).toEqual(['open', '/proj/out/chart.png']) // the open button opens the original
  await ui.press({ key: `copy-${hash('out/chart.png')}` })
  expect(argv.at(-1)?.[0]).toBe('osascript') // ⎘ copy puts the image itself on the clipboard
  expect(argv.at(-1)?.at(-1)).toBe('/proj/out/chart.png')
  expect((await ui.find({ type: 'Text', text: /chart\.png/ }))).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /gone\.png/ }))).toBe(undefined)
  expect(argv.some(a => a[0] === 'sips' || a[0] === 'curl')).toBe(false)
  await ui.unmount()
})

test('an SVG is turned into a PNG with sips too', async ($, on) => {
  const { argv } = world(on, { '/proj/logo.svg': btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>') })
  const ui = await $.ui.mount({ ...reply('See logo.svg'), surface: 'terminal' })
  await settle()
  expect(argv.find(a => a[0] === 'sips')?.slice(0, 5)).toEqual(['sips', '-s', 'format', 'png', '/proj/logo.svg'])
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('a JPEG is turned into a PNG with sips first', async ($, on) => {
  const { argv } = world(on, { '/home/me/pic.jpg': JPEG })
  const ui = await $.ui.mount({ ...reply('Here: ~/pic.jpg'), surface: 'terminal' })
  await settle()
  const out = `/tmp-x/claude-image-inline/s1-${hash('~/pic.jpg')}.png`
  expect(argv.find(a => a[0] === 'sips')).toEqual(['sips', '-s', 'format', 'png', '/home/me/pic.jpg', '--out', out])
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: out } })
  await ui.press({ key: `open-${hash('~/pic.jpg')}` })
  expect(argv.at(-1)).toEqual(['open', '/home/me/pic.jpg']) // the original, not the converted PNG
  await ui.unmount()
})

test('web images wait for Load by default, then are fetched and drawn', async ($, on) => {
  const { argv } = world(on, {})
  const ui = await $.ui.mount({ ...reply('Logo: https://example.com/logo.png'), surface: 'terminal' })
  await settle()
  expect(argv.length).toBe(0)
  const key = `load-${hash('https://example.com/logo.png')}`
  expect((await ui.find({ key }))?.text).toBe('Load image from example.com')
  await ui.press({ key })
  await settle()
  expect(argv[1]?.[0]).toBe('curl')
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.press({ key: `open-${hash('https://example.com/logo.png')}` })
  expect(argv.at(-1)).toEqual(['open', 'https://example.com/logo.png'])
  await ui.unmount()
})

test('a web answer that is not an image says so', { options: { web: 'always' } }, async ($, on) => {
  world(on, {}, { exitCode: 0, stdout: 'text/html; charset=utf-8', stderr: '' })
  const ui = await $.ui.mount({ ...reply('https://example.com/fake.png'), surface: 'terminal' })
  await settle()
  expect((await ui.find({ type: 'Text', text: /No preview/ }))?.text).toBe('No preview: not an image (text/html)')
  await ui.unmount()
})

test('local only never fetches, and other surfaces draw the reply alone', { options: { web: 'local only' } }, async ($, on) => {
  const { argv } = world(on, { '/proj/a.png': HEAD })
  const ui = await $.ui.mount({ ...reply('https://example.com/logo.png'), surface: 'terminal' })
  await settle()
  expect(argv.length).toBe(0)
  expect(await ui.find({ type: 'Button' })).toBe(undefined)
  await ui.unmount()
  const desk = await $.ui.mount({ ...reply('a.png'), surface: 'desktop' })
  await settle()
  expect(await desk.find({ type: 'Image' })).toBe(undefined)
  await desk.unmount()
})

test('at most maxImages per block', { options: { maxImages: 1 } }, async ($, on) => {
  world(on, { '/proj/a.png': HEAD, '/proj/b.png': HEAD })
  const ui = await $.ui.mount({ ...reply('a.png b.png'), surface: 'terminal' })
  await settle()
  expect((await ui.findAll({ type: 'Image' })).length).toBe(1)
  await ui.unmount()
})

const GIF = btoa('GIF89a' + '\0'.repeat(18))

test('an animated GIF is split into frames that play by blit until the Image is gone', async ($, on) => {
  const clock = mock.clock(on)
  const { argv } = world(on, { '/proj/spin.gif': GIF })
  const blits: string[] = []
  let gone = false
  on('ui.blit', (_$, e) => { blits.push((e as { source: { file: string } }).source.file); return { value: gone ? { deny: 'not mounted' } : {} } })
  const ui = await $.ui.mount({ ...reply('Look: spin.gif'), surface: 'terminal' })
  await clock.settle()
  const base = `/tmp-x/claude-image-inline/s1-${hash('spin.gif')}`
  expect(argv.find(a => a[1] === 'identify')).toEqual(['magick', 'identify', '-format', '%T\n', '/proj/spin.gif'])
  expect(argv.find(a => a.includes('-coalesce'))).toEqual(['magick', '/proj/spin.gif', '-coalesce', `${base}-%03d.png`])
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: `${base}-000.png` } })
  await clock.advance(50) // frame 0 shows 50 ms, then 1 (100 ms), then 2 (30 ms)
  expect(blits).toEqual([`${base}-001.png`])
  await clock.advance(100)
  await clock.advance(30)
  expect(blits.slice(1)).toEqual([`${base}-002.png`, `${base}-000.png`])
  gone = true
  await clock.advance(50)
  await clock.advance(1000)
  expect(blits.length).toBe(4)
  await ui.unmount()
})

test('an animated SVG is drawn by one Chrome run into a sheet of frames; a still one is not', async ($, on) => {
  mock.clock(on)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle r="9"><animate attributeName="r" values="9;20;9" dur="1s" repeatCount="indefinite"/></circle><script>alert(1)</script></svg>'
  const { argv, writes } = world(on, { '/proj/orbit.svg': btoa(svg), '/proj/still.svg': btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') })
  const ui = await $.ui.mount({ ...reply('orbit.svg and still.svg'), surface: 'terminal' })
  await ui.find({ type: 'Image' })
  for (let i = 0; i < 20; i++) await null
  const base = `/tmp-x/claude-image-inline/s1-${hash('orbit.svg')}`
  const runs = argv.filter(a => a[0] === '/x/chrome')
  expect(runs.length).toBe(1)
  // HEAD is 640 by 480: scaled to 480 by 360 a frame, 20 frames (1 s at 20 fps) in a 5 by 4 grid.
  expect(runs[0]).toContain('--window-size=2400,1440')
  expect(runs[0]).toContain(`file://${base}.html`)
  const page = writes[`${base}.html`]!
  expect(page.split('<animate ').length - 1).toBe(20)
  expect(page).toMatch(/script-src 'nonce-[^']+'/)
  expect(argv.find(a => a.includes('-crop'))).toEqual(['magick', `${base}.sheet.png`, '-crop', '480x360', '+repage', `${base}-%03d.png`])
  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(i => (i.props.source as { file: string }).file)).toEqual([`${base}-000.png`, `/tmp-x/claude-image-inline/s1-${hash('still.svg')}.png`])
  await ui.unmount()
})
