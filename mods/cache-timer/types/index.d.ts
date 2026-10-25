// handedOff: optional, as windows stored before it existed lack it.
export type CacheWindow = { lastAt: number; pings: number; handedOff?: boolean }

declare module 'claude-code' {
  interface PluginState {
    // leftMs: what the band draws; null until the first request.
    // inputAt: last prompt submit; sinceMs: elapsed since it; handoffOn: null until toggled.
    'cache-timer': {
      window: CacheWindow | null
      leftMs: number | null
      inputAt: number | null
      sinceMs: number | null
      handoffOn: boolean | null
    }
  }
}
