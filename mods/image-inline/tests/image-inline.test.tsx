import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cells, findImages, hash, pngSize } from '../hooks/register'

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

type Files = Record<string, string> // path -> first bytes, base64

function world(on: On, files: Files, curl = { exitCode: 0, stdout: 'image/png', stderr: '' }) {
  const argv: string[][] = []
  on('env.get', (_$, e) => ({ value: e.name === 'TMPDIR' ? '/tmp-x' : e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.stat', (_$, e) => (e.path in files ? { value: { kind: 'file', size: 100, mtimeMs: 7, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('fs.read', (_$, e) => ({ value: { base64: files[e.path] ?? '' } }) as never)
  on('process.run', (_$, e) => {
    argv.push([...e.argv])
    const out = e.argv.includes('-o') ? e.argv[e.argv.indexOf('-o') + 1] : e.argv.includes('--out') ? e.argv[e.argv.indexOf('--out') + 1] : undefined
    if (e.argv[0] === 'curl' && out) files[out] = files['web'] ?? HEAD
    if (e.argv[0] === 'sips' && out) files[out] = HEAD
    if (e.argv[0] === 'mv') files[e.argv[3]!] = files[e.argv[2]!]!
    const r = e.argv[0] === 'curl' ? curl : { exitCode: 0, stdout: '', stderr: '' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { argv }
}

const settle = async () => { for (let i = 0; i < 500; i++) await null }
const reply = (text: string) => ({ plugin: 'image-inline', component: 'AssistantMessage', requestId: 'm1', props: { text, isFirstOfReply: true } }) as const

test('a local PNG named in a reply is drawn under it; a missing one draws nothing', async ($, on) => {
  const { argv } = world(on, { '/proj/out/chart.png': HEAD })
  const ui = await $.ui.mount({ ...reply('Made out/chart.png and gone.png.'), surface: 'terminal' })
  await settle()
  const img = await ui.find({ type: 'Image' })
  expect(img?.props).toMatchObject({ source: { file: '/proj/out/chart.png', format: 'png' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///proj/out/chart.png' }, children: [{ props: { underline: true }, children: ['open image ↗'] }] })
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
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('file:///home/me/pic.jpg')
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
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://example.com/logo.png')
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
