# Kimai for Claude Code

A Claude Code mod for [Kimai](https://www.kimai.org) time tracking. It shows your running timers in the session footer and adds a `/kimai` side panel to view, edit and start timers. You do not have to leave the session.

## What it does

**Footer chip.** The chip refreshes every 60 seconds.

| Running timers | Chip shows | Click |
| --- | --- | --- |
| None | nothing | — |
| One | `● Acme Corp · 1h 05m` (customer and elapsed time) | stops that timer |
| More than one | `● 3 timers running` | opens or closes the panel |

**`/kimai` panel.** It opens docked beside the transcript.

- Filter your entries: **Active**, **Completed** or **All**. Hotkeys are `a`, `c` and `l`.
- **Edit** an entry: project, activity, description, start time and end time.
- **Stop** a running timer, **Restart** a completed one, or **Delete** an entry. Delete asks for confirmation.
- **New timer** (`n`, or `/kimai new`) starts with the project and activity of your latest entry. Leave **Start** empty to start now, or type a time to backdate the timer.

Times use your Kimai time zone, in the format `YYYY-MM-DD HH:MM`. In the **End** field, `HH:MM` alone means the start date.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install kimai --marketplace alphaomegateam/claude-kimai
```

From a shell:

```bash
claude plugin install kimai --marketplace alphaomegateam/claude-kimai
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `alphaomegateam/claude-kimai`, then **Add plugin**.

## Configure

| Option | Required | What it is |
| --- | --- | --- |
| `url` | yes | Your Kimai server, for example `https://kimai.example.com`. A URL that ends in `/api` also works. |
| `apiToken` | one of these two | A Kimai API token (Kimai: your avatar → **API Access**). It is kept in secure storage. |
| `headersHelper` | one of these two | A shell command that prints a token, or a JSON object of HTTP headers. |
| `helperTtlMinutes` | no | How long the mod uses the helper's output before it runs the helper again. Default: 15. Use 0 to run it for every request. |
| `pollSeconds` | no | How often the chip refreshes. Default: 60, minimum: 15. |

Set the options when you install, or later in `/config`. You can also put them in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "kimai": {
      "options": {
        "url": "https://kimai.example.com",
        "headersHelper": "op read \"op://Private/Kimai/credential\""
      }
    }
  }
}
```

### Headers helper

Use the helper to keep the token out of your settings. The mod runs the helper with `/bin/sh -c`. If the output is plain text, the mod sends it as `Authorization: Bearer <output>`. If the output is a JSON object, the mod sends it as the request headers.

```bash
# 1Password
op read "op://Private/Kimai/credential"

# macOS Keychain
security find-generic-password -s kimai -w

# Older Kimai versions (API password instead of token)
printf '{"X-AUTH-USER":"me","X-AUTH-TOKEN":"%s"}' "$(op read op://Private/Kimai/api-password)"
```

When Kimai returns 401, the mod runs the helper again one time, so a rotated token works.

## Recommended companion: Kimai MCP

This mod is the interface you click. If you also want Claude to read and write your timesheets, for example "log 2h on the Acme project yesterday", install [kimai_mcp](https://github.com/glazperle/kimai_mcp) next to it. The two do not depend on each other. The mod calls the Kimai REST API directly, so it works with any MCP setup, and also with no MCP setup.

## Requirements

- Kimai 2.x with API access for your user. Tested against 2.70.
- A Claude Code version that loads mods (function-hook plugins). The footer chip draws in the terminal and the desktop app. On mobile, the panel lists entries but cannot edit them.

## Development

```bash
claude --plugin-dir .          # run a session with the mod loaded from this folder
claude plugin validate .       # check the manifest and hooks module
claude plugin test .           # run tests/*.test.tsx against a mocked Kimai
npx -p typescript tsc -p .     # type-check
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the mod from this folder. On a fresh clone, run `claude --plugin-dir .` once before you type-check.

`hooks/register.tsx` holds the hooks, the panel and the chip. `hooks/kimai.ts` holds the pure helpers: config, time parsing and error formatting. `types/index.d.ts` declares the session state.

## License

MIT
