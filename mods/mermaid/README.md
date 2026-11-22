# mermaid

Draws each ````mermaid```` block of a reply as a diagram. The reply itself is unchanged: the source stays above the diagram.

## Requirements

- **Text view:** nothing. The lovely-mermaid renderer comes bundled.
- **Image view:** [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`), which needs Node.js. Install it with `npm i -g @mermaid-js/mermaid-cli`. If `mmdc` isn't on Claude Code's `PATH`, set its full path in the **mermaid-cli command** setting. The install also downloads the headless Chromium that `mmdc` draws with.
- **Image view:** a terminal with inline graphics: kitty, Ghostty, or iTerm2 3.5+ with fullscreen rendering. Other terminals show a text placeholder instead.
- **Image theme `auto`:** reads macOS appearance (`defaults`) when Claude Code's theme doesn't say light or dark. Elsewhere it uses dark; set **Image theme** to override.

## Install

```
/plugin marketplace add crierr/crierr-cc
/plugin install mermaid@crierr-cc
/reload-plugins
```

Change settings with `/config`.

## Usage

**Inline** (the default): each finished diagram is drawn under the reply. Left, image view; right, text view.

![mermaid inline: image view on the left, text view on the right](../../docs/screenshots/mermaid-inline.png)

**Pane**: the latest diagram is drawn in a side pane, live while the reply streams. `/mermaid` opens or closes it. The **Show text** / **Show image** button (hotkey `v`) switches views.

![mermaid pane in image view, beside the conversation](../../docs/screenshots/mermaid-pane.png)

| Setting | Values | Default |
| --- | --- | --- |
| Where diagrams show | `inline`, `pane (auto-open)`, `pane (/mermaid)` | `inline` |
| View | `text`: Unicode box art. `image`: a PNG made by mermaid-cli | `text` |
| mermaid-cli command | path to `mmdc` | `mmdc` |
| Image theme | `auto` (follows Claude Code's theme, then macOS appearance), `dark`, `light` | `auto` |

- Text view uses [lovely-mermaid](https://github.com/badlogic/pi-mono), bundled. A sideways flowchart that is too wide is redrawn top to bottom.
- Image view needs mermaid-cli: `npm i -g @mermaid-js/mermaid-cli`. PNGs go to `$TMPDIR/claude-mermaid/` and are deleted when the session ends.

[← all mods](../../README.md)
