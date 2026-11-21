import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Diagram, Picture, Scheme, View } from '../types'
import { render } from './vendor/lovely-mermaid.js'

const PANE = 'mermaid'
const TITLE = 'Mermaid'
const diagram = atom({ plugin: 'mermaid', key: 'diagram' } as const, null as Diagram | null, { shape: 'diagram-1' })
const view = atom({ plugin: 'mermaid', key: 'view' } as const, null as View | null, { shape: 'view-1' })
const picture = atom({ plugin: 'mermaid', key: 'picture' } as const, null as Picture | null, { shape: 'picture-1' })

const OPENER = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/

/** The last ```mermaid block in markdown, closed or still open; other fences hide what they hold. */
export function lastMermaid(text: string): Diagram | null {
  let found: Diagram | null = null
  let fence: { close: RegExp; body: string[] | null } | null = null
  for (const line of text.split('\n')) {
    if (!fence) {
      const [, run = '', lang = ''] = OPENER.exec(line) ?? []
      if (!run) continue
      fence = { close: new RegExp(`^ {0,3}\\${run.charAt(0)}{${run.length},}\\s*$`), body: lang.toLowerCase() === 'mermaid' ? [] : null }
      if (fence.body) found = { source: '', isDone: false }
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
  return found
}

function draw(source: string) {
  try {
    return render(source)
  } catch {
    return null
  }
}

const SIDEWAYS = /^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m

/** The drawing, turned top-to-bottom when a sideways flowchart is too wide for the pane. */
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

/** Cells for a picture: the pane's width, or less where its height would pass `maxRows`. */
export function cells(width: number, height: number, cols: number, maxRows: number) {
  // shortcut: takes a cell as twice as tall as wide; other fonts stretch the picture a little.
  let columns = Math.min(cols, 255)
  let rows = Math.max(1, Math.ceil((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = Math.min(maxRows, 255)
    columns = Math.max(1, Math.min(columns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

// mmdc runs headless Chromium (a second or two) and every run writes the same two files: one at a time.
let queue: Promise<void> = Promise.resolve()

/** Dark or light: the setting, else Claude Code's theme, else (theme auto) macOS's appearance. */
async function scheme($: EngineInterface, setting: string): Promise<Scheme> {
  if (setting === 'dark' || setting === 'light') return setting
  const theme = String((await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value ?? '')
  if (theme.includes('light')) return 'light'
  if (theme.includes('dark')) return 'dark'
  // shortcut: macOS only, and it takes the terminal to follow the system; elsewhere dark. Set Image theme to override.
  const mac = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle']).catch(() => null)
  return mac === null ? 'dark' : mac.stdout.trim() === 'Dark' ? 'dark' : 'light'
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
  const { input, output } = await sessionFiles($, sessionId)
  await $.process.run(['rm', '-f', input, output]).catch(() => undefined)
}

/** Makes the PNG of the finished diagram when the view is image and it has none yet for this scheme. */
function makePicture($: EngineInterface, mmdc: string, defaultView: View, imageTheme: string) {
  return (queue = queue.then(async () => {
    const d = await read($, diagram)
    if (!d?.isDone || ((await read($, view)) ?? defaultView) !== 'image') return
    const look = await scheme($, imageTheme)
    const had = await read($, picture)
    if (had?.source === d.source && had.scheme === look) return
    const source = d.source
    try {
      const { input, output } = await sessionFiles($, await $.session.id())
      await $.fs.write(input, source)
      const run = await $.process.run([mmdc, '-i', input, '-o', output, '-t', look === 'dark' ? 'dark' : 'default', '-b', 'transparent', '-s', '2', '-q'], { timeoutMs: 60_000 })
      if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `${mmdc} exited ${run.exitCode}`)
      const { base64 } = await $.fs.read(output, { as: 'bytes', offset: 16, length: 8 })
      const made: Picture = { source, scheme: look, file: output, ...pngSize(base64), generation: Date.now() }
      await update($, picture, () => made)
    } catch (err) {
      await update($, picture, () => ({ source, scheme: look, error: err instanceof Error ? err.message : String(err) }))
    }
  }))
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const defaultView: View = options.view === 'image' ? 'image' : 'text'
  const mmdc = String(options.mmdc || 'mmdc')
  const imageTheme = String(options.imageTheme ?? 'auto')
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mermaid', description: 'Open or close the Mermaid diagram pane' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await removeFiles($, e.sessionId) // the ending one's: after /clear the process goes on under another id
    return next(e)
  })

  on('command.run', { command: 'mermaid' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Mermaid pane closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE }) // also brings it forward when it's a tab behind another
    void makePicture($, mmdc, defaultView, imageTheme)
    return { text: 'Mermaid pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream // a subagent's replies aren't shown to the person
    let text = ''
    let block = -1
    let shown = ''
    const show = async (upTo: string) => {
      const d = lastMermaid(upTo)
      if (!d || `${d.isDone}${d.source}` === shown) return
      if (!shown && autoOpen) void $.ui.open({ id: PANE, title: TITLE })
      shown = `${d.isDone}${d.source}`
      await update($, diagram, () => d)
    }
    for await (const chunk of stream) {
      yield chunk
      if (chunk.kind !== 'text') continue
      if (block !== -1 && chunk.index !== block) text += '\n'
      block = chunk.index
      text += chunk.text
      // Whole lines only: a half-typed statement would flicker in and out.
      if (chunk.text.includes('\n')) await show(text.slice(0, text.lastIndexOf('\n') + 1))
    }
    await show(text)
    void makePicture($, mmdc, defaultView, imageTheme)
    return stream.result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const d = await read($, diagram)
    const cols = e.props.bodyColumns
    const hint = <Text dimColor>/mermaid to close</Text>
    if (!d)
      return (
        <Box flexDirection="column">
          <Text dimColor>No Mermaid diagram yet.</Text>
          {hint}
        </Box>
      )

    const { art, isTurned } = fit(d.source, cols)
    const fits = art !== null && art.width <= cols
    const text = (
      <Box flexDirection="column">
        {fits ? art.plain.map(line => <Text>{line || ' '}</Text>) : <Text>{d.source}</Text>}
        {!fits && (
          <Text dimColor>
            {art ? `Diagram is ${art.width} columns wide, the pane ${cols}: widen the pane to draw it.` : d.isDone ? "Can't draw this diagram." : 'Waiting for the diagram…'}
          </Text>
        )}
        {fits && isTurned && <Text dimColor>Drawn top to bottom to fit the pane.</Text>}
        {!d.isDone && fits && <Text dimColor>streaming…</Text>}
      </Box>
    )
    // Only the terminal has Image: elsewhere the pane is text alone.
    if (e.surface !== 'terminal')
      return (
        <Box flexDirection="column">
          {text}
          {hint}
        </Box>
      )

    const { Image } = $.ui.resolve(e)
    const mode = (await read($, view)) ?? defaultView
    const pic = mode === 'image' ? await read($, picture) : null
    const toggle = (
      <Button
        key="view"
        hotkey="v"
        label={mode === 'image' ? 'Show text' : 'Show image'}
        onPress={async () => {
          await update($, view, () => (mode === 'image' ? 'text' : 'image'))
          void makePicture($, mmdc, defaultView, imageTheme)
        }}
      />
    )
    if (pic?.source === d.source && 'file' in pic) {
      const { columns, rows } = cells(pic.width, pic.height, cols, Math.max(4, e.props.scroll.bodyRows - 3))
      return (
        <Box flexDirection="column">
          <Image key="diagram" source={{ file: pic.file, format: 'png', generation: pic.generation }} columns={columns} rows={rows} alt="Mermaid diagram (the terminal can't show images here)" />
          {/* A file:// hyperlink: Rex's Quick Look reads it even where the path wraps, and a space off the pane's border, which it reads as part of a bare path. */}
          <Box paddingLeft={1}>
            <Link href={`file://${encodeURI(pic.file)}`} label={pic.file} />
          </Box>
          {toggle}
          {hint}
        </Box>
      )
    }
    const note =
      mode !== 'image' ? null
      : !d.isDone ? 'Image once the diagram is finished.'
      : pic?.source === d.source && 'error' in pic ? `No image: ${pic.error}`
      : 'Making the image…'
    return (
      <Box flexDirection="column">
        {text}
        {note && <Text dimColor>{note}</Text>}
        {toggle}
        {hint}
      </Box>
    )
  })
}
