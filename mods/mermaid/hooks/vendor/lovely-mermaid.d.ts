// lovely-mermaid 0.3.3 (Apache-2.0), bundled by `bun build`; only what register.ts uses.
export interface MermaidArt { plain: string[]; width: number; warnings: string[] }
export declare function render(src: string): MermaidArt | null
