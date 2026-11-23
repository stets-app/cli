#!/usr/bin/env node
// stets: puts Stets into your agents (Claude Code, Codex CLI, Gemini CLI, editors, the chat apps) and signs them in.
// One file, no dependencies, Node 18+.
// Each agent keeps its own Stets sign-in (OAuth, refreshed by the agent itself), so this CLI holds no tokens.
// Where an agent has a command for it (`mcp add`, `mcp login`), the CLI runs that and shows it; where an agent
// only has a config file, it edits just the Stets entry, after a backup, and leaves files with comments alone.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.1.5';
const DEFAULT_URL = 'https://stets.app/mcp';
const env = process.env;
const out = process.stdout;

let cursorHidden = false;
function showCursor() { if (cursorHidden) { out.write('\x1b[?25h'); cursorHidden = false; } }
function fail(msg) {
  showCursor();
  process.stderr.write(`stets: ${msg}\n`);
  process.exit(1);
}
// `stets help | head` closes the pipe early: that's fine, not a crash.
out.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

// ---------- arguments ----------

const VALUED = new Set(['url', 'name', 'agents', 'scope']);
const KNOWN = new Set([...VALUED, 'yes', 'no-login', 'no-browser', 'trust-url', 'ascii', 'no-color', 'help', 'version']);

function parseArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--') { a._.push(...argv.slice(i + 1)); break; }
    if (s.startsWith('--')) {
      const eq = s.indexOf('=');
      const k = eq > 0 ? s.slice(2, eq) : s.slice(2);
      if (eq > 0) a.flags[k] = s.slice(eq + 1);
      else if (VALUED.has(k)) {
        if (i + 1 >= argv.length) fail(`--${k} needs a value.`);
        a.flags[k] = argv[++i];
      } else a.flags[k] = true;
    } else if (s === '-h') a.flags.help = true;
    else if (s === '-y') a.flags.yes = true;
    else if (s === '-v') a.flags.version = true;
    else a._.push(s);
  }
  for (const k of Object.keys(a.flags)) if (!KNOWN.has(k)) fail(`Unknown option --${k.replace(/[^\w-]/g, '?')}. See: npx stets.app help`);
  return a;
}

// ---------- terminal ----------

const args = parseArgs(process.argv.slice(2));
const TTY = !!(out.isTTY && process.stdin.isTTY);
const COLOR = !args.flags['no-color'] && (env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : !!out.isTTY && !env.NO_COLOR && env.TERM !== 'dumb');
const ASCII = !!args.flags.ascii || !!env.STETS_ASCII || env.TERM === 'dumb' || env.TERM === 'linux';
const ANIM = TTY && COLOR && !env.CI && !env.STETS_NO_ANIM;

const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr('1'), dim = sgr('2'), green = sgr('32'), yellow = sgr('33');
const red = /truecolor|24bit/i.test(env.COLORTERM || '') ? sgr('38;2;225;6;0') : sgr('31'); // Stets red, #e10600

// Every glyph is one column wide; --ascii (or a plain console) swaps the few non-ASCII ones.
const G = ASCII
  ? { ok: '+', no: 'x', warn: '!', ptr: '>', on: 'x', off: ' ', sep: '-', h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', smile: '_', eye: 'o', grip: '\'', roller: '###', dots: '...', spin: ['-', '\\', '|', '/'] }
  : { ok: '✓', no: '✗', warn: '!', ptr: '▶', on: '✓', off: '·', sep: '·', h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', smile: '‿', eye: '•', grip: '╯', roller: '▄▄▄', dots: '…', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] };

const visible = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - visible(s)));
const say = (s = '') => out.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hideCursor = () => { if (TTY) { out.write('\x1b[?25l'); cursorHidden = true; } };
process.on('exit', showCursor);
process.on('SIGINT', () => { showCursor(); say(); process.exit(130); });

// ---------- Stet and the logo ----------
// The same drawings are on stets.app/brand and in Stet's hello in the browser console: change them together.

/** The Stets logo, the mark and "stets", in half blocks: four rows, 34 columns. Left out with --ascii. */
const LOGO = [
  '▄▀▀▀▀▀▀▀        █         █',
  '█ ▀▀▀▀▀▄  ▄▀▀▀ ▀█▀▀ ▄▀▀▄ ▀█▀▀ ▄▀▀▀',
  ' ▀▀▀▀▀ █   ▀▀▄  █   █▀▀▀  █    ▀▀▄',
  '▀▀▀▀▀▀▀   ▀▀▀   ▀▀▀  ▀▀▀  ▀▀▀ ▀▀▀',
];
const LOGO_W = 34;

/** Stet, the builder from stets.app, small: paper hat, round face, a body, his roller in his hand. Four rows (the
 *  logo's height), ten columns. The poses are the steps of the little text dance:
 *  stand (roller up), wave (other arm up, roller out front), pls (roller out front); cheer is wave with happy eyes,
 *  and blink closes his eyes. */
function stet(pose = 'stand', blink = false) {
  const eye = blink ? '-' : pose === 'cheer' ? '^' : G.eye;
  const face = `(${eye}${G.smile}${eye})`;
  const body = {
    stand: [` ${face} ${red(G.roller)}`, `<)  )${G.h}${G.h}${G.grip}`],
    wave: [`\\${face}`, ` (  (>${red(G.roller)}`],
    pls: [` ${face}`, `<)  )>${red(G.roller)}`],
  }[pose === 'cheer' ? 'wave' : pose];
  return ['   /\\', ...body, '  /  \\'];
}
const DANCE = ['stand', 'wave', 'pls'];
const ART_W = 13;
/** Stet with lines of text beside him, from his face down; more lines than that go on below him. */
const scene = (pose, side = [], blink = false) => {
  const art = stet(pose, blink);
  return Array.from({ length: Math.max(art.length, side.length + 1) }, (_, i) => `  ${side[i - 1] ? padTo(art[i] || '', ART_W) + side[i - 1] : art[i] || ''}`.replace(/ +$/, ''));
};
/** The logo with Stet beside it (his hat level with the t's, his feet on the baseline), and a note after his feet. */
const masthead = (pose = 'stand', blink = false, note = '') => {
  const s = stet(pose, blink);
  return LOGO.map((l, i) => `  ${padTo(l, LOGO_W + 3)}${i === 3 && note ? padTo(s[3], ART_W) + note : s[i]}`.replace(/ +$/, ''));
};

function draw(lines, previous) {
  if (previous) out.write(`\x1b[${previous}A\r`);
  for (const l of lines) out.write(l + (previous ? '\x1b[K' : '') + '\n');
  return lines.length;
}

/** The logo with Stet beside it and his lines below; with --ascii, Stet with the name and his lines beside him. */
const hello = (pose, side, blink) => (ASCII
  ? scene(pose, [bold('Stets') + dim(` ${VERSION}`), ...side], blink)
  : [...masthead(pose, blink, dim(VERSION)), '', ...side.map((l) => (l ? `  ${l}` : l))]);

/** Stet dances while his line types out, then waves; static without a colour terminal. */
async function greet(side) {
  if (!ANIM) { say(); draw(hello('wave', side)); say(); return; }
  hideCursor();
  say();
  // the first k characters of his lines, the rest still to come
  const frame = (pose, k, blink) => {
    let left = k;
    const shown = side.map((l) => {
      const w = visible(l), take = Math.max(0, Math.min(w, left));
      left -= w;
      return take === w ? l : l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, take);
    });
    return hello(pose, shown, blink);
  };
  const total = side.reduce((n, l) => n + visible(l), 0);
  let rows = draw(frame('stand', 0), 0);
  for (let k = 0, f = 0; k <= total; k += 2, f++) { // he dances a step every fifth frame
    rows = draw(frame(DANCE[Math.floor(f / 5) % DANCE.length], k), rows);
    await sleep(18);
  }
  rows = draw(frame('wave', total, true), rows);
  await sleep(120);
  draw(frame('wave', total), rows);
  showCursor();
  say();
}

// ---------- running the agents' own commands ----------
// Safety rules (from a security review on 2026-11-23; SECURITY.md):
// - A program is looked up on PATH here, in absolute folders only, and started by its full path: a file in the
//   current folder (a cloned repo) never runs in its place, as cmd.exe and Windows would otherwise allow.
// - Agent commands run in Stets' own empty folder (~/.stets/neutral), never in the project, so no agent loads a
//   project's plugins or starts its MCP servers. Exceptions, checked to start nothing from a project: Claude Code
//   (its project and just-for-you scopes; a project's servers wait for your approval) and Codex.
// - On Windows an npm shim (.cmd) only runs through cmd.exe: then no argument may hold a character cmd reads.

const WIN = process.platform === 'win32';
const SYSTEM32 = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
const CMD_UNSAFE = /[&|<>^%!"()\r\n]/;
const home = os.homedir();
/** The command to show people: npx users have no `stets` command (and `npx stets` is someone else's package). */
const CMD = 'npx stets.app';

/** Text from outside (agent output, a URL from a config, a folder name) without control characters, so it can't
 *  move the cursor, clear the screen or write to the clipboard. */
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** The full path of a program on PATH (absolute folders only), or null. */
function which(bin) {
  const exts = WIN ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const e of exts) {
      const f = path.join(dir, bin + e);
      try {
        if (!fs.statSync(f).isFile()) continue;
        if (!WIN) fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch { /* next */ }
    }
  }
  return null;
}
const has = (bin) => !!which(bin);

/** Stets' own empty folder to run agents in: ours alone (0700) and not a link. */
let neutral = null;
function neutralDir() {
  if (neutral) return neutral;
  const d = path.join(home, '.stets', 'neutral');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    fail(`${d} is not a folder of yours: remove it, then run this again.`);
  }
  if (!WIN) fs.chmodSync(d, 0o700);
  return (neutral = d);
}

/** How to start a program: its full path and arguments, or why not. */
function plan(bin, argv) {
  const file = which(bin);
  if (!file) return { missing: true };
  if (!WIN || /\.(exe|com)$/i.test(file)) return { file, args: argv, opts: {} };
  if (/["%!]/.test(file) || argv.some((a) => CMD_UNSAFE.test(a))) {
    return { refused: `${bin}: an argument holds a character Windows' cmd.exe would read as a command` };
  }
  return { file: `"${file}"`, args: argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)), opts: { shell: path.join(SYSTEM32, 'cmd.exe') } };
}
const childEnv = (e) => (WIN ? { ...(e || env), NoDefaultCurrentDirectoryInExePath: '1' } : e || env);

function run(bin, argv, { timeout = 60_000, cwd = neutralDir(), env: e } = {}) {
  const p = plan(bin, argv);
  if (p.missing) return { ok: false, out: '', missing: true };
  if (p.refused) return { ok: false, out: p.refused, missing: false };
  const r = spawnSync(p.file, p.args, { encoding: 'utf8', timeout, env: childEnv(e), cwd, ...p.opts });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, missing: false };
}

function runAsync(bin, argv, { timeout = 60_000, cwd = neutralDir(), env: e } = {}) {
  return new Promise((resolve) => {
    const p = plan(bin, argv);
    if (p.missing) return resolve({ ok: false, out: '', missing: true });
    if (p.refused) return resolve({ ok: false, out: p.refused, missing: false });
    let text = '';
    let child;
    try { child = spawn(p.file, p.args, { env: childEnv(e), cwd, stdio: ['ignore', 'pipe', 'pipe'], ...p.opts }); }
    catch { return resolve({ ok: false, out: '', missing: true }); }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('error', (er) => { clearTimeout(timer); resolve({ ok: false, out: text, missing: er.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: text, missing: false }); });
  });
}

/** Runs a command where the person sees it and can answer it (sign-in prompts, browser links). */
function runShown(bin, argv, { cwd = neutralDir(), env: e } = {}) {
  say(dim(`  $ ${clean([bin, ...argv].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '))}`));
  const p = plan(bin, argv);
  if (p.missing || p.refused) { say(`    ${p.refused || `${bin} is not on this computer`}`); return { ok: false }; }
  const r = spawnSync(p.file, p.args, { stdio: 'inherit', env: childEnv(e), cwd, ...p.opts });
  return { ok: r.status === 0 };
}
/** An agent's own output, indented and cleaned. */
const showOutput = (text) => say(clean(text).trim().split('\n').map((l) => `    ${l}`).join('\n'));

const sameUrl = (a, b) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const tilde = (f) => clean(f.startsWith(home + path.sep) ? '~' + f.slice(home.length) : f);

// ---------- config files, for agents without a command ----------

/** Before the first change to a file in a run, a copy goes to ~/.stets/backups (not next to it: in a project,
 *  a copy there could end up in git). The folder is yours alone (0700) and each copy readable by you only (0600),
 *  since settings files can hold tokens. */
const backedUp = new Map();
function backup(file) {
  if (backedUp.has(file) || !exists(file)) return;
  const dir = env.STETS_BACKUP_DIR || path.join(home, '.stets', 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!env.STETS_BACKUP_DIR && !WIN) try { fs.chmodSync(dir, 0o700); } catch { /* not ours: the copies are 0600 anyway */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const tag = crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 8);
  const label = `${path.basename(path.dirname(file))}_${path.basename(file)}`.replace(/[^\w.-]/g, '_');
  const copyTo = path.join(dir, `${stamp}_${tag}_${label}`);
  fs.copyFileSync(file, copyTo, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(copyTo, 0o600);
  backedUp.set(file, copyTo);
}
const backupNote = (file) => (backedUp.has(file) ? dim(` (copy of the old file: ${tilde(backedUp.get(file))})`) : '');

/** In a project (scopes project and local) a settings file is only read or written inside it, through plain
 *  folders, as a plain file: a link in a cloned repo (to ~/.ssh, say) is never followed. */
let projectRoot = null;
function useScope(ctx) { projectRoot = ctx.scope === 'global' ? null : path.resolve(ctx.dir); }
function unsafe(file) {
  if (!projectRoot) return null;
  const abs = path.resolve(file);
  if (!abs.startsWith(projectRoot + path.sep)) return null; // not a project file
  let p = projectRoot;
  for (const part of path.relative(projectRoot, abs).split(path.sep)) {
    p = path.join(p, part);
    let st;
    try { st = fs.lstatSync(p); } catch { break; } // the rest doesn't exist yet
    if (st.isSymbolicLink()) return p === abs ? 'is a link' : 'is in a linked folder';
    if (p !== abs && !st.isDirectory()) return 'is in something that is not a folder';
    if (p === abs && !st.isFile()) return 'is not a plain file';
  }
  return null;
}
function mustBeSafe(file) {
  const bad = unsafe(file);
  if (bad) throw new Error(`${tilde(file)} ${bad}, so I left it alone`);
}

/** Comments and trailing commas out of JSONC, for reading only (outside strings, because URLs hold "//"). */
function stripJsonc(text) {
  let o = '';
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (str) { o += c; if (c === '\\') o += text[++i] ?? ''; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; o += c; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; o += '\n'; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else o += c;
  }
  return o.replace(/,(\s*[}\]])/g, '$1');
}

/** A JSON config, read even with comments; `comments` says a rewrite would lose them, so then we don't write. */
function readJson(file) {
  const bad = unsafe(file);
  if (bad) return { error: bad };
  if (!exists(file)) return { obj: {} };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { obj: {} };
  let obj, comments = false;
  try { obj = JSON.parse(text); } catch {
    try { obj = JSON.parse(stripJsonc(text)); comments = true; } catch { return { error: 'is not valid JSON' }; }
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? { obj, comments } : { error: 'is not a JSON object' };
}
function writeJson(file, obj) {
  mustBeSafe(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * An agent whose MCP servers live in a JSON file at obj[key][name]. spec: { file(scope, dir), key, entry(url),
 * link?(name, url) (an install link to offer instead), manual? (only show what to add) }. Whether the agent is
 * signed in can't be seen from outside: that happens inside the app, on first use.
 */
function jsonFile(spec) {
  const urlOf = (e) => e.url || e.serverUrl || e.httpUrl;
  return {
    async state(name, url, ctx) {
      const file = spec.file(ctx.scope, ctx.dir);
      const { obj, error } = readJson(file);
      if (error) return { present: false, fileError: `${tilde(file)} ${error}` };
      const e = obj[spec.key] && obj[spec.key][name];
      return e ? { present: true, where: ctx.scope, url: urlOf(e), ready: true, inApp: true } : { present: false };
    },
    add(name, url, ctx) {
      const file = spec.file(ctx.scope, ctx.dir);
      const { obj, error, comments } = readJson(file);
      if (error || comments || spec.manual) {
        const why = error || (comments ? 'has comments' : 'holds all your settings');
        say(yellow(`  ${G.warn} ${tilde(file)} ${why}, so I didn't change it. Add this under "${spec.key}":`));
        say(`    "${name}": ${JSON.stringify(spec.entry(url))}`);
        if (spec.link) say(`  Or open this link to add it: ${spec.link(name, url)}`);
        return { ok: false, manual: true };
      }
      obj[spec.key] = obj[spec.key] && typeof obj[spec.key] === 'object' ? obj[spec.key] : {};
      obj[spec.key][name] = spec.entry(url);
      writeJson(file, obj);
      say(dim(`  wrote "${name}" into ${tilde(file)}`) + backupNote(file));
      return { ok: true };
    },
    remove(name, ctx) {
      const file = spec.file(ctx.scope, ctx.dir);
      const { obj, error, comments } = readJson(file);
      if (error || !obj[spec.key] || !obj[spec.key][name]) return { ok: false, out: error ? `${tilde(file)} ${error}` : 'not there' };
      if (comments || spec.manual) return { ok: false, out: `remove "${name}" from ${tilde(file)} yourself (it ${comments ? 'has comments' : 'holds all your settings'})` };
      delete obj[spec.key][name];
      writeJson(file, obj);
      say(dim(`  removed "${name}" from ${tilde(file)}`));
      return { ok: true };
    },
  };
}

/** Is an app installed (macOS)? */
const hasApp = (n) => process.platform === 'darwin' && (exists(`/Applications/${n}.app`) || exists(path.join(home, 'Applications', `${n}.app`)));
const configHome = () => (WIN ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || path.join(home, '.config'));

/** Shows a command, runs it out of view, and prints its output only when it fails. */
function runListed(bin, argv) {
  say(dim(`  $ ${clean([bin, ...argv].join(' '))}`));
  const r = run(bin, argv);
  if (!r.ok) showOutput(r.out);
  return r;
}

/** An agent with its own `mcp add` and `mcp remove` (all your projects only, run in Stets' own folder); its state
 *  is read from its config file. */
function cliAgent(spec) {
  const f = jsonFile(spec);
  return {
    found: () => has(spec.bin),
    state: f.state,
    add: (name, url) => runListed(spec.bin, spec.addArgs(name, url)),
    remove: (name) => runListed(spec.bin, spec.removeArgs(name)),
    ...spec,
  };
}

// TOML (Codex's project file): only the [mcp_servers.<name>] table (and its sub-tables) is read or written; the
// rest of the file stays as it is. The same server written another way (an inline table, dotted keys) counts as
// there, and is left for you to change.
const tomlKey = (name) => `(?:"${name}"|${name})`;
const tomlHeader = (name) => new RegExp(`^[ \\t]*\\[[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*${tomlKey(name)}[ \\t]*\\][ \\t]*(?:#.*)?$`, 'm');
const tomlSub = (name) => new RegExp(`^[ \\t]*\\[[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*${tomlKey(name)}[ \\t]*\\.`);
const tomlOther = (name) => new RegExp(`^[ \\t]*(?:mcp_servers[ \\t]*\\.[ \\t]*)?${tomlKey(name)}[ \\t]*[=.]`, 'm');
function tomlServer(file, name) {
  const bad = unsafe(file);
  if (bad) return { error: bad };
  if (!exists(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const m = tomlHeader(name).exec(text);
  if (m) return { url: /^\s*url\s*=\s*"([^"]*)"/m.exec(text.slice(m.index + m[0].length).split(/^\s*\[/m)[0])?.[1] };
  const o = tomlOther(name).exec(text);
  if (o) return { url: /url\s*=\s*"([^"]*)"/.exec(text.slice(o.index).split('\n')[0])?.[1], other: true };
  return null;
}
function tomlAdd(file, name, url) {
  mustBeSafe(file);
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  const gap = !text || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(file, `${text}${gap}[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\n`);
}
function tomlRemove(file, name) {
  mustBeSafe(file);
  if (!exists(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const m = tomlHeader(name).exec(text);
  if (!m) return false;
  // up to the next table that isn't one of its own sub-tables
  const headers = /^[ \t]*\[[^\n]*$/gm;
  headers.lastIndex = m.index + m[0].length;
  let end = text.length, h;
  while ((h = headers.exec(text))) if (!tomlSub(name).test(h[0])) { end = h.index; break; }
  // comment lines right above that next table belong to it
  const lines = text.slice(m.index, end).split('\n');
  let k = lines.length;
  while (k > 1 && lines[k - 1].trim() === '') k--;
  let c = k;
  while (c > 1 && /^\s*#/.test(lines[c - 1])) c--;
  if (c < k) end = m.index + lines.slice(0, c).join('\n').length + 1;
  let before = text.slice(0, m.index).replace(/(\n[ \t]*)+$/, '\n');
  const after = text.slice(end).replace(/^([ \t]*\n)+/, '');
  if (!before.trim()) before = '';
  else if (after) before += '\n';
  backup(file);
  fs.writeFileSync(file, before + after);
  return true;
}

// ---------- the browser and the clipboard (for the chat apps) ----------

const NO_OPEN = () => !!args.flags['no-browser'] || !!env.STETS_NO_OPEN;
// By full path and without a shell: a link's & stays part of the link, and no file in the current folder runs.
function openUrl(u) {
  if (NO_OPEN()) return false;
  const [cmd, a] = process.platform === 'darwin' ? ['/usr/bin/open', [u]]
    : WIN ? [path.join(SYSTEM32, 'rundll32.exe'), ['url.dll,FileProtocolHandler', u]] : [which('xdg-open'), [u]];
  return !!cmd && spawnSync(cmd, a, { stdio: 'ignore' }).status === 0;
}
function copy(text) {
  if (NO_OPEN()) return false;
  const tries = process.platform === 'darwin' ? [['/usr/bin/pbcopy', []]] : WIN ? [[path.join(SYSTEM32, 'clip.exe'), []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]].map(([c, a]) => [which(c), a]).filter(([c]) => c);
  for (const [c, a] of tries) if (spawnSync(c, a, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return true;
  return false;
}

// ---------- where ----------

const WHERE = {
  global: 'In all your projects',
  project: 'Only in this project, shared through git',
  local: 'Only in this project, just for you',
};
function projectDir() {
  const git = which('git');
  if (!git) return null;
  const r = spawnSync(git, ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// ---------- the agents ----------

// Gemini CLI and OpenCode (checked 2026-11-23 against Gemini 0.70.0 and OpenCode 1.19.6: add, state, a full
// sign-in ending in Connected, remove).
const noAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const trusted = () => ({ ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }); // only ever in Stets' own folder
/** A project's .gemini/settings.json, written as `gemini mcp add --scope project --transport http` would. */
const geminiProject = jsonFile({ key: 'mcpServers', entry: (u) => ({ url: u, type: 'http' }), file: (scope, dir) => path.join(dir, '.gemini', 'settings.json') });
const geminiFile = (ctx) => (ctx.scope === 'project'
  ? path.join(ctx.dir, '.gemini', 'settings.json')
  : path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'settings.json'));

/** `gemini mcp list` -> { listed, url, status, token stored, folder untrusted } for one name. */
function parseGeminiList(out, name) {
  const t = noAnsi(out);
  const m = new RegExp(`^\\S+\\s+${name}: (\\S+) \\((\\w+)\\) - (\\w+)`, 'm').exec(t);
  return {
    listed: !!m, url: m?.[1], status: m?.[3] || '',
    token: t.includes(`Found stored OAuth token for server '${name}'`),
    untrusted: /folder is untrusted/.test(t),
  };
}

const ocDir = () => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
/** OpenCode's config files for a scope, in the order `opencode mcp add` picks (it writes the first that exists,
 *  else opencode.json). Global also loads the older config.json. */
function ocFiles(ctx) {
  if (ctx.scope !== 'project') return ['opencode.json', 'opencode.jsonc', 'config.json'].map((f) => path.join(ocDir(), f));
  const d = ctx.dir;
  return [path.join(d, 'opencode.json'), path.join(d, 'opencode.jsonc'), path.join(d, '.opencode', 'opencode.json'), path.join(d, '.opencode', 'opencode.jsonc')];
}
/** The file that holds `name` (or where a new one goes), and its parsed JSON or the reason it can't be read. */
function ocFind(ctx, name) {
  const files = ocFiles(ctx).filter(exists);
  for (const file of files) {
    const { obj, error, comments } = readJson(file);
    if (error || comments) return { file, error: error || 'has comments' }; // left alone (the CLI's rule)
    if (obj.mcp && obj.mcp[name]) return { file, obj };
  }
  const file = files[0] || ocFiles(ctx)[0];
  const r = readJson(file);
  return r.comments ? { file, error: 'has comments' } : { file, ...r };
}
/** `opencode mcp list` (clack output, ANSI even when piped) -> the status words for one name. */
function parseOpencodeList(out, name) {
  const m = new RegExp(`(?:^|\\s)${name} (connected|needs authentication|needs client registration|failed|disabled|not initialized)\\b`, 'm').exec(noAnsi(out));
  return m ? m[1] : '';
}


/** Claude Code runs in the project only for its project and just-for-you scopes (checked: a project's own servers
 *  wait for your approval there, and its settings' hooks don't run for these commands). */
const claudeCwd = (ctx) => (ctx.scope === 'global' ? undefined : ctx.dir);
/** Codex runs in the project only for its project scope (checked: `mcp list` starts no servers). */
const codexCwd = claudeCwd;
/** Is the claude.ai connector "Stets" connected? Only Claude Code's answer for that connector counts: its Scope line
 *  says claude.ai and its Status line says Connected (a project server can't pass for it). */
async function claudeAiConnected() {
  const c = await runAsync('claude', ['mcp', 'get', 'claude.ai Stets']);
  if (!c.ok) return false;
  const scope = /^\s*Scope:\s*(.+)$/m.exec(c.out)?.[1] ?? '', status = /^\s*Status:\s*(.+)$/m.exec(c.out)?.[1] ?? '';
  return /^claude\.ai\b/i.test(scope) && /connected/i.test(status) && !/fail|not|needs/i.test(status);
}

/**
 * Each agent: detect via state() (null = not on this computer), add, an optional login, remove.
 * state() answers: is a server with this name there (in this scope), at which URL, and can the agent use it.
 * `checked`: how far its flow was checked on 2026-11-23; anything not fully checked shows "beta".
 */
const AGENTS = [
  {
    id: 'claude', name: 'Claude Code', scopes: ['global', 'project', 'local'], checked: 'full', found: () => has('claude'),
    async state(name, url, ctx) {
      const r = await runAsync('claude', ['mcp', 'get', name], { cwd: claudeCwd(ctx) });
      if (r.missing) return null;
      if (!r.ok) {
        // A Stets connector added on claude.ai also shows up in Claude Code (signed in with claude.ai).
        return { present: false, viaClaudeAi: sameUrl(url, DEFAULT_URL) && await claudeAiConnected() };
      }
      const status = /^\s*Status:\s*(.+)$/m.exec(r.out)?.[1] ?? '';
      const scope = /^\s*Scope:\s*(.+)$/m.exec(r.out)?.[1] ?? '';
      return {
        present: true,
        // "User config (available in all your projects)", "Project config (shared via .mcp.json)", "Local config (…)"
        where: /^local/i.test(scope) ? 'local' : /^project/i.test(scope) ? 'project' : 'global',
        url: /^\s*URL:\s*(\S+)/m.exec(r.out)?.[1],
        ready: /connected/i.test(status) && !/fail|not/i.test(status),
        pending: /pending|approv/i.test(status),
        needsLogin: /auth/i.test(status),
        failed: /fail/i.test(status),
        status: status.replace(/^[^A-Za-z]+/, ''),
      };
    },
    add(name, url, ctx) {
      if (ctx.scope === 'project') mustBeSafe(path.join(ctx.dir, '.mcp.json')); // Claude Code writes it itself
      const argv = ['mcp', 'add', '--transport', 'http', '--scope', { global: 'user', project: 'project', local: 'local' }[ctx.scope], name, url];
      say(dim(`  $ claude ${argv.join(' ')}`));
      const r = run('claude', argv, { cwd: claudeCwd(ctx) });
      if (!r.ok) showOutput(r.out);
      return r;
    },
    login: (name, ctx) => runShown('claude', ['mcp', 'login', name, ...(args.flags['no-browser'] ? ['--no-browser'] : [])], { cwd: claudeCwd(ctx) }),
    later: (name) => `claude mcp login ${name}`,
    check: (name) => `claude mcp get ${name}`,
    remove(name, ctx) {
      run('claude', ['mcp', 'logout', name], { cwd: claudeCwd(ctx) }); // the stored token, if any
      const s = { global: 'user', project: 'project', local: 'local' }[ctx.scope];
      say(dim(`  $ claude mcp remove ${name} --scope ${s}`));
      return run('claude', ['mcp', 'remove', name, '--scope', s], { cwd: claudeCwd(ctx) });
    },
  },
  {
    id: 'codex', name: 'Codex CLI', scopes: ['global', 'project'], checked: 'signin', found: () => has('codex'),
    async state(name, url, ctx) {
      const r = await runAsync('codex', ['mcp', 'list', '--json'], { cwd: codexCwd(ctx) });
      if (r.missing) return null;
      let list = [];
      try { list = JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { /* an old Codex: treat as not set up */ }
      const s = list.find((x) => x && x.name === name);
      if (ctx.scope === 'global' && !tomlServer(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), name)) {
        return { present: false }; // the list also shows a project's servers: only the global file counts here
      }
      if (ctx.scope === 'project') {
        const file = path.join(ctx.dir, '.codex', 'config.toml');
        const t = tomlServer(file, name);
        if (!t) return { present: false };
        if (t.error) return { present: false, fileError: `${tilde(file)} ${t.error}` };
        if (t.other) return { present: true, where: 'project', url: t.url, untrusted: !s, status: 'written another way' };
        // Codex reads a project's .codex/config.toml only in folders you trust.
        if (!s) return { present: true, where: 'project', url: t.url, untrusted: true, status: 'folder not trusted in Codex yet' };
      } else if (!s) return { present: false };
      const auth = s.auth_status || '';
      return {
        present: true,
        where: ctx.scope,
        url: s.transport && s.transport.url,
        // o_auth: signed in; unsupported: the server needs no sign-in (a local Stets)
        ready: s.enabled !== false && ['o_auth', 'bearer_token', 'unsupported'].includes(auth),
        needsLogin: auth === 'not_logged_in',
        status: s.enabled === false ? 'turned off in Codex' : auth.replace(/_/g, ' '),
      };
    },
    // Codex starts the sign-in by itself when it sees the server supports it, so this one runs in view.
    signsInOnAdd: (ctx) => ctx.scope === 'global',
    add(name, url, ctx) {
      if (ctx.scope === 'global') return runShown('codex', ['mcp', 'add', name, '--url', url]);
      const file = path.join(ctx.dir, '.codex', 'config.toml');
      tomlAdd(file, name, url); // throws on a link (unsafe)
      say(dim(`  wrote [mcp_servers.${name}] into ${tilde(file)}`) + backupNote(file));
      return { ok: true };
    },
    login: (name, ctx) => runShown('codex', ['mcp', 'login', name, ...(args.flags['no-browser'] ? ['--no-browser'] : [])], { cwd: codexCwd(ctx) }),
    later: (name) => `codex mcp login ${name}`,
    check: (name) => `codex mcp get ${name}`,
    trustHint: 'Codex reads this file once you trust the folder: start codex here, trust it, then run',
    remove(name, ctx) {
      run('codex', ['mcp', 'logout', name], { cwd: codexCwd(ctx) });
      if (ctx.scope === 'project') {
        const file = path.join(ctx.dir, '.codex', 'config.toml');
        const ok = tomlRemove(file, name);
        if (ok) say(dim(`  removed [mcp_servers.${name}] from ${tilde(file)}`));
        return { ok, out: ok ? '' : 'not there' };
      }
      say(dim(`  $ codex mcp remove ${name}`));
      return run('codex', ['mcp', 'remove', name]);
    },
  },
  {
    id: 'gemini', name: 'Gemini CLI', scopes: ['global', 'project'], checked: 'signin', found: () => has('gemini'),
    async state(name, url, ctx) {
      // a project: read its file only; Gemini isn't run there (it would start the project's servers once trusted)
      if (ctx.scope === 'project') {
        const st = await geminiProject.state(name, url, ctx);
        return st.present ? { ...st, hint: this.trustHint } : st;
      }
      const file = geminiFile(ctx);
      const { obj, error } = readJson(file);
      if (error) return { present: false, fileError: `${tilde(file)} ${error}` };
      const e = obj.mcpServers && obj.mcpServers[name];
      if (!e) return { present: false };
      // in Stets' own folder, trusted for this one command (in an untrusted folder Gemini lists even your own
      // servers as "Disabled")
      const r = await runAsync('gemini', ['mcp', 'list'], { env: trusted() });
      if (r.missing) return null;
      const l = parseGeminiList(r.out, name);
      return {
        present: true, where: ctx.scope, url: e.httpUrl || e.url,
        ready: l.status === 'Connected',
        // "Disconnected" = not signed in, sign-in refused, or server down (setup() checks reachability first)
        needsLogin: l.status === 'Disconnected',
        status: l.status === 'Disconnected' && l.token ? 'stored sign-in not accepted' : l.status.toLowerCase(),
      };
    },
    add(name, url, ctx) {
      if (ctx.scope === 'project') return geminiProject.add(name, url, ctx); // the entry `gemini mcp add` would write
      const argv = ['mcp', 'add', '--scope', 'user', '--transport', 'http', name, url];
      say(dim(`  $ gemini ${argv.join(' ')}`));
      const r = run('gemini', argv);
      if (!r.ok) showOutput(r.out);
      return r;
    },
    // No `gemini mcp login`. The headless run of the /mcp auth command signs in and then exits 42, also on
    // success (setup() re-checks state anyway). It asks "[Y/n]" on the terminal, opens the browser itself
    // (ignores BROWSER, NO_BROWSER), and needs Gemini's own sign-in set up (else exit 41). Without a terminal,
    // Gemini would prepend stdin to the -p text, so: terminal only.
    login(name) { // all your projects only: a project's Stets signs in inside Gemini
      if (!TTY || args.flags['no-browser']) { say(dim('  Gemini CLI signs in only with a browser on this computer, from a terminal.')); return { ok: false }; }
      return runShown('gemini', ['--skip-trust', '-p', `/mcp auth ${name}`]);
    },
    later: (name) => `gemini, then /mcp auth ${name}`,
    check: () => 'gemini mcp list',
    trustHint: 'Gemini reads this project\'s settings once you trust the folder: start gemini here, trust it, then /mcp auth stets',
    remove(name, ctx) {
      if (ctx.scope === 'project') return geminiProject.remove(name, ctx);
      say(dim(`  $ gemini mcp remove --scope user ${name}`));
      const r = run('gemini', ['mcp', 'remove', '--scope', 'user', name]);
      // Exit 0 also for "not found". No sign-out command: the token stays in ~/.gemini/mcp-oauth-tokens.json
      // (keyed by name only). Removing that array element (with a backup) is the caller's decision.
      const tokens = path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'mcp-oauth-tokens.json');
      if (r.ok && exists(tokens) && fs.readFileSync(tokens, 'utf8').includes(`"${name}"`)) {
        say(dim(`  Gemini has no sign-out: its Stets sign-in stays in ${tilde(tokens)} (under "${name}").`));
      }
      return { ok: r.ok && /removed from/.test(r.out), out: r.out };
    },
  },
  {
    id: 'opencode', name: 'OpenCode', scopes: ['global', 'project'], checked: 'signin', found: () => has('opencode'),
    async state(name, url, ctx) {
      // OpenCode is only ever run in Stets' own folder: in a project it loads that project's plugins and starts its
      // MCP servers. So a project's Stets is read from its file, and signs in inside OpenCode.
      if (ctx.scope === 'project') {
        const f = ocFind(ctx, name);
        if (f.error) return { present: false, fileError: `${tilde(f.file)} ${f.error}` };
        const e = f.obj.mcp && f.obj.mcp[name];
        return e ? { present: true, where: 'project', url: e.url, ready: true, inApp: true, hint: `Once you trust this project, start OpenCode in it and sign in: ${this.later(name)}` } : { present: false };
      }
      let e;
      // the resolved config as JSON (reads JSONC too); in Stets' own folder that's the global one only
      const c = await runAsync('opencode', ['debug', 'config']);
      try { e = JSON.parse(c.out.slice(c.out.indexOf('{'))).mcp?.[name]; } catch { e = undefined; }
      if (!e) return { present: false };
      // `mcp list` connects to every server (and registers OAuth clients), so only once Stets is there
      const r = await runAsync('opencode', ['mcp', 'list']);
      const s = parseOpencodeList(r.out, name);
      return {
        present: true, where: ctx.scope, url: e.url,
        ready: s === 'connected',
        needsLogin: s === 'needs authentication',
        failed: s === 'failed' || s === 'needs client registration',
        status: s || (e.enabled === false ? 'disabled' : 'unknown'),
      };
    },
    add(name, url, ctx) {
      if (ctx.scope === 'global') {
        const argv = ['mcp', 'add', name, '--url', url];
        say(dim(`  $ opencode ${argv.join(' ')}`));
        const r = run('opencode', argv);
        if (!r.ok) showOutput(r.out);
        return r;
      }
      // No flag for project scope (only the interactive `opencode mcp add`), so write the file it would write.
      const { file, obj, error } = ocFind(ctx, name);
      if (error) { say(`  ${tilde(file)} ${error}: add "${name}": {"type":"remote","url":"${url}"} under "mcp" yourself.`); return { ok: false, manual: true }; }
      obj.mcp = obj.mcp && typeof obj.mcp === 'object' ? obj.mcp : {};
      obj.mcp[name] = { type: 'remote', url };
      writeJson(file, obj);
      say(dim(`  wrote "${name}" into ${tilde(file)}`) + backupNote(file));
      return { ok: true };
    },
    // Opens the browser itself (no --no-browser; BROWSER ignored on macOS), listens on 127.0.0.1:19876 (fixed),
    // works without a terminal. Call it only when not ready: when signed in already, it asks "Re-authenticate?".
    login(name) { // all your projects only, in Stets' own folder
      if (args.flags['no-browser']) { say(dim('  OpenCode signs in only with a browser on this computer (it listens on port 19876).')); return { ok: false }; }
      return runShown('opencode', ['mcp', 'auth', name]);
    },
    later: (name) => `opencode mcp auth ${name}`,
    check: () => 'opencode mcp list',
    remove(name, ctx) {
      if (ctx.scope === 'global') run('opencode', ['mcp', 'logout', name]); // tokens + client registration; exit 0 if none
      // 1.19.6 has no `opencode mcp remove`: take the entry out of the file.
      const { file, obj, error } = ocFind(ctx, name);
      if (error || !obj.mcp || !obj.mcp[name]) return { ok: false, out: error ? `${tilde(file)} ${error}: remove "${name}" under "mcp" yourself` : 'not there' };
      delete obj.mcp[name];
      writeJson(file, obj);
      say(dim(`  removed "${name}" from ${tilde(file)}`));
      return { ok: true };
    },
  },
  cliAgent({
    id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', scopes: ['global'], checked: 'docs', key: 'mcpServers',
    file: () => path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json'),
    addArgs: (n, u) => ['mcp', 'add', '--transport', 'http', n, u],
    removeArgs: (n) => ['mcp', 'remove', n],
    hint: 'In Copilot, type /mcp auth stets to sign in.',
  }),
  {
    ...jsonFile({
      key: 'mcpServers', entry: (u) => ({ url: u }),
      file: (scope, dir) => path.join(scope === 'project' ? dir : home, '.cursor', 'mcp.json'),
      link: (n, u) => `cursor://anysphere.cursor-deeplink/mcp/install?name=${n}&config=${Buffer.from(JSON.stringify({ url: u })).toString('base64')}`,
    }),
    id: 'cursor', name: 'Cursor', scopes: ['global', 'project'], checked: 'signin',
    found: () => hasApp('Cursor') || has('cursor') || has('cursor-agent'),
    hint: 'Cursor asks you to sign in to Stets the first time (Settings, MCP). Its terminal agent: cursor-agent mcp login stets',
  },
  {
    ...jsonFile({
      key: 'servers', entry: (u) => ({ type: 'http', url: u }),
      file: (scope, dir) => (scope === 'project' ? path.join(dir, '.vscode', 'mcp.json')
        : path.join(process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : configHome(), 'Code', 'User', 'mcp.json')),
      link: (n, u) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: n, type: 'http', url: u }))}`,
    }),
    id: 'vscode', name: 'VS Code', scopes: ['global', 'project'], checked: 'add',
    found: () => has('code') || hasApp('Visual Studio Code'),
    hint: 'VS Code asks you to sign in to Stets when it starts the server (MCP servers, stets, Authenticate).',
  },
  cliAgent({
    id: 'antigravity', name: 'Antigravity', bin: 'agy', scopes: ['global'], checked: 'add', key: 'mcpServers',
    file: () => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    addArgs: (n, u) => ['mcp', 'add', n, u],
    removeArgs: (n) => ['mcp', 'remove', n],
    hint: 'Antigravity asks you to sign in to Stets the first time it uses it.',
  }),
  {
    id: 'vibe', name: 'Mistral Vibe', scopes: ['global'], checked: 'add', found: () => has('vibe'),
    async state(name) {
      const file = path.join(env.VIBE_HOME || path.join(home, '.vibe'), 'config.toml');
      if (!exists(file)) return { present: false };
      const block = fs.readFileSync(file, 'utf8').split(/^\[\[mcp_servers\]\]/m).slice(1).find((b) => new RegExp(`^\\s*name\\s*=\\s*"${name}"`, 'm').test(b));
      return block ? { present: true, where: 'global', url: /^\s*url\s*=\s*"([^"]*)"/m.exec(block)?.[1], ready: true, inApp: true } : { present: false };
    },
    // Vibe signs in during its add when the server offers it, like Codex.
    signsInOnAdd: () => !args.flags['no-login'],
    add: (n, u) => runShown('vibe', ['mcp', 'add', n, '--url', u, ...(args.flags['no-login'] ? ['--no-login'] : [])]),
    remove: (n) => runListed('vibe', ['mcp', 'remove', n]),
    hint: 'If Vibe asks, type /mcp login stets in it.',
  },
  cliAgent({
    id: 'droid', name: 'Factory Droid', bin: 'droid', scopes: ['global'], checked: 'docs', key: 'mcpServers',
    file: () => path.join(home, '.factory', 'mcp.json'),
    addArgs: (n, u) => ['mcp', 'add', n, u, '--type', 'http'],
    removeArgs: (n) => ['mcp', 'remove', n],
    hint: 'Sign in from a terminal: droid mcp auth',
  }),
  {
    ...jsonFile({
      key: 'mcpServers', entry: (u) => ({ url: u }),
      file: (scope, dir) => path.join(scope === 'project' ? dir : env.KIRO_HOME || path.join(home, '.kiro'), ...(scope === 'project' ? ['.kiro'] : []), 'settings', 'mcp.json'),
      link: (n, u) => `https://kiro.dev/launch/mcp/add?name=${n}&config=${encodeURIComponent(JSON.stringify({ url: u }))}`,
    }),
    id: 'kiro', name: 'Kiro', scopes: ['global', 'project'], checked: 'docs',
    found: () => has('kiro-cli') || hasApp('Kiro'),
    hint: 'Kiro asks you to sign in to Stets when it connects (turn on MCP support in its settings).',
  },
  cliAgent({
    id: 'devin', name: 'Devin (Windsurf)', bin: 'devin', scopes: ['global'], checked: 'docs', key: 'mcpServers',
    file: () => path.join(configHome(), 'devin', 'mcp_config.json'),
    addArgs: (n, u) => ['mcp', 'add', '-s', 'user', n, u],
    removeArgs: (n) => ['mcp', 'remove', '-s', 'user', n],
    hint: 'Devin asks you to sign in to Stets on first use (or: devin mcp login stets).',
  }),
  cliAgent({
    id: 'qwen', name: 'Qwen Code', bin: 'qwen', scopes: ['global'], checked: 'docs', key: 'mcpServers',
    file: () => path.join(home, '.qwen', 'settings.json'),
    addArgs: (n, u) => ['mcp', 'add', '--transport', 'http', '-s', 'user', n, u],
    removeArgs: (n) => ['mcp', 'remove', '-s', 'user', n],
    hint: 'In Qwen Code, type /mcp to sign in to Stets.',
  }),
  {
    ...jsonFile({ key: 'context_servers', entry: (u) => ({ url: u }), manual: true, file: () => path.join(configHome(), 'zed', 'settings.json') }),
    id: 'zed', name: 'Zed', scopes: ['global'], checked: 'docs',
    found: () => has('zed') || hasApp('Zed'),
    hint: 'Zed asks you to sign in to Stets when it starts the server.',
  },
];

/** The chat apps: a connector there is account-wide (and a Claude one shows up in Claude Code too). They need
 *  a few clicks in the app, so the CLI opens the right page and says what to click. Only for stets.app itself:
 *  the apps reach public addresses only. */
const APPS = [
  {
    id: 'claude-app', name: 'Claude app', sub: 'desktop, web, phone', scopes: ['global'], app: true, checked: 'guide',
    // Anthropic's documented install link: it opens the Add dialog with the name and address filled in.
    page: (url) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Stets&connectorUrl=${encodeURIComponent(url)}`,
    manage: 'https://claude.ai/customize/connectors',
    guide: 'https://stets.app/start/claude',
    steps: ['Check the name (Stets) and the address, and click Add.', 'Click Connect, and sign in to Stets.'],
    note: 'Any plan; on Team and Enterprise an Owner adds it for everyone.',
    async state(name, url) {
      if (!sameUrl(url, DEFAULT_URL)) return null;
      if (!has('claude')) return { present: false, unknown: true };
      return (await claudeAiConnected()) ? { present: true, where: 'global', url, ready: true } : { present: false };
    },
  },
  {
    id: 'chatgpt', name: 'ChatGPT', sub: 'web', scopes: ['global'], app: true, checked: 'guide',
    page: () => 'https://chatgpt.com/plugins',
    manage: 'https://chatgpt.com/plugins',
    guide: 'https://stets.app/start/chatgpt',
    copyUrl: true,
    steps: ['Click +, then "Add custom MCP server".', 'Name: Stets. URL: paste it. Keep OAuth, tick the box, and create it.', 'Click Connect, and sign in to Stets.'],
    note: 'Custom MCP servers depend on your ChatGPT plan (Business, Enterprise and Edu have them).',
    async state(name, url) { return sameUrl(url, DEFAULT_URL) ? { present: false, unknown: true } : null; },
  },
];
for (const a of APPS) {
  a.add = (name, url) => {
    const copied = a.copyUrl && copy(url);
    const page = a.page(url);
    const opened = openUrl(page);
    say(`  ${opened ? 'Your browser opened' : 'Open'} ${bold(page)}`);
    if (a.copyUrl) say(`  ${copied ? 'Copied to your clipboard' : 'The address to paste'}: ${bold(url)}`);
    a.steps.forEach((st, i) => say(`  ${i + 1}. ${st}`));
    say(dim(`  ${a.note} With pictures: ${a.guide}`));
    return { ok: true, guided: true };
  };
  a.remove = () => ({ ok: false, out: `remove it in ${a.name}: ${a.manage}` });
}

/** Waits for Enter (true) or q / s / Esc (false); without a terminal, false at once. */
function waitKey(prompt) {
  if (!TTY) return Promise.resolve(false);
  out.write(`  ${prompt} `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === '\x03') { say(); process.exit(130); }
      if (!['\r', '\n', 'q', 's', 'Q', 'S', '\x1b'].includes(k)) return;
      stdin.off('data', onKey); stdin.setRawMode(false); stdin.pause();
      say();
      resolve(k === '\r' || k === '\n');
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onKey);
  });
}

async function withSpinner(text, work) {
  if (!ANIM) { say(dim(`  ${text}`)); return work; }
  hideCursor();
  let i = 0;
  const timer = setInterval(() => out.write(`\r  ${dim(G.spin[i++ % G.spin.length])} ${dim(text)}\x1b[K`), 80);
  try { return await work; } finally { clearInterval(timer); out.write('\r\x1b[K'); showCursor(); }
}

async function lookAround(name, url, ctx, { apps = true } = {}) {
  const all = apps ? [...AGENTS, ...APPS] : AGENTS;
  const states = await withSpinner(`Looking for your agents${G.dots}`, Promise.all(all.map((a) => ((a.found && !a.found()) ? null : a.state(name, url, ctx).catch(() => null)))));
  return all.map((a, i) => ({ a, st: states[i] })).filter((x) => x.st);
}

function describe(a, st, name, url, scope, statusOnly = false) {
  const d = describeState(a, st, name, url, scope, statusOnly);
  // agents checked from their docs only are never picked for you (nor by --yes): you tick them yourself
  if (a.checked === 'docs' && d.on) d.on = false;
  return d;
}
function describeState(a, st, name, url, scope, statusOnly) {
  if (!a.scopes.includes(scope)) return { note: scope === 'local' ? 'has no just-for-you setting' : 'has no setting per project', on: false, locked: true };
  if (st.fileError) return { note: /link|plain|folder/.test(st.fileError) ? 'its settings file here is a link' : "can't read its settings", on: false, locked: true };
  if (a.app) {
    if (st.present) return { note: 'connected', on: false };
    if (statusOnly) return { note: st.unknown ? "can't be checked from here" : 'not connected', on: false };
    return { note: 'opens the page; you click Add', on: false };
  }
  if (!st.present) return st.viaClaudeAi ? { note: 'connected through claude.ai', on: false } : { note: 'not set up yet', on: true };
  if (st.where && st.where !== scope) {
    if (st.where === 'global') return { note: 'already in all your projects', on: false };
    if (scope !== 'global') return { note: st.where === 'project' ? 'already in this project (shared)' : 'already in this project, just for you', on: false };
    return { note: 'set up for this project only', on: true };
  }
  if (!sameUrl(st.url, url)) return { note: `has a "${name}" for ${clean(st.url) || 'another address'}`, on: false, locked: true };
  if (st.untrusted) return { note: st.status === 'written another way' ? 'added (written another way); trust this folder in Codex' : 'added; trust this folder in Codex', on: false };
  if (st.pending) return { note: 'added; approve it when Claude Code asks', on: false };
  if (st.ready) return { note: st.inApp ? 'added; you sign in inside it' : 'connected', on: false };
  if (st.failed) return { note: "added, but it can't connect", on: true };
  return { note: 'added, not signed in yet', on: true };
}

// ---------- menus ----------

/**
 * A Stripe-style menu. Checkboxes by default (resolves to the chosen rows); with single, one choice (resolves
 * to that row). Rows with `section` get a divider above the first of them. Resolves to null when the person quits.
 */
function picker(title, rows, { single = false } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let at = rows.findIndex((r) => r.on && !r.locked);
    if (at < 0) at = Math.max(0, rows.findIndex((r) => !r.locked));
    let shown = 0;
    const labelW = Math.max(...rows.map((r) => visible(r.label))) + 3;
    const room = Math.max(10, (out.columns || 80) - labelW - 14);
    for (const r of rows) if (r.note && r.note.length > room) r.note = r.note.slice(0, room - 1) + (ASCII ? '~' : '…');
    const render = () => {
      const body = ['', ` ${bold(title)}`, ''];
      let section = null;
      rows.forEach((r, i) => {
        if (r.section && r.section !== section) {
          body.push('', dim(` ${G.h.repeat(10)} ${r.section} ${G.h.repeat(10)}`), '');
        }
        section = r.section || section;
        const mark = single ? (i === at ? '(*)' : '( )') : r.locked ? dim(`[${G.off}]`) : `[${r.on ? green(G.on) : dim(G.off)}]`;
        const label = r.locked ? dim(padTo(r.label, labelW)) : padTo(r.label, labelW);
        body.push(`${i === at ? G.ptr : ' '} ${mark} ${label}${dim(r.note || '')}`);
      });
      body.push('', dim(single ? ` arrows choose ${G.sep} enter go ${G.sep} q quit` : ` space toggle ${G.sep} a all ${G.sep} enter go ${G.sep} q quit`), '');
      const w = Math.max(...body.map(visible)) + 2;
      const lines = [G.tl + G.h.repeat(w + 2) + G.tr, ...body.map((l) => `${G.v} ${padTo(l, w)} ${G.v}`), G.bl + G.h.repeat(w + 2) + G.br];
      shown = draw(lines.map((l) => `  ${l}`), shown);
    };
    const done = (value) => {
      stdin.off('data', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      showCursor();
      resolve(value);
    };
    const move = (d) => {
      for (let k = 0; k < rows.length; k++) { at = (at + d + rows.length) % rows.length; if (!rows[at].locked) break; }
    };
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === '\x03') { done(null); say(); process.exit(130); }
      else if (k === 'q' || k === 'Q' || k === '\x1b') return done(null);
      else if (k === '\r' || k === '\n') return done(single ? rows[at] : rows.filter((r) => r.on && !r.locked));
      else if (k === ' ' && !single) { if (!rows[at].locked) rows[at].on = !rows[at].on; }
      else if ((k === 'a' || k === 'A') && !single) { const open = rows.filter((r) => !r.locked); const all = open.every((r) => r.on); open.forEach((r) => { r.on = !all; }); }
      else if (k === '\x1b[A' || k === '\x1bOA' || k === 'k') move(-1);
      else if (k === '\x1b[B' || k === '\x1bOB' || k === 'j' || k === '\t') move(1);
      render();
    };
    hideCursor();
    render();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  });
}

// ---------- commands ----------

function target() {
  const url = String(args.flags.url || env.STETS_URL || DEFAULT_URL);
  let u;
  try { u = new URL(url); } catch { fail(`--url must be an address like ${DEFAULT_URL}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) fail('--url must be https (or http on localhost).');
  if (u.username || u.password) fail('--url can\'t hold a name or a password.');
  if (u.search || u.hash) fail(`--url can't hold a ? or a #: give the MCP address itself, like ${DEFAULT_URL}`);
  if (WIN && CMD_UNSAFE.test(u.href)) fail('--url holds a character Windows reads as a command (& | < > ^ % ! " ( )).');
  const name = String(args.flags.name || 'stets');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)) fail('--name may hold letters, digits, - and _ only.');
  const scope = args.flags.scope ? String(args.flags.scope) : null;
  if (scope && !Object.hasOwn(WHERE, scope)) fail('--scope is global (all your projects), project (this project, shared through git) or local (this project, just for you).');
  const official = u.hostname === new URL(DEFAULT_URL).hostname;
  return { url: u.href.replace(/\/$/, u.pathname === '/' ? '/' : ''), name, host: u.host, scope, trusted: official || local };
}

/** Another server than stets.app gets everything your agents send it, and your sign-in: say so, and ask. */
async function confirmServer(host) {
  say(red(`  ${G.warn} ${host} is not stets.app.`));
  say('  Your agents will send this server what you ask them, and sign in to it.');
  say('  Only go on if you run it yourself, or trust who does.');
  if (args.flags['trust-url']) return true;
  if (!TTY) fail(`${host} is not stets.app: add --trust-url to set it up without a terminal.`);
  return waitKey(`Press Enter to go on with ${host}, q to stop:`);
}

/** Any HTTP answer means a server is there (Stets answers /mcp with 401 or 405 to a plain GET). */
async function reachable(url) {
  const knock = async (u) => {
    try { await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) }); return true; } catch { return false; }
  };
  if (await knock(url)) return true;
  // Node 18 tries only the first address for localhost (often ::1), while a local Stets listens on 127.0.0.1
  const u = new URL(url);
  if (u.hostname !== 'localhost') return false;
  u.hostname = '127.0.0.1';
  return knock(u.href);
}

/** The project folder and scope: asked in a menu only inside a git project, else all your projects. */
async function where(scopeFlag) {
  const dir = projectDir();
  if (scopeFlag) {
    if (scopeFlag !== 'global' && !dir) say(dim(`  Not in a git project, so "this project" is this folder: ${tilde(process.cwd())}`));
    return { scope: scopeFlag, dir: dir || process.cwd() };
  }
  if (!dir || !TTY || args.flags.yes || args.flags.agents) return { scope: 'global', dir: dir || process.cwd() };
  const rows = Object.entries(WHERE).map(([id, label]) => ({ id, label, note: id === 'global' ? '' : path.basename(dir) }));
  const pick = await picker('Where should your agents have Stets?', rows, { single: true });
  if (!pick) { say(dim('  Nothing changed.')); process.exit(0); }
  say();
  return { scope: pick.id, dir };
}

async function setup() {
  const { url, name, host, scope: scopeFlag, trusted: known } = target();
  await greet(['Hi, I\'m Stet. Let\'s get your agent', `building websites with ${host}.`]);
  if (!known && !(await confirmServer(host))) { say(dim('  Nothing changed.')); return; }
  if (!(await withSpinner(`Knocking on ${host}${G.dots}`, reachable(url)))) {
    fail(`Can't reach ${url}. Check the address${['localhost', '127.0.0.1'].some((h) => host.startsWith(h)) ? ', and that Stets is running there' : ' and your internet connection'}. Nothing was changed.`);
  }
  const ctx = await where(scopeFlag);
  useScope(ctx);
  const found = await lookAround(name, url, ctx, { apps: ctx.scope === 'global' });
  if (!found.some((f) => !f.a.app)) {
    say(`  I can't find a coding agent on this computer (${AGENTS.map((a) => a.name).join(', ')}).`);
    if (!found.length) {
      say(`  Use Stets in the Claude or ChatGPT app instead: ${bold('https://stets.app/start')}`);
      process.exitCode = 1;
      return;
    }
  }
  const rows = found.map(({ a, st }) => ({
    a, st, section: a.app ? 'OR, in a chat app' : undefined,
    label: `${a.name}${a.sub ? dim(` (${a.sub})`) : ''}${a.checked === 'full' || a.app ? '' : dim(' beta')}`,
    ...describe(a, st, name, url, ctx.scope),
  }));

  let chosen;
  if (args.flags.agents) {
    const ids = String(args.flags.agents).split(',').map((s) => s.trim()).filter(Boolean);
    const known = [...AGENTS, ...APPS];
    for (const id of ids) if (!known.some((a) => a.id === id)) fail(`Unknown agent "${id}". Known: ${known.map((a) => a.id).join(', ')}`);
    chosen = rows.filter((r) => ids.includes(r.a.id));
    for (const id of ids) if (!chosen.some((r) => r.a.id === id)) say(yellow(`  ${G.warn} ${known.find((a) => a.id === id).name} is not on this computer.`));
  } else if (args.flags.yes) {
    chosen = rows.filter((r) => r.on && !r.a.app);
  } else if (rows.every((r) => r.locked)) {
    chosen = rows; // nothing to pick: say why below
  } else if (TTY) {
    chosen = await picker(`Pick where to add Stets (${WHERE[ctx.scope].toLowerCase()}):`, rows);
    if (!chosen) { say(dim('  Nothing changed.')); return; }
    say();
  } else {
    fail(`Not a terminal, so no menu: add --agents claude,codex or --yes (${CMD} help).`);
  }
  for (const r of chosen.filter((r) => r.locked)) say(yellow(`  ${G.warn} ${r.a.name} ${r.note}: left as it is.${r.note.startsWith('has a') ? ' Use --name to add a second one.' : ''}`));
  chosen = chosen.filter((r) => !r.locked);
  if (!chosen.length) { say(dim('  Nothing to do.')); return; }

  say(bold(`Setting up Stets ${WHERE[ctx.scope].toLowerCase()}:`));
  let told = false;
  const beforeSignIn = () => {
    if (told) return;
    told = true;
    say(dim(args.flags['no-browser']
      ? `  Open the address below in a browser and sign in to ${host}, then paste the address you land on.`
      : `  When your browser opens, sign in to ${host}. Signed in there already? Then it's one click: Allow.`));
  };
  let added = 0, connected = 0, inApp = 0, errors = 0;
  const touched = []; // the agents this run added Stets to: the undo line names only these
  // The chat apps first: a Claude connector also covers Claude Code, which then needs nothing more.
  chosen.sort((x, y) => (y.a.app ? 1 : 0) - (x.a.app ? 1 : 0));
  for (const r of chosen) {
    const a = r.a;
    say();
    say(`  ${bold(a.name)}`);
    if (a.app) {
      a.add(name, url, ctx);
      if (a.id === 'claude-app' && has('claude') && await waitKey(dim('Press Enter once it says Connected (s to skip):'))) {
        const st = await a.state(name, url, ctx);
        if (st && st.present) { connected++; say(`  ${green(G.ok)} connected`); continue; }
        say(dim(`  Not connected yet. You can finish it later: ${a.manage}`));
      }
      inApp++;
      continue;
    }
    let st = r.st;
    if (a.id === 'claude' && ctx.scope === 'global' && !st.present && chosen.some((c) => c.a.id === 'claude-app')) {
      const again = (await a.state(name, url, ctx)) || st;
      if (again.viaClaudeAi) { connected++; say(`  ${green(G.ok)} has Stets through the Claude app now: nothing more to add`); continue; }
    }
    if (!st.present || st.where !== ctx.scope) {
      if (a.signsInOnAdd && a.signsInOnAdd(ctx)) beforeSignIn();
      let res;
      try { res = a.add(name, url, ctx); } catch (e) { errors++; say(`  ${red(G.no)} ${clean(e.message)}`); continue; }
      if (res.ok) touched.push(a.id);
      if (res.manual) { inApp++; if (a.hint) say(dim(`  ${a.hint}`)); continue; }
      // Codex signs in during its add; if that sign-in is broken off, it may exit non-zero with Stets added.
      st = (await a.state(name, url, ctx)) || st;
      if (!st.present && res.ok) { inApp++; say(`  ${green(G.ok)} added (the agent says so; I can't see it in its settings from here)`); if (a.hint) say(dim(`  ${a.hint}`)); continue; }
      if (!st.present) { errors++; say(`  ${red(G.no)} could not add Stets`); continue; }
      if (!res.ok) say(dim('  (the agent reported a problem, but Stets is added)'));
      added++;
      say(`  ${green(G.ok)} added`);
    }
    if (st.inApp) { inApp++; say(dim(`  ${st.hint || a.hint || `${a.name} asks you to sign in to ${host} the first time it uses Stets.`}`)); continue; }
    if (st.pending) { inApp++; say(dim(`  Claude Code asks you to approve "${name}" the next time you start it in this project, then: ${a.later(name)}`)); continue; }
    if (st.untrusted) { inApp++; say(dim(`  ${a.trustHint}: ${a.later(name)}`)); continue; }
    if (st.ready) { connected++; say(`  ${green(G.ok)} connected`); continue; }
    if (st.failed) { errors++; say(`  ${red(G.no)} ${a.name} can't connect to ${host}. Check with: ${a.check(name)}`); continue; }
    if (args.flags['no-login'] || !a.login) { say(dim(`  sign in later: ${a.later(name)}`)); continue; }
    beforeSignIn();
    a.login(name, ctx);
    st = (await a.state(name, url, ctx)) || st;
    if (st.ready) { connected++; say(`  ${green(G.ok)} signed in`); }
    else { errors++; say(`  ${yellow(G.warn)} not signed in yet (${clean(st.status) || 'unknown'}). Try again: ${a.later(name)}`); }
  }
  say();
  say(`${added} added, ${connected} connected, ${inApp ? `${inApp} to finish in the ${inApp === 1 ? 'agent' : 'agents'}, ` : ''}${errors} ${errors === 1 ? 'problem' : 'problems'}`);
  if (errors) process.exitCode = 1;
  if (!errors && (connected || inApp)) {
    say();
    const first = (chosen.find((c) => !c.a.app) || chosen[0]).a.name;
    const head = connected ? `${bold('Done!')} Now open ${first} and say:` : `${bold('Nearly there.')} Finish the steps above, then tell ${first}:`;
    const app = chosen.find((c) => c.a.app);
    const undo = touched.length ? `Undo: ${CMD} agent remove --agents ${touched.join(',')}${sameFlags(ctx.scope)}` : app ? `Undo: in ${app.a.name}, ${app.a.manage}` : '';
    draw(scene(connected ? 'cheer' : 'wave', [head, '"Make me a website for my bakery."', dim(undo)]));
    say();
  }
}

/** The --url, --name and --scope this run used, so a printed command does the same. */
function sameFlags(scope) {
  const { url, name } = target();
  return `${sameUrl(url, DEFAULT_URL) ? '' : ` --url ${url}`}${name === 'stets' ? '' : ` --name ${name}`}${scope && scope !== 'global' ? ` --scope ${scope}` : ''}`;
}

async function status() {
  const { url, name, scope } = target();
  const ctx = { scope: scope || 'global', dir: projectDir() || process.cwd() };
  useScope(ctx);
  const found = await lookAround(name, url, ctx);
  if (!found.length) { say('  No agents found on this computer.'); return; }
  say(dim(`  ${WHERE[ctx.scope]}${ctx.scope === 'global' ? '' : ` (${tilde(ctx.dir)})`}:`));
  const w = Math.max(...found.map((f) => f.a.name.length)) + 4;
  for (const { a, st } of found) {
    const d = describe(a, st, name, url, ctx.scope, true);
    const good = /^connected|added \(signs in|already in all/.test(d.note);
    const mark = good ? green(G.ok) : d.locked ? yellow(G.warn) : dim(G.off);
    say(`  ${mark} ${padTo(a.name, w)}${d.note}`);
  }
}

async function remove() {
  const { url, name, scope } = target();
  const ctx = { scope: scope || 'global', dir: projectDir() || process.cwd() };
  useScope(ctx);
  const ids = args.flags.agents ? String(args.flags.agents).split(',').map((x) => x.trim()).filter(Boolean) : null;
  const found = (await lookAround(name, url, ctx)).filter(({ a }) => !ids || ids.includes(a.id));
  const targets = [];
  for (const { a, st } of found) {
    if (a.app) { if (st.present) say(dim(`  ${a.name} has Stets as a connector: remove it there (${a.manage}).`)); continue; }
    if (!a.scopes.includes(ctx.scope) || !st.present || st.where !== ctx.scope) continue;
    if (!sameUrl(st.url, url)) { say(dim(`  ${a.name}: "${name}" points at ${clean(st.url) || 'another address'}, left as it is.`)); continue; }
    targets.push({ a, st });
  }
  if (!targets.length) {
    say(dim(`  No agent here has Stets ${WHERE[ctx.scope].replace(/^In all/, 'in all').replace(/^Only/, 'only')}.`));
  } else if (!ids && !args.flags.yes) {
    // Without --agents this would take Stets out of every agent, also ones set up some other way: ask first.
    say(`  Stets will be taken out of: ${bold(targets.map((t) => t.a.name).join(', '))}`);
    if (!TTY) fail(`Not a terminal, so no question: add --agents <ids> (or --yes for all of them).`);
    if (!(await waitKey(dim('Press Enter to go on, q to keep them:')))) { say(dim('  Nothing changed.')); return; }
  }
  for (const { a } of targets) {
    let r;
    try { r = a.remove(name, ctx); } catch (e) { r = { ok: false, out: e.message }; }
    if (r.ok) say(`  ${green(G.ok)} ${a.name}: Stets removed`);
    else say(`  ${red(G.no)} ${a.name}: ${clean(String(r.out || '').trim().split('\n')[0])}`);
  }
  for (const { a, st } of found) if (st.viaClaudeAi) say(dim(`  ${a.name} also has Stets through claude.ai: remove it there (Settings, Connectors).`));
}

function help() {
  const lines = [
    `${bold('stets.app')} ${VERSION}: connects your agents to Stets, the website builder you talk to.`,
    '',
    bold('Usage'),
    `  ${CMD} agent setup     Add Stets to your agents and sign them in`,
    `  ${CMD} agent status    Show where Stets is set up`,
    `  ${CMD} agent remove    Take Stets out again`,
    dim('  (installed with npm i -g stets.app, the command is just: stets)'),
    '',
    bold('Options'),
    `  --agents <ids>        Pick without the menu: ${[...AGENTS, ...APPS].map((a) => a.id).join(',')}`,
    '  -y, --yes             Without the menu: every coding agent that needs it (not docs-only ones)',
    '  --scope <where>       global: all your projects (default)',
    '                        project: this project, shared through git',
    '                        local: this project, just for you (Claude Code)',
    `  --url <url>           Another Stets (default ${DEFAULT_URL}; or STETS_URL)`,
    '  --name <name>         The server\'s name in the agent (default stets)',
    '  --no-login            Only add Stets; sign in later from the agent',
    '  --no-browser          Don\'t open a browser (sign-in over SSH)',
    '  --trust-url           Set up a server other than stets.app without asking',
    '  --ascii, --no-color   Plain output (NO_COLOR works too)',
  ];
  say();
  draw(ASCII ? scene('stand', [bold('Stets') + dim(` ${VERSION}`), 'Websites your agent builds.']) : masthead());
  say();
  for (const l of lines) say(l ? `  ${l}` : '');
  say();
}

async function main() {
  if (args.flags.version) return say(VERSION);
  const [cmd, sub] = args._;
  if (args.flags.help || !cmd || cmd === 'help') return help();
  if (cmd === 'login') {
    say(`  No separate sign-in: each agent signs in to Stets itself, during ${bold(`${CMD} agent setup`)}.`);
    return;
  }
  if (cmd === 'setup' || (cmd === 'agent' && sub === 'setup')) return setup();
  if (cmd === 'status' || (cmd === 'agent' && (sub === 'status' || !sub))) return status();
  if (cmd === 'remove' || (cmd === 'agent' && sub === 'remove')) return remove();
  fail(`Unknown command "${clean(args._.join(' '))}". See: ${CMD} help`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
