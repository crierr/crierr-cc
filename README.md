# crierr-cc

Mods for [Claude Code](https://claude.com/claude-code): hooks modules that change what the terminal UI shows. Install one, or all of them.

## Catalog

### [mermaid](mods/mermaid/README.md)

**Diagrams instead of code.** Draws each ````mermaid```` block of a reply as a diagram, in its place in the reply. Text view (Unicode box art) or image view (mermaid-cli).

Needs: nothing for text view; [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`, Node.js) and an image-capable terminal for image view.

![mermaid inline: image view on the left, text view on the right](docs/screenshots/mermaid-inline.png)

### [image-inline](mods/image-inline/README.md)

**See the images a reply names.** Local paths, `file://` and web URLs are drawn under the reply. PNG, JPEG, GIF, WebP, AVIF and SVG; web images wait behind a Load button.

Needs: an image-capable terminal; macOS (`sips`) for formats other than PNG; `curl` for web images.

![image-inline: a local JPEG and a web PNG drawn under the reply](docs/screenshots/image-inline.png)

### [cache-timer](mods/cache-timer/README.md)

**Send your next prompt while the cache is warm.** A band above the prompt shows how long ago you last prompted and turns yellow, then red, as the prompt cache expires. Optional keepwarm pings or auto-handoff.

Needs: nothing.

```
7 minutes ago ░░░░░ 🔁
```

## Install

Inside Claude Code:

```
/plugin marketplace add crierr/crierr-cc
/plugin install <mod>@crierr-cc
/reload-plugins
```

Change a mod's settings with `/config`. Each mod's README lists its settings.

Claude doesn't know that mermaid and image-inline draw what it writes. To have it use them, add a line to your `CLAUDE.md` or `AGENTS.md`: each of those READMEs has a **Let Claude know** section with one to copy.

An image-capable terminal is one with inline graphics: kitty, Ghostty, or iTerm2 3.5+ with fullscreen rendering. Other terminals show a text placeholder instead.
