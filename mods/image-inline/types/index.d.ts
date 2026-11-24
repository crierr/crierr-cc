/** A PNG ready to draw (with `frames`, the first of an animation's, each shown for `ms`), or why there is none. `missing`: a local path that leads to no file, drawn as nothing. */
export type Shot = { file: string; width: number; height: number; generation: number; isTemp: boolean; frames?: { file: string; ms: number }[] } | { error: string } | { missing: true }

declare module 'claude-code' {
  interface PluginState {
    'image-inline': { shots: Shaped<Record<string, Shot>>; allowed: Shaped<Record<string, true>> }
  }
}
