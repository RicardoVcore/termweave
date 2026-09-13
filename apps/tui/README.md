# termweave

Terminal-first coding-agent client with an OpenTUI client.

## Install

```bash
bunx termweave
```

Requires Bun `>=1.3.9`.

Linux notes:

- Termweave follows XDG defaults on Linux:
  `XDG_CONFIG_HOME/termweave` for prefs, `XDG_STATE_HOME/termweave` for logs and image state, and `XDG_DATA_HOME/termweave` for app data.
- Opening links uses desktop helpers such as `xdg-open` or `gio open`.
- Clipboard image paste works with `wl-paste` on Wayland or `xclip` on X11.

## What You Get

- Native-feeling terminal UI built on OpenTUI
- Bundled server and web client for local use
- Codex-first workflow tuned for terminal usage

## Source

- Repo: https://github.com/RicardoVcore/termweave
- Issues: https://github.com/RicardoVcore/termweave/issues

Forked from [maria-rcks/t1code](https://github.com/maria-rcks/t1code), based on T3 Code by `@t3dotgg` and `@juliusmarminge`.
