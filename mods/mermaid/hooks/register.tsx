import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Diagram } from '../types'
import { render } from './vendor/lovely-mermaid.js'

const PANE = 'mermaid'
const TITLE = 'Mermaid'
const diagram = atom({ plugin: 'mermaid', key: 'diagram' } as const, null as Diagram | null, { shape: 'diagram-1' })

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

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mermaid', description: 'Open or close the Mermaid diagram pane' })
    return next(e)
  })

  on('command.run', { command: 'mermaid' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Mermaid pane closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE }) // also brings it forward when it's a tab behind another
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
    return stream.result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, diagram)
    const hint = <Text dimColor>/mermaid to close</Text>
    if (!d)
      return (
        <Box flexDirection="column">
          <Text dimColor>No Mermaid diagram yet.</Text>
          {hint}
        </Box>
      )
    const cols = e.props.bodyColumns
    const { art, isTurned } = fit(d.source, cols)
    const fits = art !== null && art.width <= cols
    return (
      <Box flexDirection="column">
        {fits ? art.plain.map(line => <Text>{line || ' '}</Text>) : <Text>{d.source}</Text>}
        {!fits && (
          <Text dimColor>
            {art ? `Diagram is ${art.width} columns wide, the pane ${cols}: widen the pane to draw it.` : d.isDone ? "Can't draw this diagram." : 'Waiting for the diagram…'}
          </Text>
        )}
        {fits && isTurned && <Text dimColor>Drawn top to bottom to fit the pane.</Text>}
        {!d.isDone && fits && <Text dimColor>streaming…</Text>}
        {hint}
      </Box>
    )
  })
}
