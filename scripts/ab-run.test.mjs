import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  parseYaml,
  parseGraderFile,
  resolveBash,
  parseTrace,
  globToRegExp,
  gradeRegex,
  gradeToolUsed,
  gradeFileExists,
  parseJudgeReply,
  buildJudgePrompt,
  gradeAll,
  scoreOf,
  buildEnv,
  buildClaudeArgs,
  selectCases,
  buildCaseEntry,
  buildResultJson,
  isBlockedBash,
  turnCounter,
  defaultConfigDir,
  chooseIsolation,
  storeFileNames,
  moveStoreAside,
  restoreStore,
  clearStore,
  DISABLE_INSTALLED_SETTINGS,
} from './ab-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'ab-run.mjs');
const fixture = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');

// --- parsing -----------------------------------------------------------------

test('parseFrontmatter reads scalars, flow lists and flow maps', () => {
  const text = [
    '---',
    'max_turns: 25',
    'timeout_seconds: 600',
    'allowed_tools: [Read, Bash, mcp__model-escalator__ask_for_help]',
    'target: { source: file, path: .eval/result.txt }',
    'path: "test/*.test.mjs"',
    'weight: 0.5',
    '---',
    '',
    'Body line 1',
    'Body line 2',
    '',
  ].join('\n');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.max_turns, 25);
  assert.equal(data.weight, 0.5);
  assert.deepEqual(data.allowed_tools, ['Read', 'Bash', 'mcp__model-escalator__ask_for_help']);
  assert.deepEqual(data.target, { source: 'file', path: '.eval/result.txt' });
  assert.equal(data.path, 'test/*.test.mjs');
  assert.equal(body, 'Body line 1\nBody line 2');
});

test('parseFrontmatter without a header returns the whole text as body', () => {
  const { data, body } = parseFrontmatter('just text\n');
  assert.deepEqual(data, {});
  assert.equal(body, 'just text');
});

test('parseFrontmatter tolerates CRLF line endings', () => {
  const { data, body } = parseFrontmatter('---\r\nweight: 3\r\n---\r\n^PASS\r\n');
  assert.equal(data.weight, 3);
  assert.equal(body, '^PASS');
});

test('parseYaml reads case.yaml with a nested block', () => {
  const y = parseYaml(
    'schema_version: "1.1"\nname: paginate-off-by-one\ndescription: Easy. Two bugs: one here.\ntags: [easy, bugfix]\ncontext:\n  scaffold_script: scaffold.sh\n',
  );
  assert.equal(y.schema_version, '1.1');
  assert.equal(y.name, 'paginate-off-by-one');
  assert.equal(y.description, 'Easy. Two bugs: one here.');
  assert.deepEqual(y.tags, ['easy', 'bugfix']);
  assert.deepEqual(y.context, { scaffold_script: 'scaffold.sh' });
});

test('parseGraderFile keeps the body as the grader text', () => {
  const g = parseGraderFile(
    'tests-pass.md',
    '---\ntype: regex\ntarget: { source: file, path: .eval/result.txt }\nweight: 3\n---\n^PASS\n',
  );
  assert.equal(g.name, 'tests-pass');
  assert.equal(g.type, 'regex');
  assert.equal(g.weight, 3);
  assert.equal(g.body, '^PASS');
});

test('parseGraderFile defaults the weight to 1', () => {
  assert.equal(parseGraderFile('x.md', '---\ntype: llm\n---\ncheck it\n').weight, 1);
});

// --- bash resolution ------------------------------------------------------------

test('resolveBash: CLAUDE_CODE_GIT_BASH_PATH wins on Windows', () => {
  const r = resolveBash({
    platform: 'win32',
    env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe' },
    exists: (p) => p === 'D:\\git\\bash.exe',
  });
  assert.equal(r, 'D:\\git\\bash.exe');
});

test('resolveBash: falls back to Program Files and never to System32', () => {
  const seen = [];
  const r = resolveBash({
    platform: 'win32',
    env: {},
    exists: (p) => {
      seen.push(p);
      return p.endsWith('Git\\bin\\bash.exe') || p.includes('System32');
    },
  });
  assert.equal(r, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.ok(!r.includes('System32'));
});

test('resolveBash: ignores an env path that does not exist', () => {
  const r = resolveBash({
    platform: 'win32',
    env: { CLAUDE_CODE_GIT_BASH_PATH: 'Z:\\nope\\bash.exe' },
    exists: (p) => p === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  });
  assert.equal(r, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
});

test('resolveBash: null on Windows when no Git Bash is found, plain bash elsewhere', () => {
  assert.equal(resolveBash({ platform: 'win32', env: {}, exists: () => false }), null);
  assert.equal(resolveBash({ platform: 'linux', env: {}, exists: () => false }), 'bash');
});

test('isBlockedBash flags the WSL launcher', () => {
  assert.equal(isBlockedBash('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isBlockedBash('C:\\Program Files\\Git\\bin\\bash.exe'), false);
});

// --- stream-json trace --------------------------------------------------------------

test('parseTrace extracts the result, tool uses and last message', () => {
  const t = parseTrace(fixture('ab-run-trace.jsonl'));
  assert.equal(t.result.total_cost_usd, 0.4321);
  assert.equal(t.costUsd, 0.4321);
  assert.equal(t.turns, 3);
  assert.equal(t.durationMs, 123456);
  assert.equal(t.isError, false);
  assert.equal(t.lastMessage, 'PASS');
  assert.deepEqual(
    t.toolUses.map((u) => u.name),
    ['Agent', 'Edit', 'Bash'],
  );
  assert.equal(t.toolUses[1].parent, 't1');
  assert.equal(t.toolUses[0].parent, null);
});

test('parseTrace counts main-loop turns by distinct message id', () => {
  const t = parseTrace(fixture('ab-run-trace.jsonl'));
  assert.equal(t.mainTurns, 3); // m1 (two blocks), m2, m3; subagent message not counted
});

test('parseTrace without a result event leaves cost unknown', () => {
  const lines = fixture('ab-run-trace.jsonl').split('\n').filter((l) => !l.includes('"type":"result"'));
  const t = parseTrace(lines.join('\n'));
  assert.equal(t.result, null);
  assert.equal(t.costUsd, null);
  assert.equal(t.turns, 3);
  assert.equal(t.lastMessage, 'PASS');
});

test('parseTrace sums num_turns over every result of a resumed run', () => {
  // The lead resumes when a background agent notifies: one result event per lead turn.
  const t = parseTrace(fixture('ab-run-trace-resumed.jsonl'));
  assert.equal(t.turns, 8); // 4 + 1 + 3
  assert.equal(t.costUsd, 0.6258); // cumulative: taken once, not summed
  assert.equal(t.isError, false);
  assert.equal(t.result.num_turns, 3); // the last result still names the final turn
});

test('parseTrace takes the largest cumulative cost, not the last one', () => {
  const lines = [
    { type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.5, result: 'a' },
    { type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.7, result: 'b' },
    { type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.6, result: 'c' },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.equal(parseTrace(lines).costUsd, 0.7);
});

test('parseTrace: an error on the last result makes the run an error', () => {
  const t = parseTrace(fixture('ab-run-trace-resumed-error.jsonl'));
  assert.equal(t.isError, true);
  assert.equal(t.result.subtype, 'error_max_turns');
  assert.equal(t.turns, 8);
});

test('parseTrace: an error on an earlier result alone does not make the run an error', () => {
  const lines = [
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, total_cost_usd: 0.1, result: '' },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, result: 'PASS' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const t = parseTrace(lines);
  assert.equal(t.isError, false);
  assert.equal(t.turns, 3);
});

test('turnCounter counts main-loop turns across resumed results and kills past the limit', () => {
  const main = (id) => JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [] } });
  const result = JSON.stringify({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0, result: '' });
  const onLine = turnCounter(2);
  assert.equal(onLine(main('a1')), null);
  assert.equal(onLine(result), null);
  assert.equal(onLine(main('a2')), null); // second lead turn, after a result: still counted
  assert.equal(onLine(main('a2')), null); // same message id: not a new turn
  assert.equal(onLine(main('a3')), 'kill');
});

// --- graders ----------------------------------------------------------------------------

const ctx = (over = {}) => ({
  lastMessage: 'All done. PASS',
  toolUses: [
    { name: 'Agent', input: { model: 'haiku', prompt: 'x' }, parent: null },
    { name: 'Agent', input: { model: 'opus', prompt: 'y' }, parent: null },
    { name: 'Bash', input: { command: 'ls' }, parent: null },
  ],
  readFile: (rel) => {
    if (rel === '.eval/result.txt') return 'PASS\n3 tests';
    throw new Error(`ENOENT: ${rel}`);
  },
  listFiles: () => ['src/a.mjs', 'test/a.test.mjs', 'test/new.test.mjs'],
  initialFiles: new Set(['src/a.mjs', 'test/a.test.mjs']),
  ...over,
});

const regexGrader = (over) => ({ name: 'r', type: 'regex', weight: 1, body: '^PASS', ...over });

test('regex on a file: pass and fail', async () => {
  const g = regexGrader({ target: { source: 'file', path: '.eval/result.txt' } });
  assert.equal(gradeRegex(g, ctx()).passed, true);
  assert.equal(gradeRegex({ ...g, body: '^FAIL' }, ctx()).passed, false);
});

test('regex on a missing file fails with the reason', () => {
  const r = gradeRegex(regexGrader({ target: { source: 'file', path: 'nope.txt' } }), ctx());
  assert.equal(r.passed, false);
  assert.match(r.explanation, /ENOENT/);
});

test('regex defaults to the last message; match modes and flags', () => {
  assert.equal(gradeRegex(regexGrader({ body: 'done' }), ctx()).passed, true);
  assert.equal(gradeRegex(regexGrader({ body: 'DONE', flags: 'i' }), ctx()).passed, true);
  assert.equal(gradeRegex(regexGrader({ body: 'DONE' }), ctx()).passed, false);
  assert.equal(gradeRegex(regexGrader({ body: 'FAIL', match: 'not_contains' }), ctx()).passed, true);
  assert.equal(gradeRegex(regexGrader({ body: 'PASS', match: 'not_contains' }), ctx()).passed, false);
  assert.equal(gradeRegex(regexGrader({ body: 'l', match: 'count:2' }), ctx()).passed, true);
  assert.equal(gradeRegex(regexGrader({ body: 'l', match: 'count:3' }), ctx()).passed, false);
});

test('regex with an invalid pattern fails instead of throwing', () => {
  const r = gradeRegex(regexGrader({ body: '(' }), ctx());
  assert.equal(r.passed, false);
  assert.ok(r.explanation.length > 0);
});

const toolGrader = (over) => ({ name: 't', type: 'tool_used', weight: 0.5, tool: 'Agent', ...over });

test('tool_used: tool, input_match, min and max', () => {
  assert.equal(gradeToolUsed(toolGrader({ input_match: 'haiku', min: 1 }), ctx()).passed, true);
  assert.equal(gradeToolUsed(toolGrader({ input_match: 'sonnet', min: 1 }), ctx()).passed, false);
  assert.equal(gradeToolUsed(toolGrader({ min: 3 }), ctx()).passed, false);
  assert.equal(gradeToolUsed(toolGrader({ min: 0, max: 1 }), ctx()).passed, false);
  assert.equal(gradeToolUsed(toolGrader({ tool: 'Write', min: 0, max: 0 }), ctx()).passed, true);
  assert.equal(gradeToolUsed(toolGrader({ tool: 'Write' }), ctx()).passed, false); // min defaults to 1
});

test('globToRegExp handles *, ** and ?', () => {
  assert.ok(globToRegExp('test/*.test.mjs').test('test/a.test.mjs'));
  assert.ok(!globToRegExp('test/*.test.mjs').test('test/sub/a.test.mjs'));
  assert.ok(globToRegExp('**/*.mjs').test('a/b/c.mjs'));
  assert.ok(globToRegExp('src/?.mjs').test('src/a.mjs'));
});

test('file_exists only counts files created after the scaffold', () => {
  const g = { name: 'f', type: 'file_exists', weight: 0.5, path: 'test/*.test.mjs' };
  assert.equal(gradeFileExists(g, ctx()).passed, true);
  assert.equal(gradeFileExists(g, ctx({ listFiles: () => ['test/a.test.mjs'] })).passed, false);
  assert.equal(gradeFileExists({ ...g, path: 'docs/*.md' }, ctx()).passed, false);
});

test('parseJudgeReply reads PASS or FAIL on the first line', () => {
  assert.deepEqual(parseJudgeReply('PASS\nlooks right'), { passed: true, explanation: 'looks right' });
  assert.equal(parseJudgeReply('**FAIL**: too broad').passed, false);
  assert.equal(parseJudgeReply('fail\nreason').passed, false);
  assert.equal(parseJudgeReply('maybe').passed, false);
  assert.match(parseJudgeReply('maybe').explanation, /maybe/);
});

test('buildJudgePrompt carries the criteria and the focus content', () => {
  const p = buildJudgePrompt({ body: 'PASS only if minimal.' }, 'diff --git a b');
  assert.match(p, /PASS only if minimal\./);
  assert.match(p, /diff --git a b/);
  assert.match(p, /first line/i);
});

test('gradeAll runs every grader, routes the judge and sums its cost', async () => {
  const graders = [
    regexGrader({ name: 'tests-pass', weight: 3, target: { source: 'file', path: '.eval/result.txt' } }),
    { name: 'quality', type: 'llm', weight: 1, focus: { source: 'file', path: '.eval/diff.txt' }, body: 'criteria' },
    toolGrader({ name: 'delegated', input_match: 'haiku' }),
    { name: 'weird', type: 'nonsense', weight: 1 },
  ];
  const prompts = [];
  const judge = async (prompt) => {
    prompts.push(prompt);
    return { text: 'PASS\nfine', costUsd: 0.002 };
  };
  const c = ctx({
    readFile: (rel) => {
      if (rel === '.eval/result.txt') return 'PASS';
      if (rel === '.eval/diff.txt') return 'the diff';
      throw new Error('ENOENT');
    },
  });
  const out = await gradeAll(graders, c, judge);
  assert.deepEqual(out.graders.map((g) => [g.name, g.passed]), [
    ['tests-pass', true],
    ['quality', true],
    ['delegated', true],
    ['weird', false],
  ]);
  assert.equal(out.judgeCostUsd, 0.002);
  assert.match(prompts[0], /the diff/);
  assert.match(out.graders[3].explanation, /unknown/i);
  assert.equal(out.graders[0].weight, 3);
  assert.equal(out.graders[0].type, 'regex');
});

test('gradeAll: a throwing judge or a missing focus file fails that grader only', async () => {
  const llm = { name: 'q', type: 'llm', weight: 1, focus: { source: 'file', path: 'x' }, body: 'c' };
  const bad = await gradeAll([llm], ctx(), async () => {
    throw new Error('boom');
  });
  assert.equal(bad.graders[0].passed, false);
  assert.match(bad.graders[0].explanation, /ENOENT/);
  const noFocus = { ...llm, focus: undefined };
  const bad2 = await gradeAll([noFocus], ctx(), async () => {
    throw new Error('boom');
  });
  assert.match(bad2.graders[0].explanation, /boom/);
});

test('gradeAll without a judge (dry run) skips llm graders as failed', async () => {
  const out = await gradeAll([{ name: 'q', type: 'llm', weight: 1, body: 'c' }], ctx(), null);
  assert.equal(out.graders[0].passed, false);
  assert.match(out.graders[0].explanation, /skipped/i);
});

test('scoreOf is the weighted share of passed graders', () => {
  assert.equal(scoreOf([]), 0);
  assert.equal(scoreOf([{ passed: true, weight: 3 }, { passed: false, weight: 1 }, { passed: true, weight: 0.5 }]), 3.5 / 4.5);
  assert.equal(scoreOf([{ passed: false, weight: 3 }, { passed: true, weight: 1 }]), 0.25);
});

// --- command and environment -----------------------------------------------------------------

test('buildEnv sets the arm, removes plugin dirs and puts Git Bash first on Windows', () => {
  const base = { Path: 'C:\\Windows\\System32;C:\\x', CLAUDE_CODE_PLUGIN_DIRS: 'C:\\other', FOO: '1' };
  const { env, diff } = buildEnv({
    base,
    arm: 'active',
    baseline: 'opus',
    platform: 'win32',
    bashPath: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  });
  assert.equal(env.MODEL_ESCALATOR_MODE, 'active');
  assert.equal(env.MODEL_ESCALATOR_BASELINE, 'opus');
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
  assert.equal(env.FOO, '1');
  assert.ok(env.Path.startsWith('C:\\Program Files\\Git\\usr\\bin;'));
  assert.equal(env.PATH, undefined); // the existing key spelling is kept
  assert.ok(diff.removed.includes('CLAUDE_CODE_PLUGIN_DIRS'));
  assert.equal(diff.set.MODEL_ESCALATOR_MODE, 'active');
  assert.equal(base.CLAUDE_CODE_PLUGIN_DIRS, 'C:\\other'); // input untouched
});

test('buildEnv does not touch the config dir or set a baseline by default', () => {
  const { env } = buildEnv({ base: { PATH: '/usr/bin' }, arm: 'baseline', platform: 'linux', bashPath: 'bash' });
  assert.equal(env.MODEL_ESCALATOR_MODE, 'baseline');
  assert.equal('MODEL_ESCALATOR_BASELINE' in env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('buildEnv clears an inherited baseline when none is requested', () => {
  const { env } = buildEnv({
    base: { PATH: '/usr/bin', MODEL_ESCALATOR_BASELINE: 'haiku', EVAL_MODEL_ESCALATOR_MODE: 'off' },
    arm: 'active',
    platform: 'linux',
    bashPath: 'bash',
  });
  assert.equal('MODEL_ESCALATOR_BASELINE' in env, false);
  assert.equal('EVAL_MODEL_ESCALATOR_MODE' in env, false);
});

test('buildClaudeArgs: explicit grant, no bypass, prompt not in argv', () => {
  const args = buildClaudeArgs({
    pluginDir: '/tmp/p',
    model: 'opus',
    allowedTools: ['Read', 'Bash'],
  });
  assert.deepEqual(args.slice(0, 1), ['-p']);
  assert.ok(args.includes('--plugin-dir') && args[args.indexOf('--plugin-dir') + 1] === '/tmp/p');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--no-session-persistence'));
  const i = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(i + 1, i + 3), ['Read', 'Bash']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.join(' ').includes('bypassPermissions'));
  assert.ok(!args.includes('--permission-mode'));
});

test('buildClaudeArgs: optional permission mode', () => {
  const args = buildClaudeArgs({ pluginDir: 'p', model: 'm', allowedTools: ['Read'], permissionMode: 'acceptEdits' });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

// --- selection and result assembly ----------------------------------------------------------

const cases = [
  { name: 'paginate-off-by-one', tags: ['easy', 'bugfix'] },
  { name: 'csv-delimiter-option', tags: ['easy'] },
  { name: 'config-parser-edges', tags: ['hard'] },
];

test('selectCases by glob and tag', () => {
  assert.equal(selectCases(cases, {}).length, 3);
  assert.deepEqual(selectCases(cases, { caseGlob: 'c*' }).map((c) => c.name), ['csv-delimiter-option', 'config-parser-edges']);
  assert.deepEqual(selectCases(cases, { tag: 'hard' }).map((c) => c.name), ['config-parser-edges']);
  assert.deepEqual(selectCases(cases, { caseGlob: 'paginate-off-by-one', tag: 'easy' }).map((c) => c.name), ['paginate-off-by-one']);
  assert.deepEqual(selectCases(cases, { caseGlob: 'nope' }), []);
});

const run = (score, cost, error) => ({
  score,
  passed: score === 1 && !error,
  turns: 5,
  costUsd: cost,
  judgeCostUsd: 0.01,
  durationSeconds: 30,
  startedAt: '2026-10-12T10:00:00.000Z',
  tracePath: 'x.jsonl',
  graders: [],
  ...(error ? { error } : {}),
});

test('buildCaseEntry aggregates score and pass rate', () => {
  const entry = buildCaseEntry({
    name: 'alpha',
    dir: 'evals/alpha',
    promptMarkdown: 'p',
    timeoutSeconds: 600,
    maxTurns: 25,
    graders: [{ name: 'g', type: 'regex', weight: 1 }],
    runs: [run(1, 0.4), run(0.5, 0.4)],
    runsPerCase: 2,
  });
  assert.equal(entry.runsPerCase, 2);
  assert.equal(entry.arms.with.length, 2);
  assert.equal(entry.aggregates.score, 0.75);
  assert.equal(entry.aggregates.passRate, 0.5);
  assert.equal(entry.maxTurns, 25);
});

test('buildResultJson has the official top-level shape and ab-compare can read it', () => {
  const entry = buildCaseEntry({
    name: 'alpha',
    dir: 'evals/alpha',
    promptMarkdown: 'p',
    timeoutSeconds: 600,
    maxTurns: 25,
    graders: [],
    runs: [run(1, 0.4)],
    runsPerCase: 1,
  });
  const j = buildResultJson({
    claudeVersion: '2.1.295',
    startedAt: '2026-10-12T10:00:00.000Z',
    durationSeconds: 42,
    partial: true,
    modelOverride: 'opus',
    caseFilter: 'alpha',
    cases: [entry],
  });
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.claudeVersion, '2.1.295');
  assert.equal(j.partial, true);
  assert.equal(j.suite.ablation, 'none');
  assert.equal(j.suite.runner, 'ab-run');
  assert.equal(j.suite.modelOverride, 'opus');
  assert.equal(j.costUsd, 0.41); // agent + judge
  assert.equal(j.aggregates.casesTotal, 1);
  assert.equal(j.aggregates.casesPassed, 1);
  assert.equal(j.aggregates.overallScore, 1);
  assert.equal(j.aggregates.overallPassRate, 1);
});

test('cost total skips runs with unknown cost', () => {
  const r = run(0, undefined, 'timeout');
  delete r.costUsd;
  const entry = buildCaseEntry({
    name: 'a', dir: 'd', promptMarkdown: '', timeoutSeconds: 1, maxTurns: 1, graders: [], runs: [r], runsPerCase: 1,
  });
  const j = buildResultJson({
    claudeVersion: 'v', startedAt: 's', durationSeconds: 1, partial: false, cases: [entry],
  });
  assert.equal(j.costUsd, 0.01);
});

// --- command line ------------------------------------------------------------------------------

test('--help prints the usage and exits 0', () => {
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--arm/);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /not confined|unconfined/i);
});

test('missing or invalid --arm exits 2', () => {
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--arm', 'bogus'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--arm', 'active', '--runs', '0'], { encoding: 'utf8' }).status, 2);
});

test('the real case files parse', () => {
  const evals = join(here, '..', 'plugin', 'evals');
  const prompt = parseFrontmatter(readFileSync(join(evals, 'paginate-off-by-one', 'prompt.md'), 'utf8'));
  assert.equal(prompt.data.max_turns, 25);
  assert.equal(prompt.data.timeout_seconds, 600);
  assert.ok(prompt.data.allowed_tools.includes('Agent'));
  assert.ok(existsSync(join(evals, 'paginate-off-by-one', 'scaffold.sh')));
});

test('ab-compare reads a file written in the runner shape', () => {
  const entry = buildCaseEntry({
    name: 'alpha', dir: 'evals/alpha', promptMarkdown: 'p', timeoutSeconds: 1, maxTurns: 1, graders: [],
    runs: [run(1, 0.4), run(1, 0.5)], runsPerCase: 2,
  });
  const j = buildResultJson({ claudeVersion: 'v', startedAt: 's', durationSeconds: 1, partial: false, cases: [entry] });
  const dir = mkdtempSync(join(tmpdir(), 'ab-run-test-'));
  const file = join(dir, 'r.json');
  writeFileSync(file, JSON.stringify(j));
  const r = spawnSync(process.execPath, [join(here, 'ab-compare.mjs'), file, file], { encoding: 'utf8' });
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /100\.0/);
});

// --- learning-store isolation -----------------------------------------------------------------

test('defaultConfigDir: CLAUDE_CONFIG_DIR wins, else ~/.claude', () => {
  assert.equal(defaultConfigDir({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/home/u' }), '/cfg');
  assert.equal(defaultConfigDir({ env: {}, home: '/home/u' }), join('/home/u', '.claude'));
});

test('chooseIsolation: auto picks a private config dir only when a token is available', () => {
  assert.deepEqual(chooseIsolation({ requested: 'auto', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }), { mode: 'config-dir' });
  assert.deepEqual(chooseIsolation({ requested: 'auto', env: {} }), { mode: 'store-swap' });
  assert.deepEqual(chooseIsolation({ requested: 'auto', env: { CLAUDE_CODE_OAUTH_TOKEN: '' } }), { mode: 'store-swap' });
  assert.deepEqual(chooseIsolation({ requested: 'store-swap', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }), { mode: 'store-swap' });
});

test('chooseIsolation: config-dir without a token fails with a hint, never echoing a value', () => {
  const r = chooseIsolation({ requested: 'config-dir', env: {} });
  assert.equal(r.mode, undefined);
  assert.match(r.error, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(r.error, /setup-token/);
  assert.throws(() => chooseIsolation({ requested: 'bogus', env: {} }), /isolation/);
});

test('buildEnv points CLAUDE_CONFIG_DIR at the private dir and keeps the token from the environment', () => {
  const { env, diff } = buildEnv({
    base: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret-token', CLAUDE_CONFIG_DIR: '/real' },
    arm: 'active', platform: 'linux', bashPath: 'bash', configDir: '/tmp/private',
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/private');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'secret-token');
  assert.equal(diff.set.CLAUDE_CONFIG_DIR, '/tmp/private');
  assert.equal(JSON.stringify(diff).includes('secret-token'), false);
});

function fakeFs(files) {
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
  return {
    files,
    existsSync: (p) => files.has(p) || [...files].some((f) => f.startsWith(p + '/')),
    readdirSync: (d) => [...files].filter((f) => dirOf(f) === d).map((f) => f.slice(d.length + 1)),
    mkdirSync: () => {},
    renameSync: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.delete(a); files.add(b); },
    rmSync: (p) => { files.delete(p); },
  };
}

test('storeFileNames keeps only the mod learning stores', () => {
  assert.deepEqual(
    storeFileNames(['model-escalator_inline-601199656486.json', 'other.json', 'model-escalator_inline-1.json.tmp', 'model-escalator_model-escalator-ab12.json']),
    ['model-escalator_inline-601199656486.json', 'model-escalator_model-escalator-ab12.json'],
  );
});

test('buildClaudeArgs disables the installed copy of the mod with inline settings', () => {
  const args = buildClaudeArgs({ pluginDir: '/tmp/p', model: 'opus', allowedTools: ['Read'] });
  const i = args.indexOf('--settings');
  assert.ok(i >= 0);
  assert.deepEqual(JSON.parse(args[i + 1]), { enabledPlugins: { 'model-escalator@model-escalator': false } });
  assert.equal(DISABLE_INSTALLED_SETTINGS, args[i + 1]);
});

test('moveStoreAside then restoreStore brings the original back and drops what the runs wrote', () => {
  const dir = '/c/plugins/store';
  const fs = fakeFs(new Set([`${dir}/model-escalator_inline-1.json`, `${dir}/unrelated.json`]));
  const aside = moveStoreAside({ storeDir: dir, backupDir: `${dir}/.bak`, fs });
  assert.equal(aside.moved.length, 1);
  assert.equal(fs.files.has(`${dir}/model-escalator_inline-1.json`), false);
  assert.equal(fs.files.has(`${dir}/unrelated.json`), true);
  fs.files.add(`${dir}/model-escalator_inline-1.json`); // a run wrote a fresh store
  fs.files.add(`${dir}/model-escalator_inline-2.json`);
  const failed = restoreStore({ aside, storeDir: dir, fs });
  assert.deepEqual(failed, []);
  assert.equal(fs.files.has(`${dir}/model-escalator_inline-1.json`), true);
  assert.equal(fs.files.has(`${dir}/.bak/model-escalator_inline-1.json`), false);
  assert.equal(fs.files.has(`${dir}/model-escalator_inline-2.json`), false);
  assert.equal(fs.files.has(`${dir}/unrelated.json`), true);
});

test('moveStoreAside with no existing store is a no-op and restore is safe', () => {
  const dir = '/c/plugins/store';
  const fs = fakeFs(new Set());
  const aside = moveStoreAside({ storeDir: dir, backupDir: `${dir}/.bak`, fs });
  assert.deepEqual(aside.moved, []);
  assert.deepEqual(restoreStore({ aside, storeDir: dir, fs }), []);
});

test('restoreStore keeps going and reports files it could not restore', () => {
  const dir = '/c/plugins/store';
  const fs = fakeFs(new Set([`${dir}/model-escalator_inline-1.json`, `${dir}/model-escalator_inline-2.json`]));
  const aside = moveStoreAside({ storeDir: dir, backupDir: `${dir}/.bak`, fs });
  fs.files.delete(`${dir}/.bak/model-escalator_inline-1.json`); // lost
  const failed = restoreStore({ aside, storeDir: dir, fs });
  assert.equal(failed.length, 1);
  assert.equal(fs.files.has(`${dir}/model-escalator_inline-2.json`), true);
});

test('clearStore removes only learning stores between runs', () => {
  const dir = '/c/plugins/store';
  const fs = fakeFs(new Set([`${dir}/model-escalator_inline-9.json`, `${dir}/keep.json`]));
  clearStore({ storeDir: dir, fs });
  assert.deepEqual([...fs.files], [`${dir}/keep.json`]);
});
