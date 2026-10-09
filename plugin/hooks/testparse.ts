// Pure parser: reads tool output text and returns every test-run summary it contains.
// It works from the text alone (it never sees isError), so it also copes with commands
// that end in `; echo "exit=$?"` and with loops that run the tests several times.

export type Framework = 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'generic'

// `failed` counts failed tests (pytest: failed + errors). `passed` is omitted when the
// runner does not print it (go test) or when the summary only reports errors.
export type TestRun = { framework: Framework; failed: number; passed?: number }

// Matches ANSI CSI sequences (colours, cursor moves).
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g')

const count = (line: string, word: RegExp): number | undefined => {
  const m = line.match(word)
  return m ? Number(m[1]) : undefined
}

const FAILED = /(\d+)\s+(?:failed|failing|failures?)\b/i
const PASSED = /(\d+)\s+(?:passed|passing)\b/i

function run(framework: Framework, failed: number | undefined, passed: number | undefined): TestRun | undefined {
  if (failed === undefined && passed === undefined) return undefined
  const r: TestRun = { framework, failed: failed ?? 0 }
  if (passed !== undefined) r.passed = passed
  return r
}

// "Tests:       3 failed, 10 passed, 13 total" (jest); the "Test Suites:" line is not a test count.
function jest(line: string): TestRun | undefined {
  if (!/^\s*Tests:\s/.test(line)) return undefined
  return run('jest', count(line, FAILED), count(line, PASSED))
}

// "     Tests  1 failed | 4 passed (5)" (vitest); "Test Files" is skipped.
function vitest(line: string): TestRun | undefined {
  if (!/^\s*Tests\s{2,}\S/.test(line)) return undefined
  return run('vitest', count(line, FAILED), count(line, PASSED))
}

// "=== 2 failed, 3 passed, 1 warning in 0.12s ===": counts, then " in <seconds>", nothing else.
const PYTEST = /^[=\s-]*((?:\d+ [A-Za-z]+(?:, )?)+) in [\d.]+s?(?: \([^)]*\))?[=\s-]*$/
function pytest(line: string): TestRun | undefined {
  const m = line.match(PYTEST)
  if (!m) return undefined
  const body = m[1]!
  const failed = count(body, /(\d+) failed\b/)
  const errors = count(body, /(\d+) errors?\b/)
  const passed = count(body, /(\d+) passed\b/)
  if (failed === undefined && errors === undefined && passed === undefined) return undefined
  return run('pytest', failed !== undefined || errors !== undefined ? (failed ?? 0) + (errors ?? 0) : undefined, passed)
}

// "test result: FAILED. 3 passed; 1 failed; 0 ignored; ..." (cargo)
function cargo(line: string): TestRun | undefined {
  if (!/^\s*test result:\s/.test(line)) return undefined
  return run('cargo', count(line, /(\d+) failed\b/), count(line, /(\d+) passed\b/))
}

// Both counts side by side, in either order: "1 failed, 1 passed", "4 passed | 2 failing".
const GENERIC = /\b\d+\s+(?:failed|failing|failures?)\s*[,;|]\s*\d+\s+(?:passed|passing)\b|\b\d+\s+(?:passed|passing)\s*[,;|]\s*\d+\s+(?:failed|failing|failures?)\b/i
function generic(line: string): TestRun | undefined {
  if (!GENERIC.test(line) || /^\s*Test (?:Suites:|Files\s)/.test(line)) return undefined
  return run('generic', count(line, FAILED), count(line, PASSED))
}

const LINE_PARSERS = [jest, vitest, pytest, cargo, generic]

// `go test` package lines: "ok  \tpkg\t0.002s", "ok  \tpkg\t(cached)", "FAIL\tpkg\t0.004s", "FAIL\tpkg [build failed]".
const GO_OK = /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/
const GO_FAIL = /^FAIL\s+\S+\s+(?:[\d.]+s|\[.*\])/

export function parseTestRuns(text: string): TestRun[] {
  try {
    if (typeof text !== 'string') return []
    const runs: TestRun[] = []
    // go emits several lines per run: count top-level "--- FAIL" and close on the package line.
    let goFails = 0
    let goBare: TestRun | undefined
    const flushBare = () => { if (goBare) runs.push(goBare); goBare = undefined }
    for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
      if (/^--- FAIL:/.test(line)) { goFails++; continue }
      if (GO_OK.test(line) || GO_FAIL.test(line)) {
        // the package line supersedes the bare PASS/FAIL printed before it, but keeps its count
        const failed = GO_FAIL.test(line) ? Math.max(goFails + (goBare?.failed ?? 0), 1) : 0
        goBare = undefined
        runs.push({ framework: 'go', failed })
        goFails = 0
        continue
      }
      if (/^(?:PASS|FAIL)\s*$/.test(line)) {
        flushBare()
        goBare = { framework: 'go', failed: /^FAIL/.test(line) ? Math.max(goFails, 1) : 0 }
        goFails = 0
        continue
      }
      for (const p of LINE_PARSERS) {
        const r = p(line)
        if (r) { runs.push(r); break }
      }
    }
    flushBare()
    if (goFails > 0) runs.push({ framework: 'go', failed: goFails })
    return runs
  } catch {
    return []
  }
}

// Markers such as "exit=1", "exit code 2", "exit code: 3", in order. "exit status N" (printed by
// go test itself) is deliberately not a marker: it belongs to the command's own output.
export function exitCodes(text: string): number[] {
  try {
    if (typeof text !== 'string') return []
    return [...text.matchAll(/\bexit(?:=|\s+code:?\s*)(\d+)\b/gi)].map(m => Number(m[1]))
  } catch {
    return []
  }
}
