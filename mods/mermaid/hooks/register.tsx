import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Diagram, Picture, Themes, View } from '../types'
import { render } from './vendor/lovely-mermaid.js'

/** The PNGs, one per diagram source, by `hash(source)`. */
const inline = atom({ plugin: 'mermaid', key: 'inline' } as const, {} as Record<string, Picture>, { shape: 'inline-1' })

const OPENER = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/

/** Every ```mermaid block in markdown, the last maybe still open; other fences hide what they hold. */
export function mermaidBlocks(text: string): Diagram[] {
  const all: Diagram[] = []
  let found: Diagram | null = null
  let fence: { close: RegExp; body: string[] | null } | null = null
  for (const line of text.split('\n')) {
    if (!fence) {
      const [, run = '', lang = ''] = OPENER.exec(line) ?? []
      if (!run) continue
      fence = { close: new RegExp(`^ {0,3}\\${run.charAt(0)}{${run.length},}\\s*$`), body: lang.toLowerCase() === 'mermaid' ? [] : null }
      if (fence.body) all.push((found = { source: '', isDone: false }))
      continue
    }
    if (fence.close.test(line)) {
      if (fence.body && found) found.isDone = true
      fence = null
    } else if (fence.body && found) {
      fence.body.push(line)
      found.source = fence.body.join('\n')
    }
  }
  return all
}

// As image-inline finds image paths: a bare, quoted, backticked or linked path, or a file:// URL.
const MMD_RE = /(?:^|[\s(`'"])((?:file:\/\/)?(?:~|\.{1,2})?\/?(?:[\w@%+=:,.-]+\/)*[\w@%+=:,.-]+\.(?:mmd|mermaid))(?=[\s)`'".,;:!?]|$)/gim

/** The .mmd and .mermaid files a reply names outside fenced code, in order, once each. */
export function mmdFiles(text: string): string[] {
  const prose: string[] = []
  let fence = ''
  for (const line of text.split('\n')) {
    const run = OPENER.exec(line)?.[1]
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length) fence = ''
    } else if (run) fence = run
    else prose.push(line)
  }
  return [...new Set([...prose.join('\n').matchAll(MMD_RE)].map(m => m[1]!))]
}

/** A named .mmd file's source, `file://`, `~` and relative paths resolved; null when it can't be read. */
async function mmdSource($: EngineInterface, target: string) {
  let p = target
  if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, ''))
  if (p.startsWith('~/')) p = `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}`
  if (!p.startsWith('/')) p = `${(await $.session.cwd()).replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
  const source = await $.fs.read(p).catch(() => null)
  return source?.trim() ? source.trimEnd() : null
}

/** The diagrams a finished reply shows: its mermaid blocks, then the .mmd files it names. */
async function replyDiagrams($: EngineInterface, text: string) {
  const blocks = mermaidBlocks(text).filter(d => d.isDone && d.source.trim()).map(d => d.source.trimEnd())
  const files = await Promise.all(mmdFiles(text).map(f => mmdSource($, f)))
  return [...new Set([...blocks, ...files.filter(s => s !== null)])] // a file the reply also quotes in a block is drawn once
}

/** A short stable name for a source (djb2), for its PNG's file and key. */
export function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function draw(source: string) {
  try {
    return render(source)
  } catch {
    return null
  }
}

const SIDEWAYS = /^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m

/** The drawing, turned top-to-bottom when a sideways flowchart is too wide for the terminal. */
export function fit(source: string, cols: number) {
  const art = draw(source)
  if (!art || art.width <= cols || !SIDEWAYS.test(source)) return { art, isTurned: false }
  const down = draw(source.replace(SIDEWAYS, '$1TD'))
  return down && down.width <= cols ? { art: down, isTurned: true } : { art, isTurned: false }
}

/** Width and height from a PNG's IHDR, read off bytes 16 to 24 given as base64. */
export function pngSize(base64: string) {
  const b = atob(base64)
  const u32 = (at: number) => ((b.charCodeAt(at) << 24) | (b.charCodeAt(at + 1) << 16) | (b.charCodeAt(at + 2) << 8) | b.charCodeAt(at + 3)) >>> 0
  return { width: u32(0), height: u32(4) }
}

/** Cells for a picture: one column per `density` pixels, at most the terminal's width, and less where its height would pass `maxRows`. */
export function cells(width: number, height: number, cols: number, maxRows: number, density: number) {
  // shortcut: takes a cell as twice as tall as wide; other fonts stretch the picture a little.
  let columns = Math.max(1, Math.min(cols, 255, Math.ceil(width / density)))
  let rows = Math.max(1, Math.ceil((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = Math.min(maxRows, 255)
    columns = Math.max(1, Math.min(columns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

// mmdc runs headless Chromium (a second or two) and every run writes the same two files: one at a time.
let queue: Promise<void> = Promise.resolve()

/** The mermaid theme: the fixed one, else the light or dark one as Claude Code's theme says, else (theme auto) as macOS's appearance is. */
async function mermaidTheme($: EngineInterface, t: Themes): Promise<string> {
  if (!t.autoSwitch) return t.theme
  const theme = String((await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value ?? '')
  if (theme.includes('light')) return t.light
  if (theme.includes('dark')) return t.dark
  // shortcut: macOS only, and it takes the terminal to follow the system; elsewhere dark. Turn auto switch off to override.
  const mac = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle']).catch(() => null)
  return mac === null || mac.stdout.trim() === 'Dark' ? t.dark : t.light
}

/** Where the pictures go: throwaway files, so the temp folder, which the OS clears of any a crash leaves. */
async function folder($: EngineInterface) {
  const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  return `${tmp}/claude-mermaid`
}

/** One session's source and PNG: every session shares the folder. */
async function sessionFiles($: EngineInterface, sessionId: string) {
  const base = `${await folder($)}/${sessionId}`
  return { input: `${base}.mmd`, output: `${base}.png` }
}

async function removeFiles($: EngineInterface, sessionId: string) {
  const { input } = await sessionFiles($, sessionId)
  const pngs = Object.values(await read($, inline)).flatMap(p => ('file' in p ? [p.file] : []))
  await $.process.run(['rm', '-f', input, ...pngs]).catch(() => undefined)
}

// puppeteer starts Chrome in its own process group, so a SIGKILLed mmdc (the timeout's last resort, or Claude Code going)
// orphans it; over a pipe instead of a socket, Chrome exits when mmdc's end closes. On stdin, not a file: a shared
// temp folder (no TMPDIR) would let another user swap in launch options, executablePath included.
const PUPPETEER = JSON.stringify({ pipe: true })

/** Runs mmdc on `source` into `output`: the picture, or why there is none. */
async function mmdcPicture($: EngineInterface, mmdc: string, source: string, look: string, input: string, output: string): Promise<Picture> {
  try {
    await $.fs.write(input, source)
    const run = await $.process.run([mmdc, '-i', input, '-o', output, '-p', '/dev/stdin', '-t', look, '-b', 'transparent', '-s', '2', '-q'], { stdin: PUPPETEER, timeoutMs: 60_000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `${mmdc} exited ${run.exitCode}`)
    const { base64 } = await $.fs.read(output, { as: 'bytes', offset: 16, length: 8 })
    return { source, theme: look, file: output, ...pngSize(base64), generation: Date.now() }
  } catch (err) {
    return { source, theme: look, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Makes the PNG of one inline diagram, unless it has one (or an error) already. */
function makeInline($: EngineInterface, mmdc: string, themes: Themes, source: string) {
  const key = hash(source)
  return (queue = queue.then(async () => {
    // shortcut: a theme change keeps the PNGs already made; new diagrams take the new theme.
    if ((await read($, inline))[key]?.source === source) return
    const { input, output } = await sessionFiles($, await $.session.id())
    const made = await mmdcPicture($, mmdc, source, await mermaidTheme($, themes), input, output.replace(/\.png$/, `-${key}.png`))
    await update($, inline, all => ({ ...all, [key]: made }))
  }))
}

/** Puts a PNG on the clipboard of the machine Claude Code runs on: osascript on macOS, else wl-copy or xclip; the toast says how it went. */
async function copyImage($: EngineInterface, png: string) {
  // The path goes in as an argument, never into the script's text.
  const mac = ['osascript', '-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', '-e', 'end run', png]
  const linux = ['sh', '-c', 'wl-copy --type image/png < "$1" 2>/dev/null || xclip -selection clipboard -t image/png -i "$1"', 'sh', png]
  const run = await $.process.run(mac).catch(() => $.process.run(linux)).catch((err: unknown) => ({ exitCode: 1, stderr: String(err) }))
  $.ui.toast(run.exitCode === 0 ? 'Image copied' : `Couldn't copy the image: ${run.stderr.trim().split('\n').pop() || `exit ${run.exitCode}`}`)
}

/** One diagram's drawing: the PNG in image view once made, else box art; null when box art can't be drawn or is too wide. */
async function drawOne($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0] & { viewport?: { columns: number; rows: number } }, source: string, o: { view: View; density: number; mmdc: string; themes: Themes }) {
  const { view, density, mmdc, themes } = o
  const { Box, Text, Button } = $.ui.resolve(e)
  const copyButton = (
    <Button
      key={`copy:${hash(source)}`}
      label="code"
      plain
      dimColor
      onPress={async () => {
        const done = await $.ui.copy({ text: source, surface: e.surface })
        $.ui.toast(done.isCopied ? 'Mermaid source copied' : `Couldn't copy: ${done.reason}`)
      }}
    >
      <Text color="suggestion">⎘</Text> code
    </Button>
  )
  const cols = Math.max(20, (e.viewport?.columns ?? 80) - 2)
  const isImage = e.surface === 'terminal' && view === 'image'
  const pic = isImage ? (await read($, inline))[hash(source)] : undefined
  if (pic && 'file' in pic && e.surface === 'terminal') {
    const file = pic.file
    const { Image, Link } = $.ui.resolve(e)
    // The icon is a file:// hyperlink, so Rex's Quick Look previews the PNG; the word is the button.
    const openButton = (
      <Box>
      <Link href={`file://${encodeURI(file)}`}><Text color="suggestion">↗</Text></Link>
      <Button
        key={`open:${hash(source)}`}
        label="open"
        plain
        dimColor
        onPress={async () => {
          // macOS's open, else Linux's xdg-open: the PNG in the person's image viewer.
          const run = await $.process.run(['open', file]).catch(() => $.process.run(['xdg-open', file])).catch((err: unknown) => ({ exitCode: 1, stderr: String(err) }))
          if (run.exitCode !== 0) $.ui.toast(`Couldn't open the image: ${run.stderr.trim() || `exit ${run.exitCode}`}`)
        }}
      >
        {' open'}
      </Button>
      </Box>
    )
    const { columns, rows } = cells(pic.width, pic.height, cols, Math.max(4, Math.floor((e.viewport?.rows ?? 38) * 0.8)), density) // 80% of the terminal: the rest for the link, prompt, status line and spinner
    return (
      <Box flexDirection="column">
        <Image source={{ file: pic.file, format: 'png', generation: pic.generation }} columns={columns} rows={rows} alt="Mermaid diagram (the terminal can't show images here)" />
        <Box gap={2}>
          {openButton}
          {copyButton}
          <Button key={`img:${hash(source)}`} label="img" plain dimColor onPress={() => copyImage($, file)}>
            <Text color="suggestion">⎘</Text> img
          </Button>
        </Box>
      </Box>
    )
  }
  if (isImage && !pic) void makeInline($, mmdc, themes, source)
  const { art } = fit(source, cols)
  if (!art || art.width > cols) return null
  return (
    <Box flexDirection="column">
      {art.plain.map(line => <Text>{line || ' '}</Text>)}
      {isImage ? <Box gap={2}><Text dimColor>{pic && 'error' in pic ? `No image: ${pic.error}` : 'Making the image…'}</Text>{copyButton}</Box> : copyButton}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const view: View = options.view === 'image' ? 'image' : 'text'
  const mmdc = String(options.mmdc || 'mmdc')
  const density = Math.max(1, Number(options.density) || 16)
  const themes: Themes = {
    autoSwitch: options.autoSwitch !== false,
    light: String(options.lightTheme || 'redux-color'),
    dark: String(options.darkTheme || 'redux-dark-color'),
    theme: String(options.theme || 'default'),
  }
  // /config shows Image theme only with auto switch off, the light and dark ones only with it on; the toggle redraws the menu.
  on('config.describe', { key: 'mermaid.theme' }, async ($, e, next) => next({ ...e, isHidden: themes.autoSwitch }))
  for (const key of ['mermaid.lightTheme', 'mermaid.darkTheme']) on('config.describe', { key }, async ($, e, next) => next({ ...e, isHidden: !themes.autoSwitch }))
  on('config.set', { key: 'mermaid.autoSwitch' }, async ($, e, next) => {
    const done = await next(e)
    if (!done.deny) {
      themes.autoSwitch = done.value !== false
      await $.ui.invalidate('config.describe')
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    await removeFiles($, e.sessionId) // the ending one's: after /clear the process goes on under another id
    return next(e)
  })

  const drawing = { view, density, mmdc, themes }
  // Terminal: a closed mermaid fence draws its diagram in its own place, the source hidden; one it can't draw shows its source.
  on('ui.render', { component: 'CodeBlock' }, async ($, e, next) => {
    if (e.props.language !== 'mermaid') return next(e)
    const { Text } = $.ui.resolve(e)
    if (!e.props.isClosed) return <Text dimColor>Drawing diagram…</Text>
    const source = e.props.source.trimEnd()
    if (!source.trim()) return next(e)
    return (await drawOne($, e, source, drawing)) ?? next(e)
  })

  // The .mmd files a reply names drawn under its block (and, off the terminal, where CodeBlock isn't raised, its mermaid blocks); the stored reply keeps its source.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    const all = await replyDiagrams($, e.props.text)
    const inPlace = new Set(e.surface === 'terminal' ? mermaidBlocks(e.props.text).map(d => d.source.trimEnd()) : [])
    const done = all.filter(s => !inPlace.has(s))
    if (!done.length) return row
    const { Box, Text } = $.ui.resolve(e)
    const drawn = await Promise.all(done.map(async (source, i) => <Box key={`d${i}`}>{(await drawOne($, e, source, drawing)) ?? <Text dimColor>{fit(source, 9999).art ? 'Diagram too wide to draw here.' : "Can't draw this diagram."}</Text>}</Box>))
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
