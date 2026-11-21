export type Diagram = { source: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    mermaid: { diagram: Shaped<Diagram | null> }
  }
}
