# stets

Connects your AI agents to [Stets](https://stets.app), the website builder you talk to.

```sh
npx stets.app agent setup
```

Stet, the builder, waves and finds the agents on your computer. Inside a git project he first asks where Stets
should go. Then you pick the agents in a menu (space toggles, enter goes). Each agent signs in to Stets itself,
and if your browser is already signed in at stets.app, that's one click: Allow.

Once that's done, ask your agent: "Make me a website for my bakery."

| Command | What it does |
|---|---|
| `npx stets.app agent setup` | Add Stets to your agents and sign them in |
| `npx stets.app agent status` | Show where Stets is set up |
| `npx stets.app agent remove` | Take Stets out again (signing the agent out first). Without `--agents` it lists what goes and asks |

Installed with `npm i -g stets.app`, the command is just `stets`. (`npx stets`, without `.app`, is someone else's
package.)

## Where

| `--scope` | Means | Claude Code | Codex | Gemini | Cursor, VS Code, Kiro, OpenCode | Devin, Qwen |
|---|---|---|---|---|---|---|
| `global` (default) | all your projects | user | `~/.codex` | user | global file | user |
| `project` | this project, shared through git | `.mcp.json` | `.codex/config.toml` | `.gemini/` | `.cursor/`, `.vscode/`, `.kiro/`, `opencode.json` | none |
| `local` | this project, just for you | local | none | none | none | none |

In a project, Gemini CLI, OpenCode and Codex sign in inside the agent, once you trust the folder there: the CLI
doesn't run them in the project. Qwen Code has all your projects only.

The chat apps (the Claude app and ChatGPT) are always account-wide. A Stets connector added in the Claude app also
shows up in Claude Code.

## The agents

| Agent | How Stets gets in | Sign-in | Checked |
|---|---|---|---|
| Claude Code | `claude mcp add` | `claude mcp login` | fully |
| Codex CLI | `codex mcp add` (project: its file) | during the add, or `codex mcp login` | sign-in |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | in the app; terminal: `cursor-agent mcp login` | sign-in (terminal) |
| VS Code | its `mcp.json` (profile or `.vscode/`) | in the app (Authenticate) | adding |
| Antigravity | `agy mcp add` | in the app | adding |
| Mistral Vibe | `vibe mcp add` | during the add, or `/mcp login` | adding |
| Gemini CLI, Qwen Code | `gemini` / `qwen mcp add` | on first connect, or `/mcp auth` | docs |
| OpenCode | `opencode mcp add` | `opencode mcp auth` | docs |
| GitHub Copilot CLI | `copilot mcp add` | `/mcp auth` in Copilot | docs |
| Factory Droid | `droid mcp add` | `droid mcp auth` | docs |
| Kiro, Devin (Windsurf) | their file or `mcp add` | in the app | docs |
| Zed | shows what to add (its settings file is yours) | in the app | docs |
| Claude app, ChatGPT | opens the connector page (the Claude one comes filled in) | in the app | guide |

Anything not fully checked shows "beta" in the menu.

## Options

- `--agents claude,cursor,…` and `--yes` skip the menu. `--yes` picks every coding agent that still needs Stets,
  except the ones checked only from their docs, and never the chat apps.
- `--scope global|project|local` skips the "where" question.
- `--url` points at another Stets, and `--name` sets the server's name in the agent.
- `--no-login` only adds Stets. Codex and Vibe still sign in during their own add.
- `--no-browser` is for sign-in over SSH. Add `--ascii` or `--no-color` (or set `NO_COLOR`) for plain output.
- A server other than stets.app (or one on your own computer) gets a warning and a question first, since your
  agents will send it what you ask them. `--trust-url` skips the question.

## Safe by default

Since 0.1.1 (a security review on 2026-11-23 found the 0.1.0 problems listed in the changelog below):

- **Your project's code never runs.** Agents are started in Stets' own empty folder (`~/.stets/neutral`), not in
  your project, so none of them loads a project's plugins or starts its MCP servers. The exceptions are Claude Code
  and Codex in their project scopes, which start nothing there until you approve or trust it.
- **Programs by full path:** found on your PATH (absolute folders only), never a file in the current folder.
- **In a project, plain files only:** a settings file that is a link (to somewhere outside the project) is left
  alone.
- **No terminal tricks:** text from configs and agents is printed without control characters.

- **No tokens:** the CLI holds none. Where an agent has a command for it, the CLI runs that command and shows it.
- **Config files:** where an agent only has a file, the CLI writes just the Stets entry. A copy of the old file goes
  to `~/.stets/backups` first (never into the project, where git could pick it up).
- **Files it won't touch:** a file with comments, or Zed's settings, stays as it is. You get the lines to add, or
  an install link.
- **Other addresses:** a `stets` entry pointing at another address is left alone. Use `--name` for a second one.

Needs Node 18 or newer. One file, no dependencies. MIT licence. How it keeps you safe, and how to report a
problem: [SECURITY.md](SECURITY.md).

## Changelog

- **0.1.5 (2026-11-23):** Stet and the logo, redrawn: the Stets logo in block letters with a small Stet beside it,
  his roller in Stets red, and a little dance while he says hello. It's the same drawing as on stets.app/brand.
  With `--ascii`, Stet alone, in plain characters.
- **0.1.4 (2026-11-23):** the first release from this repository (github.com/stets-app/cli): staged by its CI with
  npm provenance, then approved by a maintainer on npm. Same code as 0.1.2, plus links to this repository and
  SECURITY.md.
- **0.1.3:** tagged but never published. npm only lets this repository's CI stage a release, not publish one.
- **0.1.2 (2026-11-23):** MIT licence. On Node 18, a Stets on `localhost` that only listens on 127.0.0.1 was
  reported as unreachable. Claude Code's project file (`.mcp.json`) is checked for links too. A test
  (`test/safe-run.mjs`, run in CI on Linux, macOS and Windows) shows agents start by full path, in Stets' own
  folder, never from the current folder, including through Windows' cmd.exe.
- **0.1.1 (2026-11-23), security fixes. Please update.**
  - OpenCode was run inside the current folder, so in a cloned repo it could load that repo's plugins and start
    its MCP servers. Agents now run in Stets' own folder.
  - On Windows, a crafted `--url` or a `claude.cmd` in the current folder could run commands. Programs are now
    started by full path, without the shell where possible, and addresses with characters Windows reads as a
    command are refused.
  - Settings files in a project are no longer written through links.
  - A server other than stets.app needs your confirmation (or `--trust-url`); addresses with a name, password,
    `?` or `#` are refused.
  - Also fixed: the claude.ai connector check could be fooled by a project server with that name. Control
    characters are no longer printed, and backups are readable by you only. Removing a Codex table keeps its
    neighbours intact. Printed commands now say `npx stets.app`.
- **0.1.0 (2026-11-23)**: first release.
