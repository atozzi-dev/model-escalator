import { expect, test } from 'claude-code/testing'
import { exitCodes, parseTestRuns } from '../hooks/testparse'

const ESC = String.fromCharCode(27)

test('jest summary, with and without failures', async () => {
  const failing = [
    'FAIL src/a.test.ts',
    '  ● adds numbers',
    '',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       3 failed, 10 passed, 13 total',
    'Snapshots:   0 total',
    'Time:        1.2 s',
  ].join('\n')
  expect(parseTestRuns(failing)).toEqual([{ framework: 'jest', failed: 3, passed: 10 }])
  expect(parseTestRuns('Tests:       12 passed, 12 total\nTime: 1 s')).toEqual([{ framework: 'jest', failed: 0, passed: 12 }])
})

test('vitest summary', async () => {
  const out = [
    ' FAIL  src/a.test.ts > adds',
    ' Test Files  1 failed | 1 passed (2)',
    '      Tests  1 failed | 4 passed (5)',
    '   Duration  1.1s',
  ].join('\n')
  expect(parseTestRuns(out)).toEqual([{ framework: 'vitest', failed: 1, passed: 4 }])
  expect(parseTestRuns('      Tests  7 passed (7)')).toEqual([{ framework: 'vitest', failed: 0, passed: 7 }])
})

test('pytest summary', async () => {
  const out = [
    '============================= test session starts ==============================',
    'collected 5 items',
    'FAILED tests/test_a.py::test_x - assert 1 == 2',
    '=========================== short test summary info ============================',
    '========================= 2 failed, 3 passed in 0.12s ==========================',
  ].join('\n')
  expect(parseTestRuns(out)).toEqual([{ framework: 'pytest', failed: 2, passed: 3 }])
  expect(parseTestRuns('===== 5 passed in 0.10s =====')).toEqual([{ framework: 'pytest', failed: 0, passed: 5 }])
  expect(parseTestRuns('1 failed, 2 passed, 1 warning in 0.5s')).toEqual([{ framework: 'pytest', failed: 1, passed: 2 }])
  expect(parseTestRuns('=== 1 error in 0.05s ===')).toEqual([{ framework: 'pytest', failed: 1 }])
})

test('go test: package lines, failed tests and bare PASS/FAIL', async () => {
  const failing = [
    '--- FAIL: TestAdd (0.00s)',
    '    add_test.go:9: got 3 want 4',
    '--- FAIL: TestSub (0.00s)',
    'FAIL',
    'FAIL\texample.com/m/calc\t0.004s',
    'ok  \texample.com/m/other\t0.002s',
  ].join('\n')
  expect(parseTestRuns(failing)).toEqual([
    { framework: 'go', failed: 2 },
    { framework: 'go', failed: 0 },
  ])
  expect(parseTestRuns('PASS\nok  \texample.com/m\t0.1s (cached)')).toEqual([{ framework: 'go', failed: 0 }])
  expect(parseTestRuns('--- FAIL: TestX (0.00s)\nFAIL\nexit status 1')).toEqual([{ framework: 'go', failed: 1 }])
  expect(parseTestRuns('PASS')).toEqual([{ framework: 'go', failed: 0 }])
  expect(parseTestRuns('FAIL\texample.com/m [build failed]')).toEqual([{ framework: 'go', failed: 1 }])
})

test('cargo test summary', async () => {
  const out = [
    'running 4 tests',
    'test a ... ok',
    'test b ... FAILED',
    'test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ].join('\n')
  expect(parseTestRuns(out)).toEqual([{ framework: 'cargo', failed: 1, passed: 3 }])
  expect(parseTestRuns('test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured')).toEqual([{ framework: 'cargo', failed: 0, passed: 4 }])
})

test('generic "N failed, M passed" style in either order', async () => {
  expect(parseTestRuns('1 failed, 1 passed')).toEqual([{ framework: 'generic', failed: 1, passed: 1 }])
  expect(parseTestRuns('result: 4 passed, 2 failed')).toEqual([{ framework: 'generic', failed: 2, passed: 4 }])
  expect(parseTestRuns('Results: 3 failing | 9 passing')).toEqual([{ framework: 'generic', failed: 3, passed: 9 }])
})

test('bun summary (bun test, claude plugin test): one run per pass/fail pair', async () => {
  const failing = [
    '(pass) adds numbers [1.20ms]',
    '(fail) subtracts numbers [0.80ms]',
    '',
    ' 699 pass',
    ' 2 fail',
    ' 1234 expect() calls',
    'Ran 701 tests across 58 files. [46.60s]',
  ].join('\n')
  expect(parseTestRuns(failing)).toEqual([{ framework: 'bun', failed: 2, passed: 699 }])
  expect(parseTestRuns(' 705 pass\n 0 fail\nRan 705 tests across 58 files. [46.60s]')).toEqual([{ framework: 'bun', failed: 0, passed: 705 }])
  // Skipped and todo counts may stand between the two lines.
  expect(parseTestRuns(' 3 pass\n 1 skip\n 1 todo\n 4 fail')).toEqual([{ framework: 'bun', failed: 4, passed: 3 }])
  expect(parseTestRuns(`${ESC}[32m 5 pass${ESC}[0m\n${ESC}[31m 1 fail${ESC}[0m`)).toEqual([{ framework: 'bun', failed: 1, passed: 5 }])
  // A loop over the suite gives one run per summary.
  expect(parseTestRuns(' 3 pass\n 2 fail\n 4 pass\n 1 fail').map((r) => r.failed)).toEqual([2, 1])
  // A summary cut before its fail line still counts its passes, closed by the "Ran" line.
  expect(parseTestRuns(' 9 pass\nRan 9 tests across 1 file. [5.00ms]')).toEqual([{ framework: 'bun', failed: 0, passed: 9 }])
})

test('bun-like words inside ordinary text are not a summary', async () => {
  expect(parseTestRuns('we pass 3 values')).toEqual([])
  expect(parseTestRuns('3 pass\nthe build is fine')).toEqual([])
  expect(parseTestRuns('ticket 12 fail on retry')).toEqual([])
})

test('several runs in one output are all returned, in order', async () => {
  const one = (n: number) => `run ${n}\nTests:       ${n} failed, 5 passed, ${n + 5} total\nexit=1\n`
  const out = [3, 2, 2].map(one).join('')
  expect(parseTestRuns(out).map(r => r.failed)).toEqual([3, 2, 2])
  expect(exitCodes(out)).toEqual([1, 1, 1])
})

test('ANSI colour codes are ignored', async () => {
  const out = `${ESC}[1mTests:${ESC}[22m       ${ESC}[31m2 failed${ESC}[39m, ${ESC}[32m8 passed${ESC}[39m, 10 total`
  expect(parseTestRuns(out)).toEqual([{ framework: 'jest', failed: 2, passed: 8 }])
  expect(parseTestRuns(`${ESC}[31m=== 1 failed, 1 passed in 0.1s ===${ESC}[0m`)).toEqual([{ framework: 'pytest', failed: 1, passed: 1 }])
})

test('exit markers appended by the agent', async () => {
  expect(exitCodes('Tests: 1 failed, 1 passed, 2 total\nexit=1')).toEqual([1])
  expect(exitCodes('exit=0\nexit code 2\nexit code: 3')).toEqual([0, 2, 3])
  expect(exitCodes('echo "exit=$?"')).toEqual([])
  expect(exitCodes('exit status 1')).toEqual([])
})

test('ordinary text and bad input never match or throw', async () => {
  expect(parseTestRuns('')).toEqual([])
  expect(parseTestRuns('compiled ok')).toEqual([])
  expect(parseTestRuns('0 failed attempts to connect, retrying')).toEqual([])
  expect(parseTestRuns('FAIL src/a.test.ts')).toEqual([])
  expect(parseTestRuns('PASS src/a.test.ts (1.2 s)')).toEqual([])
  expect(parseTestRuns(undefined as unknown as string)).toEqual([])
  expect(parseTestRuns(42 as unknown as string)).toEqual([])
  expect(exitCodes(undefined as unknown as string)).toEqual([])
})
