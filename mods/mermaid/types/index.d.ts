export type Diagram = { source: string; isDone: boolean }
export type View = 'text' | 'image'
export type Scheme = 'dark' | 'light'
/** The PNG mmdc made for `source`, or why it could not. */
export type Picture = { source: string; scheme: Scheme; file: string; width: number; height: number; generation: number } | { source: string; scheme: Scheme; error: string }

declare module 'claude-code' {
  interface PluginState {
    mermaid: { diagram: Shaped<Diagram | null>; view: Shaped<View | null>; picture: Shaped<Picture | null> }
  }
}
