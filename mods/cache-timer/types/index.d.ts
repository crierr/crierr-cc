export type CacheWindow = { lastAt: number; pings: number }

declare module 'claude-code' {
  interface PluginState {
    // leftMs: what the band draws; null until the first request.
    'cache-timer': { window: CacheWindow | null; leftMs: number | null }
  }
}
