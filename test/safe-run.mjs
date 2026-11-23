// Checks how the CLI starts agents, on Linux, macOS and Windows (CI runs it on all three):
//   - an agent is started by its full path from PATH, never a same-named file in the current folder (a decoy here);
//   - in Stets' own folder (~/.stets/neutral), not the current one;
//   - "claude.ai Stets" arrives as one argument, also through Windows' cmd.exe for a .cmd agent;
//   - the claude.ai connector counts only with Scope claude.ai and Status Connected;
//   - on Windows, an address with a character cmd.exe reads as a command is refused.
// A fake `claude` (a small Node script, with a .cmd wrapper on Windows) records each call. Nothing real is touched:
// HOME, USERPROFILE and the agent's state all live in a temporary folder.
//   node test/safe-run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const CLI = fileURLToPath(new URL('../stets.mjs', import.meta.url)); // (no import.meta.dirname on Node 18)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stets-safe-run-'));
const home = path.join(root, 'home'), bin = path.join(root, 'bin'), work = path.join(root, 'work');
for (const d of [home, bin, work]) fs.mkdirSync(d, { recursive: true });
const log = path.join(root, 'calls.jsonl'), state = path.join(root, 'state.json'), marker = path.join(root, 'DECOY-RAN');

// the fake agent: records argv and cwd; answers like Claude Code
fs.writeFileSync(path.join(bin, 'fake-claude.js'), `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cwd: process.cwd() }) + '\\n');
const st = fs.existsSync(${JSON.stringify(state)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8')) : {};
const name = a[2];
if (a[0] === 'mcp' && a[1] === 'get' && name === 'claude.ai Stets') {
  console.log('claude.ai Stets:\\n  Scope: claude.ai config\\n  Status: ✔ Connected'); process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'get') {
  if (!st[name]) { console.log('No MCP server named "' + name + '".'); process.exit(1); }
  console.log(name + ':\\n  Scope: User config (available in all your projects)\\n  Status: ✔ Connected\\n  Type: http\\n  URL: ' + st[name]);
  process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'add') { st[a[a.length - 2]] = a[a.length - 1]; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.exit(0); }
if (a[0] === 'mcp' && (a[1] === 'remove' || a[1] === 'logout')) { delete st[a[2]]; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.exit(0); }
process.exit(0);
`);
if (WIN) fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`);
else {
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.js')}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
}
// the decoys: same name, in the folder the CLI is run from
fs.writeFileSync(path.join(work, 'claude.cmd'), `@echo x> "${marker}"\r\n`);
fs.writeFileSync(path.join(work, 'claude'), `#!/bin/sh\necho x > "${marker}"\n`);
fs.chmodSync(path.join(work, 'claude'), 0o755);

// a throwaway server for the address check (any answer counts as "there")
const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// PATH: a relative entry first (it points at the decoy's folder, and must be skipped), then our bin and the system
// folders; no other agents
const sys = WIN ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/usr/bin', '/bin'];
const env = {
  ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', STETS_NO_OPEN: '1', STETS_BACKUP_DIR: path.join(root, 'backups'),
  PATH: ['.', bin, ...sys].join(path.delimiter), XDG_CONFIG_HOME: path.join(home, '.config'),
};
delete env.CLAUDE_CONFIG_DIR;
// async, so the throwaway server can answer while the CLI runs
const cli = (...a) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...a], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => resolve({ code, out }));
});

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : `\n      ${detail}`}`); if (!ok) failed++; };
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

let r = await cli('agent', 'status');
check(r.code === 0, 'status runs', r.out);
check(/Claude Code\s+connected through claude\.ai/.test(r.out) && /Claude app\s+connected/.test(r.out), 'the connector counts (Scope claude.ai, Status Connected)', r.out);
const conn = calls().find((c) => c.argv[2] === 'claude.ai Stets');
check(!!conn && conn.argv.length === 3 && conn.argv[0] === 'mcp' && conn.argv[1] === 'get', '"claude.ai Stets" arrives as one argument', JSON.stringify(conn));
const nd = path.join(home, '.stets', 'neutral');
const same = (a, b) => { try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); } catch { return false; } };
check(calls().length > 0 && calls().every((c) => same(c.cwd, nd)), 'every call runs in ~/.stets/neutral', JSON.stringify(calls().map((c) => c.cwd)));

r = await cli('agent', 'setup', '--yes', '--agents', 'claude', '--url', `http://localhost:${port}/mcp`);
check(r.code === 0 && /1 added, 1 connected, 0 problems/.test(r.out), 'setup adds Stets through the agent on PATH', r.out);
const add = calls().find((c) => c.argv[1] === 'add');
check(!!add && add.argv.join(' ') === `mcp add --transport http --scope user stets http://localhost:${port}/mcp`, 'the add command arrives intact', JSON.stringify(add));

r = await cli('agent', 'remove', '--agents', 'claude', '--url', `http://localhost:${port}/mcp`);
check(r.code === 0 && /Stets removed/.test(r.out), 'remove works', r.out);

check(!fs.existsSync(marker), 'the decoy in the current folder never ran');

if (WIN) {
  r = await cli('agent', 'setup', '--yes', '--agents', 'claude', '--url', `http://localhost:${port}/m&calc`);
  check(r.code === 1 && /Windows reads as a command/.test(r.out), 'Windows: an address with & is refused', r.out);
}
r = await cli('agent', 'setup', '--yes', '--url', `http://localhost:${port}/mcp?a=1`);
check(r.code === 1 && /can't hold a \?/.test(r.out), 'an address with ? is refused', r.out);

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
