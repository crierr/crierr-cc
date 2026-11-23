# image-inline

When a reply names an image, the image is drawn under the reply, with an **open image ↗** link to the file or URL below it.

## Requirements

- A terminal with inline graphics: kitty, Ghostty, or iTerm2 3.5+ with fullscreen rendering. Other terminals show a text placeholder instead.
- **macOS** for anything but PNG: JPEG, GIF, WebP, AVIF and SVG are converted with `sips`, which ships with macOS. On other systems only PNG shows.
- `curl` for web images (preinstalled on macOS and most Linux).

## Install

```
/plugin marketplace add crierr/crierr-cc
/plugin install image-inline@crierr-cc
/reload-plugins
```

Change settings with `/config`.

## Usage

![image-inline: a local JPEG and a web PNG drawn under the reply](../../docs/screenshots/image-inline.png)

- Finds markdown images (`![alt](…)`), `file://` and `http(s)://` URLs, and bare or relative paths (`~/…`, `./…`). Paths in fenced code blocks are skipped.
- Formats: PNG, JPEG, GIF, WebP, AVIF and SVG. Non-PNG files are converted with macOS `sips`, so on other systems only PNG shows.
- A path that leads to no file draws nothing.
- Web images wait behind a **Load image from …** button by default. Loading downloads with `curl` (20 MB and 20 s limits).
- Converted and downloaded files go to `$TMPDIR/claude-image-inline/` and are deleted when the session ends.

| Setting | Values | Default |
| --- | --- | --- |
| Web images | `ask`: a Load button per image. `always`: fetch at once. `local only`: never fetch | `ask` |
| Image height (rows) | number | `20` |
| Images per reply block | number | `4` |

[← all mods](../../README.md)
