import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'

/** Prepared images, by `hash(target)`. */
const shots = atom({ plugin: 'image-inline', key: 'shots' } as const, {} as Record<string, Shot>, { shape: 'shots-1' })
/** Web images the person pressed Load on, by `hash(target)`. */
const allowed = atom({ plugin: 'image-inline', key: 'allowed' } as const, {} as Record<string, true>, { shape: 'allowed-1' })

const EXT = String.raw`\.(?:png|jpe?g|gif|webp|avif|svg)`
const MARKDOWN = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const URL_RE = new RegExp(String.raw`\b(?:https?|file)://[^\s<>()\`'"]+?${EXT}(?:\?[^\s<>()\`'"]*[^\s<>()\`'".,;:!?])?(?=[\s<>()\`'".,;:!?]|$)`, 'gi')
const PATH_RE = new RegExp(String.raw`(?:^|[\s(\`'"])((?:~|\.{1,2})?/?(?:[\w@%+=:,.-]+/)*[\w@%+=:,.-]+${EXT})(?=[\s)\`'".,;:!?]|$)`, 'gim')
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The images markdown names, in order, once each: markdown images, URLs, then bare paths. Fenced code is skipped. */
export function findImages(text: string): string[] {
  const prose: string[] = []
  let fence = ''
  for (const line of text.split('\n')) {
    const run = FENCE.exec(line)?.[1]
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length) fence = ''
    } else if (run) fence = run
    else prose.push(line)
  }
  const body = prose.join('\n')
  // Each pass blanks what it took with as many spaces, so every index stays the text's own.
  const hits: [number, string][] = []
  const blank = (s: string) => ' '.repeat(s.length)
  for (const m of body.matchAll(MARKDOWN)) hits.push([m.index, m[1]!])
  const rest = body.replace(MARKDOWN, blank)
  for (const m of rest.matchAll(URL_RE)) hits.push([m.index, m[0]])
  for (const m of rest.replace(URL_RE, blank).matchAll(PATH_RE)) hits.push([m.index, m[1]!])
  const ends = new RegExp(`${EXT}(?:\\?.*)?$`, 'i')
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map(h => h[1]))].filter(s => ends.test(s))
}

export const isWeb = (target: string) => /^https?:\/\//i.test(target)

/** djb2, base 36: a short stable name for a target. */
export function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Width and height from a PNG's first 24 bytes as base64, or null when they are no PNG. */
export function pngSize(base64: string) {
  const b = atob(base64)
  if (b.length < 24 || b.slice(1, 4) !== 'PNG') return null
  const u32 = (at: number) => ((b.charCodeAt(at) << 24) | (b.charCodeAt(at + 1) << 16) | (b.charCodeAt(at + 2) << 8) | b.charCodeAt(at + 3)) >>> 0
  const size = { width: u32(16), height: u32(20) }
  return size.width && size.height ? size : null
}

/** Cells for a picture: at most `cols` wide and `maxRows` tall, never wider than it was drawn at 2 px a cell. */
export function cells(width: number, height: number, cols: number, maxRows: number) {
  // shortcut: takes a cell as about 8 by 16 px; other fonts stretch the picture a little.
  let columns = Math.max(1, Math.min(cols, 255, Math.ceil(width / 8)))
  let rows = Math.max(1, Math.ceil((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = Math.max(1, Math.min(maxRows, 255))
    columns = Math.max(1, Math.min(columns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

const MAX_BYTES = 20 * 1024 * 1024

async function folder($: EngineInterface) {
  const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  return `${tmp}/claude-image-inline`
}

/** An absolute path for a local target: `file://`, `~` and relative paths resolved. */
async function localPath($: EngineInterface, target: string) {
  let p = target
  if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, '').replace(/[?#].*$/, ''))
  if (p.startsWith('~/')) p = `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}`
  if (!p.startsWith('/')) p = `${(await $.session.cwd()).replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
  return p
}

async function readSize($: EngineInterface, file: string) {
  const { base64 } = await $.fs.read(file, { as: 'bytes', offset: 0, length: 24 })
  return pngSize(base64)
}

/** sips (macOS) turns JPEG, GIF, WebP, AVIF and SVG into PNG; an SVG at its own size, which is all sips draws it at. */
async function toPng($: EngineInterface, from: string, to: string) {
  // shortcut: sips is macOS only; elsewhere only PNG files show. Add ImageMagick when that matters.
  const run = await $.process.run(['sips', '-s', 'format', 'png', from, '--out', to], { timeoutMs: 30_000 })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || 'could not convert to PNG')
}

let queue: Promise<void> = Promise.resolve()

/** Prepares one target's PNG once; the result lands in `shots` and redraws the rows that show it. */
function prepare($: EngineInterface, target: string) {
  const key = hash(target)
  return (queue = queue.then(async () => {
    if ((await read($, shots))[key]) return
    let shot: Shot
    try {
      shot = isWeb(target) ? await fromWeb($, target, key) : await fromDisk($, target, key)
    } catch (err) {
      shot = { error: err instanceof Error ? err.message : String(err) }
    }
    await update($, shots, all => ({ ...all, [key]: shot }))
  }))
}

async function fromDisk($: EngineInterface, target: string, key: string): Promise<Shot> {
  const path = await localPath($, target)
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat || stat.kind !== 'file') return { missing: true }
  if (stat.size > MAX_BYTES) return { error: `larger than ${MAX_BYTES / 1024 / 1024} MB` }
  const size = await readSize($, path)
  if (size) return { file: path, ...size, generation: Math.round(stat.mtimeMs), isTemp: false }
  const out = `${await folder($)}/${await $.session.id()}-${key}.png`
  await $.process.run(['mkdir', '-p', await folder($)])
  await toPng($, path, out)
  return pngFile($, out)
}

async function fromWeb($: EngineInterface, url: string, key: string): Promise<Shot> {
  const dir = await folder($)
  const base = `${dir}/${await $.session.id()}-${key}`
  await $.process.run(['mkdir', '-p', dir])
  // $.http.fetch answers text only, so curl: no cookies, a size and time limit, redirects followed.
  const run = await $.process.run(['curl', '-sSfL', '--proto', '=http,https', '--max-filesize', String(MAX_BYTES), '--max-time', '20', '-o', `${base}.download`, '-w', '%{content_type}', url], { timeoutMs: 30_000 })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `curl exited ${run.exitCode}`)
  const type = run.stdout.trim().toLowerCase()
  if (type && !type.startsWith('image/')) throw new Error(`not an image (${type.split(';')[0]})`)
  if (await readSize($, `${base}.download`)) {
    await $.process.run(['mv', '-f', `${base}.download`, `${base}.png`])
  } else {
    await toPng($, `${base}.download`, `${base}.png`)
    await $.process.run(['rm', '-f', `${base}.download`])
  }
  return pngFile($, `${base}.png`)
}

async function pngFile($: EngineInterface, file: string): Promise<Shot> {
  const size = await readSize($, file)
  if (!size) throw new Error('not a PNG after converting')
  return { file, ...size, generation: Date.now(), isTemp: true }
}

export const register: Register = (on, options) => {
  const web = String(options.web ?? 'ask')
  const maxRows = Math.max(2, Number(options.maxRows) || 20)
  const maxImages = Math.max(1, Number(options.maxImages) || 4)

  on('session.end', async ($, e, next) => {
    const temp = Object.values(await read($, shots)).flatMap(s => ('file' in s && s.isTemp ? [s.file] : []))
    if (temp.length) await $.process.run(['rm', '-f', ...temp]).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    // Only the terminal has Image.
    if (e.surface !== 'terminal') return row
    const targets = findImages(e.props.text).filter(t => web !== 'local only' || !isWeb(t))
    if (!targets.length) return row
    const { Box, Text, Button, Image, Link } = $.ui.resolve(e)
    const [have, ok] = await Promise.all([read($, shots), read($, allowed)])
    const cols = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    const drawn = []
    for (const target of targets) {
      if (drawn.length >= maxImages) break
      const key = hash(target)
      const shot = have[key]
      if (shot && 'missing' in shot) continue
      const label = <Text dimColor>{target}</Text>
      if (!shot && isWeb(target) && web === 'ask' && !ok[key]) {
        drawn.push(
          <Box flexDirection="column">
            {label}
            <Button
              key={`load-${key}`}
              label={`Load image from ${target.replace(/^https?:\/\/([^/]+).*$/i, '$1')}`}
              onPress={async () => {
                await update($, allowed, all => ({ ...all, [key]: true as const }))
                void prepare($, target)
              }}
            />
          </Box>,
        )
        continue
      }
      if (!shot) {
        void prepare($, target)
        // A local path waits silently: most turn out to be files, and one that isn't draws nothing.
        if (isWeb(target)) drawn.push(<Box flexDirection="column">{label}<Text dimColor>Loading image…</Text></Box>)
        continue
      }
      if ('error' in shot) {
        drawn.push(<Box flexDirection="column">{label}<Text dimColor>{`No preview: ${shot.error}`}</Text></Box>)
        continue
      }
      const { columns, rows } = cells(shot.width, shot.height, cols, maxRows)
      // The original, not shot.file: a converted or downloaded PNG is deleted when the session ends.
      const href = isWeb(target) ? target : `file://${encodeURI(await localPath($, target))}`
      drawn.push(
        <Box flexDirection="column">
          <Image key={`img-${key}`} source={{ file: shot.file, format: 'png', generation: shot.generation }} columns={columns} rows={rows} alt={`Image: ${target} (the terminal can't show images here)`} />
          <Link href={href}><Text color="suggestion" underline>open image ↗</Text></Link>
        </Box>,
      )
    }
    if (!drawn.length) return row
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" paddingLeft={2} marginTop={1} gap={1}>
          {drawn}
        </Box>
      </Box>
    )
  })
}
