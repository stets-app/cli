# Security

`npx stets.app agent setup` changes settings of the AI agents on your computer, so it is built to be safe to run
anywhere, including inside a repository you just cloned.

## What it does and doesn't do

- **It never runs your project's code.** Agents are started in Stets' own empty folder (`~/.stets/neutral`, readable
  by you only), not in the folder you run it from, so no agent loads a project's plugins or starts its MCP
  servers. The exceptions are Claude Code and Codex in their project scopes, which start nothing in a project
  until you approve or trust it there.
- **Programs are started by their full path**, found in the absolute folders on your PATH. A file with the same
  name in the current folder never runs instead. On Windows, a `.cmd` agent is started through System32's
  `cmd.exe` only when no argument holds a character `cmd.exe` would read as a command.
- **In a project, it only writes plain files.** A settings file that is a link (to somewhere outside the project)
  is left alone.
- **It holds no tokens.** Each agent signs in to Stets itself and keeps its own sign-in.
- **It asks before trusting another server.** Anything other than `stets.app` or your own computer gets a warning
  first, because your agents will send that server what you ask them.
- **Backups:** before it changes a settings file, a copy goes to `~/.stets/backups`, readable by you only.
- **The network:** it only makes one request of its own, a GET to the Stets address, to check it's there.

`test/safe-run.mjs` checks the start-up rules on Linux, macOS and Windows on every change.

## Releases

Releases are published from this repository's CI with npm's trusted publishing, after a maintainer approves them.
npm shows each release's provenance: the commit and workflow it was built from.

## Reporting a problem

Please email security@stets.app, or use GitHub's private vulnerability reporting on this repository. Don't open a
public issue for a security problem.
