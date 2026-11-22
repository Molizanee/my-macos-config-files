# config-files

My personal dotfiles for the terminal setup, organized by theme. Each theme folder holds the full set of configs for every app, plus matching wallpapers.

## Themes

- `tokyo-night/`, Tokyo Night (Night variant)

## Layout

```
<theme>/
├── ghostty/      Ghostty terminal config
├── herdr/        herdr settings and color theme
├── omp/          oh-my-pi (omp) config, MCP servers, theme, extensions
└── wallpapers/   Desktop wallpapers matching the theme
```

## Install locations

Files in this repo are copies. Copy them to these paths to apply a theme:

| Repo path | System path |
| --- | --- |
| `<theme>/ghostty/config.ghostty` | `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty` |
| `<theme>/herdr/settings.json` | `~/.config/herdr-app/settings.json` |
| `<theme>/herdr/themes/` | `~/.config/herdr-app/themes/` |
| `<theme>/omp/config.yml` | `~/.omp/agent/config.yml` |
| `<theme>/omp/mcp.json` | `~/.omp/agent/mcp.json` |
| `<theme>/omp/themes/` | `~/.omp/agent/themes/` |
| `<theme>/omp/extensions/` | `~/.omp/agent/extensions/` |

## Adding a theme

Copy an existing theme folder, rename it, and change the colors, theme names, and wallpapers.
