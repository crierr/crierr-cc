import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheWindow } from '../types'

// In $.state so a reload (e.g. switching mode in /config) keeps the countdown.
const cacheWindow = atom({ plugin: 'cache-timer', key: 'window' } as const, null)
const leftMs = atom({ plugin: 'cache-timer', key: 'leftMs' } as const, null)

type Cfg = { mode: string; ttlMs: number; maxPings: number }

const LEAD_MS = 60_000
const HANDOFF_PATH = '.claude/HANDOFF.md'
const HANDOFF_PROMPT =
  'Write a concise handoff document in markdown for a fresh session to continue this work: ' +
  'goal, current state, key files, decisions made, open questions, and exact next steps. ' +
  'Output only the document.'

let acting = false

export function fmt(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function act($: EngineInterface, cfg: Cfg, w: CacheWindow) {
  acting = true
  try {
    const prompt = cfg.mode === 'keepwarm' ? 'Reply with only: ok' : HANDOFF_PROMPT
    const r = await $.model.fork({ prompt })
    if (!r.isAnswered) {
      $.ui.toast(`${cfg.mode} failed (${r.reason})`)
      return
    }
    // The fork re-read the cached prefix, so the entry's TTL restarted.
    const now = await $.clock.now()
    await update($, cacheWindow, () => ({ lastAt: now, pings: w.pings + 1 }))
    if (cfg.mode === 'auto-handoff') {
      await $.fs.write(HANDOFF_PATH, r.text)
      $.ui.toast(`handoff written to ${HANDOFF_PATH}`)
    }
  } finally {
    acting = false
  }
}

async function tick($: EngineInterface, cfg: Cfg) {
  const w = await read($, cacheWindow)
  // Whole seconds, so an expired or unchanged timer doesn't redraw the band.
  const left = w === null ? null : Math.max(0, Math.ceil((w.lastAt + cfg.ttlMs - (await $.clock.now())) / 1000) * 1000)
  if (left !== (await read($, leftMs))) await update($, leftMs, () => left)
  if (w === null || left === 0) return

  if (cfg.mode !== 'default' && left !== null && left <= LEAD_MS && w.pings < cfg.maxPings && !acting) {
    await act($, cfg, w)
  }
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'default')
  const cfg: Cfg = {
    mode,
    ttlMs: Number(options.ttlSeconds ?? 300) * 1000,
    maxPings: mode === 'auto-handoff' ? 1 : Number(options.maxKeepwarmPings ?? 6),
  }

  on('session.start', ($, e, next) => {
    $.ui.status(undefined) // clears the status line an earlier version pinned
    $.clock.every(1000, () => void tick($, cfg))
    return next(e)
  })

  // Every main-thread model request reads/writes the cache and restarts its TTL.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cacheWindow, () => ({ lastAt: now, pings: 0 }))
    }
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const left = await read($, leftMs)
    if (e.props.hasSurvey || left === null) return next(e)

    const { Text } = $.ui.resolve(e)
    const color = left === 0 ? 'error' : left <= 120_000 ? 'warning' : 'success'
    const tag = cfg.mode === 'default' ? '' : ` [${cfg.mode}]`

    return (
      <Text color={color}>
        ● cache {left === 0 ? 'expired' : fmt(left)}
        <Text dimColor>{tag}</Text>
      </Text>
    )
  })

  on('session.end', async ($, e, next) => {
    await update($, cacheWindow, () => null)
    await update($, leftMs, () => null)
    return next(e)
  })
}
