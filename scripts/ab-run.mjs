#!/usr/bin/env node
// Run the A/B eval cases without `claude plugin eval`.
//
// `claude plugin eval` cannot grant Bash on Windows (its sandbox is not available there),
// and the cases need a shell: agents run `node --test` and `node .eval/check.mjs`.
// This runner starts `claude -p` itself for every case and run, grades the result and
// writes the same JSON shape as `claude plugin eval --json`, so
// `node scripts/ab-compare.mjs baseline.json active.json` works on its output.
//
// WARNING: the agents' shell is NOT confined. They run with your user rights, as in a
// normal Claude Code session; only the working folder is a fresh temp folder.
//
// Node built-ins only. Run `node scripts/ab-run.mjs --help`.

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------
// Pure helpers (unit-tested in ab-run.test.mjs)
// ---------------------------------------------------------------------------------------

/** Split `s` on top-level commas, ignoring commas inside quotes, brackets and braces. */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/** Parse one YAML scalar or flow value (the subset the eval files use). */
function parseValue(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) return splitTopLevel(s.slice(1, -1)).map(parseValue);
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      obj[part.slice(0, i).trim()] = parseValue(part.slice(i + 1));
    }
    return obj;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Parse the YAML subset used by case.yaml and the frontmatter: `key: value` with one-level nesting. */
export function parseYaml(text) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  function block(start, indent) {
    const obj = {};
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) break;
      const m = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      if (!m) {
        i++;
        continue;
      }
      if (m[2] === '' && i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent > lineIndent) {
          const [child, after] = block(i + 1, nextIndent);
          obj[m[1]] = child;
          i = after;
          continue;
        }
      }
      obj[m[1]] = parseValue(m[2]);
      i++;
    }
    return [obj, i];
  }
  return block(0, 0)[0];
}

/** Split `---` frontmatter from the body. */
export function parseFrontmatter(text) {
  const t = text.replace(/\r\n?/g, '\n');
  if (t.startsWith('---\n')) {
    const end = t.indexOf('\n---', 4);
    if (end >= 0) {
      const after = t.indexOf('\n', end + 1);
      return { data: parseYaml(t.slice(4, end)), body: (after < 0 ? '' : t.slice(after + 1)).trim() };
    }
  }
  return { data: {}, body: t.trim() };
}

/** A grader file: frontmatter config plus the body (pattern or criteria). */
export function parseGraderFile(fileName, text) {
  const { data, body } = parseFrontmatter(text);
  return { name: fileName.replace(/\.md$/, ''), ...data, weight: typeof data.weight === 'number' ? data.weight : 1, body };
}

const dirnameAny = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));

/** Is this the WSL launcher (C:\Windows\System32\bash.exe)? It cannot run our scaffolds. */
export function isBlockedBash(p) {
  return /[\\/]system32[\\/]bash\.exe$/i.test(p);
}

/** Find a real bash. On Windows: Git Bash only, never the WSL launcher. */
export function resolveBash({ platform, env, exists }) {
  if (platform !== 'win32') return 'bash';
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (c && !isBlockedBash(c) && exists(c)) return c;
  }
  return null;
}

/** Parse the stream-json output of `claude -p`. */
export function parseTrace(text) {
  const toolUses = [];
  const mainIds = new Set();
  let anonymousMain = 0;
  // A run resumed by background agents emits one `result` per lead turn: `result` keeps the
  // last one (the final outcome), turns add up across all of them, and the cost, which is
  // cumulative for the session, is taken as the largest value seen.
  let result = null;
  let resultTurns = null;
  let maxCost = null;
  let durationSum = null;
  let lastMainText = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (ev.type === 'result') {
      result = ev;
      if (typeof ev.num_turns === 'number') resultTurns = (resultTurns ?? 0) + ev.num_turns;
      if (typeof ev.total_cost_usd === 'number') maxCost = maxCost === null ? ev.total_cost_usd : Math.max(maxCost, ev.total_cost_usd);
      if (typeof ev.duration_ms === 'number') durationSum = (durationSum ?? 0) + ev.duration_ms;
    } else if (ev.type === 'assistant' && ev.message) {
      const parent = ev.parent_tool_use_id ?? null;
      if (parent === null) {
        if (ev.message.id) mainIds.add(ev.message.id);
        else anonymousMain++;
      }
      for (const block of Array.isArray(ev.message.content) ? ev.message.content : []) {
        if (block.type === 'tool_use') {
          toolUses.push({ name: block.name, input: block.input ?? {}, id: block.id, parent });
        } else if (block.type === 'text' && parent === null && typeof block.text === 'string') {
          lastMainText = block.text;
        }
      }
    }
  }
  const mainTurns = mainIds.size + anonymousMain;
  const resultText = typeof result?.result === 'string' && result.result !== '' ? result.result : null;
  return {
    result,
    toolUses,
    mainTurns,
    turns: resultTurns ?? mainTurns,
    costUsd: maxCost,
    // Sum of the per-turn durations, informational only: the runner records wall-clock time.
    durationMs: durationSum,
    // Only the last result decides: earlier lead turns may legitimately end mid-work.
    isError: result?.is_error === true,
    lastMessage: resultText ?? lastMainText ?? '',
  };
}

/** Glob to RegExp: `*` and `?` stay inside a path segment, `**` crosses folders. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const verdict = (passed, explanation) => ({ passed, explanation });

/** regex grader: the body is the pattern; target is the last message (default) or a workspace file. */
export function gradeRegex(g, ctx) {
  try {
    const target = g.target ?? { source: 'last_message' };
    const text = target.source === 'file' ? ctx.readFile(target.path) : ctx.lastMessage;
    const mode = String(g.match ?? 'contains');
    const flags = String(g.flags ?? '');
    if (mode.startsWith('count:')) {
      const want = Number(mode.slice(6));
      const found = (text.match(new RegExp(g.body, flags.includes('g') ? flags : `${flags}g`)) ?? []).length;
      return verdict(found === want, `found ${found} match(es), wanted ${want}`);
    }
    const hit = new RegExp(g.body, flags).test(text);
    if (mode === 'not_contains') return verdict(!hit, hit ? 'pattern matched' : 'pattern absent');
    return verdict(hit, hit ? 'pattern matched' : 'pattern not found');
  } catch (e) {
    return verdict(false, String(e?.message ?? e));
  }
}

/** tool_used grader: count tool calls by name, optionally filtered by a pattern on the input JSON. */
export function gradeToolUsed(g, ctx) {
  try {
    let matcher = null;
    if (g.input_match !== undefined) {
      try {
        const re = new RegExp(String(g.input_match), 'i');
        matcher = (s) => re.test(s);
      } catch {
        matcher = (s) => s.toLowerCase().includes(String(g.input_match).toLowerCase());
      }
    }
    const n = ctx.toolUses.filter((u) => u.name === g.tool && (!matcher || matcher(JSON.stringify(u.input)))).length;
    const min = typeof g.min === 'number' ? g.min : g.max === undefined ? 1 : 0;
    const max = typeof g.max === 'number' ? g.max : Infinity;
    return verdict(n >= min && n <= max, `${g.tool} used ${n} time(s), wanted ${min}..${max === Infinity ? 'any' : max}`);
  } catch (e) {
    return verdict(false, String(e?.message ?? e));
  }
}

/** file_exists grader: a file matching the glob that did not exist right after the scaffold. */
export function gradeFileExists(g, ctx) {
  try {
    const re = globToRegExp(String(g.path));
    const found = ctx.listFiles().filter((f) => re.test(f) && !ctx.initialFiles.has(f));
    return verdict(found.length > 0, found.length ? `new file(s): ${found.join(', ')}` : `no new file matches ${g.path}`);
  } catch (e) {
    return verdict(false, String(e?.message ?? e));
  }
}

/** Read the judge's answer: PASS or FAIL on the first line, then the reason. */
export function parseJudgeReply(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const first = (lines.find((l) => l.trim() !== '') ?? '').replace(/[*#`_]/g, '').trim();
  const m = /^(PASS|FAIL)\b[\s:.\-]*(.*)$/i.exec(first);
  if (!m) return { passed: false, explanation: `unclear judge reply: ${String(text ?? '').trim().slice(0, 200)}` };
  const rest = lines.slice(lines.findIndex((l) => l.trim() !== '') + 1).join('\n').trim();
  const reason = [m[2], rest].filter(Boolean).join('\n').trim();
  return { passed: m[1].toUpperCase() === 'PASS', explanation: reason || first };
}

export function buildJudgePrompt(g, focusText) {
  return [
    'You are grading the result of an automated coding run. Apply the criteria below to the input.',
    'Reply with PASS or FAIL as the first line (nothing else on it), then a short reason.',
    '',
    '## Criteria',
    g.body,
    '',
    '## Input',
    focusText,
  ].join('\n');
}

/**
 * Run every grader. `judge(prompt)` resolves to { text, costUsd }; pass null to skip llm graders.
 * A grader that throws counts as failed, with its message as the explanation.
 */
export async function gradeAll(graders, ctx, judge) {
  const graded = [];
  let judgeCostUsd = 0;
  for (const g of graders) {
    let v;
    try {
      if (g.type === 'regex') v = gradeRegex(g, ctx);
      else if (g.type === 'tool_used') v = gradeToolUsed(g, ctx);
      else if (g.type === 'file_exists') v = gradeFileExists(g, ctx);
      else if (g.type === 'llm') {
        if (!judge) {
          v = verdict(false, 'skipped (no judge)');
        } else {
          const focus = g.focus?.source === 'file' ? ctx.readFile(g.focus.path) : ctx.lastMessage;
          const reply = await judge(buildJudgePrompt(g, focus));
          if (typeof reply?.costUsd === 'number') judgeCostUsd += reply.costUsd;
          v = parseJudgeReply(reply?.text);
        }
      } else {
        v = verdict(false, `unknown grader type: ${g.type}`);
      }
    } catch (e) {
      v = verdict(false, String(e?.message ?? e));
    }
    graded.push({ name: g.name, type: g.type, weight: g.weight, passed: v.passed, explanation: v.explanation, withOnly: false, scored: true });
  }
  return { graders: graded, judgeCostUsd };
}

/** Weighted share of passed graders, 0..1. */
export function scoreOf(results) {
  const total = results.reduce((s, r) => s + r.weight, 0);
  if (total <= 0) return 0;
  return results.reduce((s, r) => s + (r.passed ? r.weight : 0), 0) / total;
}

const REMOVED_VARS = [
  'CLAUDE_CODE_PLUGIN_DIRS',
  'MODEL_ESCALATOR_BASELINE',
  'EVAL_MODEL_ESCALATOR_MODE',
  'EVAL_MODEL_ESCALATOR_BASELINE',
];

/** Environment of a run. Never touches the config dir (the user's login stays). */
export function buildEnv({ base, arm, baseline, platform, bashPath }) {
  const env = { ...base };
  const removed = [];
  for (const k of REMOVED_VARS) {
    if (k in env) {
      delete env[k];
      removed.push(k);
    }
  }
  const set = { MODEL_ESCALATOR_MODE: arm, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
  if (baseline) set.MODEL_ESCALATOR_BASELINE = baseline;
  Object.assign(env, set);
  let pathPrefix = null;
  if (platform === 'win32' && bashPath) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    pathPrefix = dirnameAny(bashPath);
    env[key] = `${pathPrefix};${env[key] ?? ''}`;
  }
  return { env, diff: { set, removed, pathPrefix } };
}

/** Tools the lead and its subagents get besides the case's own list. */
export const DEFAULT_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Agent', 'mcp__model-escalator__ask_for_help'];

/** Arguments of `claude`; the prompt goes on stdin. No permission bypass. */
export function buildClaudeArgs({ pluginDir, model, allowedTools, permissionMode }) {
  const args = [
    '-p',
    '--plugin-dir', pluginDir,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  args.push('--allowedTools', ...allowedTools);
  return args;
}

export function selectCases(cases, { caseGlob, tag } = {}) {
  const re = caseGlob ? globToRegExp(caseGlob) : null;
  return cases.filter((c) => (!re || re.test(c.name)) && (!tag || (c.tags ?? []).includes(tag)));
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function buildCaseEntry({ name, dir, promptMarkdown, timeoutSeconds, maxTurns, graders, runs, runsPerCase }) {
  return {
    name,
    dir,
    source: 'plugin',
    promptMarkdown,
    runsPerCase,
    timeoutSeconds,
    maxTurns,
    graders,
    arms: { with: runs },
    aggregates: {
      score: mean(runs.map((r) => r.score)),
      passRate: runs.length ? runs.filter((r) => r.passed).length / runs.length : 0,
    },
  };
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function buildResultJson({ claudeVersion, startedAt, durationSeconds, partial, modelOverride, caseFilter, arm, cases }) {
  let cost = 0;
  for (const c of cases) {
    for (const r of c.arms.with) {
      if (typeof r.costUsd === 'number') cost += r.costUsd;
      if (typeof r.judgeCostUsd === 'number') cost += r.judgeCostUsd;
    }
  }
  return {
    schemaVersion: 1,
    claudeVersion,
    startedAt,
    durationSeconds,
    costUsd: round6(cost),
    partial,
    suite: {
      root: 'plugin',
      ablation: 'none',
      threshold: 1,
      modelOverride: modelOverride ?? null,
      caseFilter: caseFilter ?? null,
      arm: arm ?? null,
      runner: 'ab-run',
    },
    cases,
    aggregates: {
      casesTotal: cases.length,
      casesPassed: cases.filter((c) => c.aggregates.passRate === 1).length,
      overallScore: mean(cases.map((c) => c.aggregates.score)),
      overallPassRate: mean(cases.map((c) => c.aggregates.passRate)),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Shell: files, processes, orchestration
// ---------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/ab-run.mjs --arm baseline|active [options]

Runs the A/B eval cases with \`claude -p\` (no sandboxed runner) and writes a result
file in the shape of \`claude plugin eval --json\`, readable by scripts/ab-compare.mjs.

options:
  --arm <baseline|active>   MODEL_ESCALATOR_MODE of the run (required)
  --case <glob>             only cases whose name matches (e.g. 'paginate-*')
  --tag <tag>               only cases with this tag (easy, medium, hard, ...)
  --runs <n>                runs per case (default 1)
  --model <model>           lead model (default: the prompt's model, else opus)
  --baseline <model>        MODEL_ESCALATOR_BASELINE for the run
  --judge-model <model>     model of the llm graders (default haiku)
  --max-cost-usd <x>        stop starting runs once agent + judge cost reaches x; marks the file partial
  --permission-mode <mode>  optional claude --permission-mode (default: none, tools are granted explicitly)
  --json <file>             where to write the result (default: <results folder>/<arm>.json)
  --keep-temp               keep the temporary workspaces and plugin copies
  --dry-run                 scaffold one case, print the command and environment, grade the untouched
                            workspace and exit without calling claude
  --help                    this text

WARNING: the agents' shell is not confined (unconfined). The runs behave like a normal Claude Code
session started in a fresh temp folder: they can read and write anywhere your user can.
Runs cost real money; use --max-cost-usd.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { runs: 1, judgeModel: 'haiku', keepTemp: false, dryRun: false, help: false };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--arm': o.arm = need(i, a); i++; break;
      case '--case': o.caseGlob = need(i, a); i++; break;
      case '--tag': o.tag = need(i, a); i++; break;
      case '--runs': o.runs = Number(need(i, a)); i++; break;
      case '--model': o.model = need(i, a); i++; break;
      case '--baseline': o.baseline = need(i, a); i++; break;
      case '--judge-model': o.judgeModel = need(i, a); i++; break;
      case '--max-cost-usd': o.maxCostUsd = Number(need(i, a)); i++; break;
      case '--permission-mode': o.permissionMode = need(i, a); i++; break;
      case '--json': o.json = need(i, a); i++; break;
      case '--keep-temp': o.keepTemp = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new UsageError(`unknown option ${a}`);
    }
  }
  if (o.help) return o;
  if (o.arm !== 'baseline' && o.arm !== 'active') throw new UsageError('--arm must be baseline or active');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new UsageError('--runs must be a positive integer');
  if (o.maxCostUsd !== undefined && !(o.maxCostUsd > 0)) throw new UsageError('--max-cost-usd must be a positive number');
  return o;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const pluginDir = join(repoRoot, 'plugin');
const evalsDir = join(pluginDir, 'evals');

function loadCases() {
  const out = [];
  for (const entry of readdirSync(evalsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'results') continue;
    const dir = join(evalsDir, entry.name);
    if (!existsSync(join(dir, 'case.yaml')) || !existsSync(join(dir, 'prompt.md'))) continue;
    const yaml = parseYaml(readFileSync(join(dir, 'case.yaml'), 'utf8'));
    const prompt = parseFrontmatter(readFileSync(join(dir, 'prompt.md'), 'utf8'));
    const gdir = join(dir, 'graders');
    const graders = existsSync(gdir)
      ? readdirSync(gdir).filter((f) => f.endsWith('.md')).sort().map((f) => parseGraderFile(f, readFileSync(join(gdir, f), 'utf8')))
      : [];
    out.push({
      name: yaml.name ?? entry.name,
      tags: Array.isArray(yaml.tags) ? yaml.tags : [],
      dir,
      relDir: `evals/${entry.name}`,
      scaffold: join(dir, yaml.context?.scaffold_script ?? 'scaffold.sh'),
      prompt: prompt.body,
      promptModel: typeof prompt.data.model === 'string' ? prompt.data.model : null,
      maxTurns: Number(prompt.data.max_turns) || 30,
      timeoutSeconds: Number(prompt.data.timeout_seconds) || 900,
      allowedTools: Array.isArray(prompt.data.allowed_tools) ? prompt.data.allowed_tools : [],
      graders,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Relative paths (forward slashes) of every file below `root`. */
function listFiles(root, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push(...listFiles(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function safeReader(root) {
  return (rel) => {
    const abs = resolve(root, rel);
    if (relative(root, abs).startsWith('..')) throw new Error(`path outside the workspace: ${rel}`);
    return readFileSync(abs, 'utf8');
  };
}

function findOnPath(names, env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  for (const dir of (key ? env[key] : '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** How to start claude: a real executable, or through the shell for a .cmd shim on Windows. */
function resolveClaude(env) {
  if (process.platform !== 'win32') return { cmd: 'claude', shell: false };
  const exe = findOnPath(['claude.exe'], env);
  if (exe) return { cmd: exe, shell: false };
  return { cmd: 'claude', shell: true };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Run claude with the prompt on stdin. Calls onLine for each stdout line; kills on timeout or if onLine returns 'kill'. */
function runClaude({ claude, args, cwd, env, input, timeoutMs, onLine, traceFile }) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(claude.cmd, args, {
        cwd, env, shell: claude.shell, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolveRun({ spawnError: String(e?.message ?? e), stdout: '', stderr: '', code: null, timedOut: false, killedBy: null });
      return;
    }
    const trace = traceFile ? createWriteStream(traceFile) : null;
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let killedBy = null;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      stdout += s;
      trace?.write(s);
      if (!onLine) return;
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!killedBy && onLine(line) === 'kill') {
          killedBy = 'max_turns';
          killTree(child);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => { spawnError = String(e?.message ?? e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      trace?.end();
      resolveRun({ stdout, stderr, code, timedOut, killedBy, spawnError });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function quoteForDisplay(a) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a);
}

function scaffoldWorkspace(c, ws, env, bashPath) {
  const script = c.scaffold.replace(/\\/g, '/');
  return spawnSync(bashPath, [script], { cwd: ws, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
}

function removeDir(p) {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* best effort */ }
}

function copyPlugin(dest) {
  // evals/ stays out of the copy: the agents must not find the hidden acceptance tests there.
  const skip = [join(pluginDir, '.claude-plugin', 'types'), join(pluginDir, 'evals'), join(pluginDir, '.git')];
  cpSync(pluginDir, dest, {
    recursive: true,
    filter: (src) => {
      if (src.split(sep).includes('node_modules')) return false;
      return !skip.some((s) => src === s || src.startsWith(s + sep));
    },
  });
}

async function runJudge(prompt, { claude, env, judgeModel }) {
  const jdir = mkdtempSync(join(tmpdir(), 'ab-run-judge-'));
  try {
    const args = ['-p', '--model', judgeModel, '--output-format', 'json', '--no-session-persistence', '--tools', ''];
    const r = await runClaude({ claude, args, cwd: jdir, env, input: prompt, timeoutMs: 180000 });
    if (r.spawnError) throw new Error(`judge did not start: ${r.spawnError}`);
    if (r.timedOut) throw new Error('judge timed out');
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error(`judge output is not JSON (exit ${r.code}): ${r.stderr.slice(-200)}`); }
    if (out.is_error) throw new Error(`judge error: ${String(out.result ?? '').slice(0, 200)}`);
    return { text: String(out.result ?? ''), costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0 };
  } finally {
    removeDir(jdir);
  }
}

function claudeVersion(claude, env) {
  const r = spawnSync(claude.cmd, ['--version'], { env, encoding: 'utf8', shell: claude.shell, windowsHide: true });
  return (r.stdout ?? '').trim().split(/\s+/)[0] || 'unknown';
}

/**
 * Stream line handler: counts distinct main-loop message ids over the whole stream, across
 * every lead turn (a resumed run emits one `result` per turn), and returns 'kill' past maxTurns.
 */
export function turnCounter(maxTurns) {
  const ids = new Set();
  return (line) => {
    if (!line.startsWith('{') || !line.includes('"assistant"')) return null;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'assistant' && (ev.parent_tool_use_id ?? null) === null && ev.message?.id) {
        ids.add(ev.message.id);
        if (ids.size > maxTurns) return 'kill';
      }
    } catch { /* partial or foreign line */ }
    return null;
  };
}

async function runOnce({ c, n, opts, model, bashPath, claude, resultsDir, judgeEnv }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ws = mkdtempSync(join(tmpdir(), 'ab-run-ws-'));
  const copy = mkdtempSync(join(tmpdir(), 'ab-run-plugin-'));
  const tracePath = join(resultsDir, `${c.name}-${opts.arm}-${n}.jsonl`);
  const { env } = buildEnv({ base: process.env, arm: opts.arm, baseline: opts.baseline, platform: process.platform, bashPath });
  const base = {
    startedAt, tracePath, turns: 0, judgeCostUsd: 0,
  };
  try {
    const sc = scaffoldWorkspace(c, ws, env, bashPath);
    if (sc.status !== 0) {
      const why = `scaffold failed (exit ${sc.status}): ${(sc.stderr || sc.error?.message || '').trim().slice(0, 300)}`;
      return { ...base, score: 0, passed: false, durationSeconds: (Date.now() - t0) / 1000, graders: [], error: why };
    }
    const initialFiles = new Set(listFiles(ws));
    copyPlugin(copy);
    const tools = [...new Set([...c.allowedTools, ...DEFAULT_TOOLS])];
    const args = buildClaudeArgs({ pluginDir: copy, model, allowedTools: tools, permissionMode: opts.permissionMode });
    const r = await runClaude({
      claude, args, cwd: ws, env, input: c.prompt, timeoutMs: c.timeoutSeconds * 1000,
      onLine: turnCounter(c.maxTurns), traceFile: tracePath,
    });
    const trace = parseTrace(r.stdout);
    let error;
    if (r.spawnError) error = `spawn: ${r.spawnError}`;
    else if (r.timedOut) error = 'timeout';
    else if (r.killedBy) error = r.killedBy;
    else if (trace.isError) error = String(trace.result?.subtype ?? 'error');
    else if (!trace.result && r.code !== 0) error = `exit ${r.code}: ${r.stderr.trim().slice(-200)}`;
    const ctx = {
      lastMessage: trace.lastMessage,
      toolUses: trace.toolUses,
      readFile: safeReader(ws),
      listFiles: () => listFiles(ws),
      initialFiles,
    };
    const judge = (prompt) => runJudge(prompt, { claude, env: judgeEnv, judgeModel: opts.judgeModel });
    const graded = await gradeAll(c.graders, ctx, judge);
    const score = scoreOf(graded.graders);
    const run = {
      ...base,
      score,
      passed: !error && graded.graders.every((g) => g.passed),
      turns: trace.turns,
      judgeCostUsd: graded.judgeCostUsd,
      durationSeconds: (Date.now() - t0) / 1000,
      skippedPaidGraders: false,
      graders: graded.graders,
    };
    if (trace.costUsd !== null) run.costUsd = trace.costUsd;
    if (error) run.error = error;
    return run;
  } finally {
    if (!opts.keepTemp) {
      removeDir(ws);
      removeDir(copy);
    }
  }
}

const fmtCost = (x) => (typeof x === 'number' ? `$${x.toFixed(4)}` : 'cost n/a');

function warn() {
  process.stderr.write(
    'WARNING: ab-run starts real Claude Code sessions whose shell is NOT confined (no sandbox).\n' +
      '         The agents run with your user rights; only their working folder is a fresh temp folder.\n' +
      '         Runs cost real money; use --max-cost-usd.\n',
  );
}

function prepare(opts) {
  const bashPath = resolveBash({ platform: process.platform, env: process.env, exists: existsSync });
  if (!bashPath) throw new UsageError('Git Bash not found: set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe (the WSL launcher in System32 cannot be used)');
  const { env: probeEnv } = buildEnv({ base: process.env, arm: opts.arm, baseline: opts.baseline, platform: process.platform, bashPath });
  const claude = resolveClaude(probeEnv);
  const all = loadCases();
  const cases = selectCases(all, opts);
  if (!cases.length) throw new UsageError('no case matches the filters');
  return { bashPath, claude, cases };
}

async function dryRun(opts) {
  const { bashPath, claude, cases } = prepare(opts);
  const c = cases[0];
  const model = opts.model ?? c.promptModel ?? 'opus';
  const { env, diff } = buildEnv({ base: process.env, arm: opts.arm, baseline: opts.baseline, platform: process.platform, bashPath });
  const ws = mkdtempSync(join(tmpdir(), 'ab-run-ws-'));
  try {
    const sc = scaffoldWorkspace(c, ws, env, bashPath);
    if (sc.status !== 0) throw new Error(`scaffold failed (exit ${sc.status}): ${(sc.stderr || sc.error?.message || '').trim()}`);
    const tools = [...new Set([...c.allowedTools, ...DEFAULT_TOOLS])];
    const args = buildClaudeArgs({ pluginDir: '<temp copy of plugin/>', model, allowedTools: tools, permissionMode: opts.permissionMode });
    console.log(`case:      ${c.name} (arm ${opts.arm}, model ${model})`);
    console.log(`bash:      ${bashPath}`);
    console.log(`workspace: ${ws} (scaffolded; this is also the agent's cwd)`);
    console.log(`command:   ${[claude.cmd, ...args].map(quoteForDisplay).join(' ')}`);
    console.log(`stdin:     the prompt body of prompt.md (${c.prompt.length} characters)`);
    console.log(`limits:    timeout ${c.timeoutSeconds} s (process tree killed), max ${c.maxTurns} main-loop turns (counted on the stream, then killed)`);
    console.log('env set:  ', JSON.stringify(diff.set));
    console.log('env unset:', diff.removed.length ? diff.removed.join(', ') : '(none present)');
    if (diff.pathPrefix) console.log(`PATH:      ${diff.pathPrefix} prepended`);
    const ctx = {
      lastMessage: '',
      toolUses: [],
      readFile: safeReader(ws),
      listFiles: () => listFiles(ws),
      initialFiles: new Set(listFiles(ws)),
    };
    const graded = await gradeAll(c.graders, ctx, null);
    console.log('graders on the untouched workspace:');
    for (const g of graded.graders) console.log(`  ${g.passed ? 'pass' : 'FAIL'}  ${g.name} (${g.type}, weight ${g.weight}): ${g.explanation}`);
    console.log(`score: ${scoreOf(graded.graders).toFixed(3)} (expected: tests-pass fails before any fix)`);
    console.log('dry run: claude was not called.');
  } finally {
    if (!opts.keepTemp) removeDir(ws);
    else console.log(`kept: ${ws}`);
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`ab-run: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    warn();
    if (opts.dryRun) {
      await dryRun(opts);
      return 0;
    }
    const { bashPath, claude, cases } = prepare(opts);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsDir = join(evalsDir, 'results', `${stamp}-ab-run`);
    mkdirSync(resultsDir, { recursive: true });
    const outFile = opts.json ? resolve(opts.json) : join(resultsDir, `${opts.arm}.json`);
    mkdirSync(dirname(outFile), { recursive: true });
    const { env: judgeEnv } = buildEnv({ base: process.env, arm: 'off', platform: process.platform, bashPath });
    const version = claudeVersion(claude, judgeEnv);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const entries = [];
    let spent = 0;
    let partial = false;
    const write = () => {
      const json = buildResultJson({
        claudeVersion: version, startedAt, durationSeconds: Math.round((Date.now() - t0) / 1000), partial,
        modelOverride: opts.model, caseFilter: opts.caseGlob ?? opts.tag, arm: opts.arm, cases: entries,
      });
      writeFileSync(outFile, JSON.stringify(json, null, 2) + '\n');
    };
    outer: for (const c of cases) {
      const runs = [];
      const entry = buildCaseEntry({
        name: c.name, dir: c.relDir, promptMarkdown: c.prompt, timeoutSeconds: c.timeoutSeconds, maxTurns: c.maxTurns,
        graders: c.graders.map((g) => ({ name: g.name, type: g.type, weight: g.weight })), runs, runsPerCase: opts.runs,
      });
      entries.push(entry);
      for (let n = 1; n <= opts.runs; n++) {
        if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) {
          partial = true;
          break outer;
        }
        const model = opts.model ?? c.promptModel ?? 'opus';
        const run = await runOnce({ c, n, opts, model, bashPath, claude, resultsDir, judgeEnv });
        runs.push(run);
        spent += (run.costUsd ?? 0) + (run.judgeCostUsd ?? 0);
        entry.aggregates.score = mean(runs.map((r) => r.score));
        entry.aggregates.passRate = runs.filter((r) => r.passed).length / runs.length;
        console.log(
          `${c.name} ${opts.arm} #${n}: score ${run.score.toFixed(2)}, ${fmtCost(run.costUsd)}, ${run.durationSeconds.toFixed(0)} s` +
            (run.error ? `, error: ${run.error}` : ''),
        );
        write();
      }
    }
    if (entries.length && !entries[entries.length - 1].arms.with.length) entries.pop();
    write();
    console.log(`result: ${outFile}${partial ? ' (partial: cost ceiling reached)' : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`ab-run: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ab-run: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
