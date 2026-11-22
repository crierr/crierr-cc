# cache-timer

A band above the prompt shows how long ago you last sent a prompt, so you know when the prompt cache expires.

## Requirements

Nothing beyond Claude Code. Keepwarm pings and auto-handoff are model calls, billed like any other request.

## Install

```
/plugin marketplace add crierr/crierr-cc
/plugin install cache-timer@crierr-cc
/reload-plugins
```

Change settings with `/config`.

## Usage

The band looks like this:

```
7 minutes ago ░░░░░ 🔁
```

- The text turns from green to yellow in the last 2 minutes before the prompt cache expires, and to red with `(cache expired)` after.
- The bar fills as time passes.
- 🔁 toggles auto-handoff. When on (`->✏️`), a minute before the cache expires the mod writes `.claude/HANDOFF.md` for a fresh session to continue from.

| Setting | Values | Default |
| --- | --- | --- |
| Mode | `default`: show only. `keepwarm`: ping the model 1 minute before expiry. `auto-handoff`: start with handoff on | `default` |
| Cache TTL (seconds) | `300` for a 5-minute cache, `3600` for 1 hour | `300` |
| Max keepwarm pings while idle | number; each ping re-reads the whole context | `6` |

Keepwarm pings and handoffs are model calls, billed like any other request.

[← all mods](../../README.md)
