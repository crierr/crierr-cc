import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheWindow } from '../types'

// In $.state so a reload (e.g. switching mode in /config) keeps the countdown.
const cacheWindow = atom({ plugin: 'cache-timer', key: 'window' } as const, null)
const leftMs = atom({ plugin: 'cache-timer', key: 'leftMs' } as const, null)
const inputAt = atom({ plugin: 'cache-timer', key: 'inputAt' } as const, null)
const sinceMs = atom({ plugin: 'cache-timer', key: 'sinceMs' } as const, null)
const handoffOn = atom({ plugin: 'cache-timer', key: 'handoffOn' } as const, null)

type Cfg = { mode: string; ttlMs: number; maxPings: number }

const BAR = 10

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

export function bar(ms: number, maxMs: number) {
  const n = Math.min(BAR, Math.round((ms / maxMs) * BAR))
  return '█'.repeat(n) + '░'.repeat(BAR - n)
}

// null: not toggled yet, so the configured mode decides.
const isHandoff = async ($: EngineInterface, cfg: Cfg) => (await read($, handoffOn)) ?? cfg.mode === 'auto-handoff'

async function act($: EngineInterface, w: CacheWindow, isPing: boolean) {
  acting = true
  try {
    const prompt = isPing ? 'Reply with only: ok' : HANDOFF_PROMPT
    const r = await $.model.fork({ prompt })
    if (!r.isAnswered) {
      $.ui.toast(`${isPing ? 'keepwarm' : 'handoff'} failed (${r.reason})`)
      return
    }
    // The fork re-read the cached prefix, so the entry's TTL restarted.
    const now = await $.clock.now()
    await update($, cacheWindow, () => ({ lastAt: now, pings: w.pings + (isPing ? 1 : 0), handedOff: w.handedOff || !isPing }))
    if (!isPing) {
      await $.fs.write(HANDOFF_PATH, r.text)
      $.ui.toast(`handoff written to ${HANDOFF_PATH}`)
    }
  } finally {
    acting = false
  }
}

async function tick($: EngineInterface, cfg: Cfg) {
  const w = await read($, cacheWindow)
  const now = await $.clock.now()
  // Whole seconds, so an expired or unchanged timer doesn't redraw the band.
  const left = w === null ? null : Math.max(0, Math.ceil((w.lastAt + cfg.ttlMs - now) / 1000) * 1000)
  if (left !== (await read($, leftMs))) await update($, leftMs, () => left)
  const at = await read($, inputAt)
  // Whole minutes: the band shows no seconds here, so it needn't redraw for them.
  const since = at === null ? null : Math.floor((now - at) / 60_000) * 60_000
  if (since !== (await read($, sinceMs))) await update($, sinceMs, () => since)
  if (w === null || left === 0 || left === null || left > LEAD_MS || acting) return

  if (cfg.mode === 'keepwarm' && w.pings < cfg.maxPings) await act($, w, true)
  else if (!w.handedOff && (await isHandoff($, cfg))) await act($, w, false)
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'default')
  const cfg: Cfg = {
    mode,
    ttlMs: Number(options.ttlSeconds ?? 300) * 1000,
    maxPings: Number(options.maxKeepwarmPings ?? 6),
  }
  // How long keepwarm can hold the cache: the bar's full width.
  const maxMs = cfg.ttlMs * Math.max(1, cfg.maxPings)

  on('session.start', ($, e, next) => {
    $.ui.status(undefined) // clears the status line an earlier version pinned
    $.clock.every(1000, () => void tick($, cfg))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, inputAt, () => now)
    return next(e)
  })

  // Every main-thread model request reads/writes the cache and restarts its TTL.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cacheWindow, () => ({ lastAt: now, pings: 0, handedOff: false }))
    }
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const left = await read($, leftMs)
    if (e.props.hasSurvey || left === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const color = left === 0 ? 'error' : left <= 120_000 ? 'warning' : 'success'
    const since = await read($, sinceMs)
    const isOn = await isHandoff($, cfg)

    return (
      <Box>
        <Text color={color}>● cache {left === 0 ? 'expired' : fmt(left)} </Text>
        {since !== null && <Text dimColor>{bar(since, maxMs)} {since / 60_000}m </Text>}
        <Button key="handoff" label={`handoff: ${isOn ? 'on' : 'off'}`} onPress={() => update($, handoffOn, () => !isOn)} />
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    await update($, cacheWindow, () => null)
    await update($, leftMs, () => null)
    await update($, inputAt, () => null)
    await update($, sinceMs, () => null)
    return next(e)
  })
}
