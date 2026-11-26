export type Diagram = { source: string; isDone: boolean }
export type View = 'text' | 'image'
/** Which mermaid theme to draw with: `theme` when autoSwitch is off, else light or dark as the appearance is. */
export type Themes = { autoSwitch: boolean; light: string; dark: string; theme: string }
/** The PNG mmdc made for `source`, or why it could not. */
export type Picture = { source: string; theme: string; file: string; width: number; height: number; generation: number } | { source: string; theme: string; error: string }

declare module 'claude-code' {
  interface PluginState {
    mermaid: { inline: Shaped<Record<string, Picture>> }
  }
}
