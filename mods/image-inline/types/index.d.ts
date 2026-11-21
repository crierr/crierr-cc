/** A PNG ready to draw, or why there is none. `missing`: a local path that leads to no file, drawn as nothing. */
export type Shot = { file: string; width: number; height: number; generation: number; isTemp: boolean } | { error: string } | { missing: true }

declare module 'claude-code' {
  interface PluginState {
    'image-inline': { shots: Shaped<Record<string, Shot>>; allowed: Shaped<Record<string, true>> }
  }
}
