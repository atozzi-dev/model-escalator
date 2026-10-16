// Pure parser: reads tool output text and returns every test-run summary it contains.
// It works from the text alone (it never sees isError), so it also copes with commands
// that end in `; echo "exit=$?"` and with loops that run the tests several times.

export type Framework = 'jest' | 'vitest' | 'pytest' | 'go' | 'cargo' | 'bun' | 'generic'

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

// bun test (and `claude plugin test`) summary lines: " 699 pass", " 1 skip", " 0 fail", "Ran 700 tests across 58 files."
const BUN_PASS = /^\s*(\d+) pass\s*$/
const BUN_FAIL = /^\s*(\d+) fail\s*$/
const BUN_OTHER = /^\s*\d+ (?:skip|todo)\s*$/
const BUN_RAN = /^Ran \d+ tests? across \d+ files?\b/

export function parseTestRuns(text: string): TestRun[] {
  try {
    if (typeof text !== 'string') return []
    const runs: TestRun[] = []
    // go emits several lines per run: count top-level "--- FAIL" and close on the package line.
    let goFails = 0
    let goBare: TestRun | undefined
    const flushBare = () => { if (goBare) runs.push(goBare); goBare = undefined }
    // bun: the pass count waits for its fail line (or the "Ran N tests" line when the fail line is missing).
    let bunPassed: number | undefined
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
      // bun prints its counts one per line: " 3 pass", then " 1 skip" / " 1 todo" maybe, then " 2 fail".
      const bunPass = line.match(BUN_PASS)
      if (bunPass) { bunPassed = Number(bunPass[1]); continue }
      const bunFail = line.match(BUN_FAIL)
      if (bunFail) {
        runs.push(run('bun', Number(bunFail[1]), bunPassed)!)
        bunPassed = undefined
        continue
      }
      if (bunPassed !== undefined) {
        if (BUN_OTHER.test(line)) continue
        if (BUN_RAN.test(line)) runs.push(run('bun', 0, bunPassed)!)
        bunPassed = undefined
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

// A 53-bit string hash (cyrb53), base 36: equal inputs give equal keys, and a collision within one session is
// practically impossible. Used for what is only ever compared: error signatures, file paths, outputs, commands.
export function hashKey(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// Lines that report a failure in the output's own words, for commands that exit 0 anyway (a pipe into `tail`, `|| true`,
// a script that always exits 0). Each pattern names a failure, not a topic: "error handling" or "fail-safe" do not match.
const FAILURE_LINES: readonly RegExp[] = [
  /\bFAIL(?:ED|URE|S)?\b/,                                  // FAIL, FAILED, FAILURE (upper case: a verdict, not prose)
  /\b[Ff]ailed\b/,                                          // "Build failed", "Failed to compile"
  /(?:^|\s)(?:error|Error|ERROR)(?:\[[\w-]+\]| TS\d+)?:/,   // "error:", "Error:", "error[E0308]:", "error TS2322:"
  /\b[A-Z][A-Za-z]*Error:/,                                 // TypeError:, AssertionError:, ValueError:
  /^Traceback \(most recent call last\)/,
  /^\s*[✗✘✕]\s/,
  /^not ok \d/,                                             // TAP
  /^panic:/,                                                // go
]
// A line that only says nothing failed.
const NO_FAILURE = /\b(?:0|no|zero|without)\s+(?:fail|error)/i

// True when the output reports a failure on some line. Pure; never throws.
export function softFailure(text: string): boolean {
  try {
    if (typeof text !== 'string' || text === '') return false
    return clip(text).replace(ANSI, '').split(/\r?\n/).some((l) => !NO_FAILURE.test(l) && FAILURE_LINES.some((p) => p.test(l)))
  } catch {
    return false
  }
}

// Outputs are read up to this many characters from each end: the verdict is at the start or at the end.
const OUTPUT_EDGE = 16_000
const clip = (t: string): string => (t.length <= 2 * OUTPUT_EDGE ? t : t.slice(0, OUTPUT_EDGE) + '\n' + t.slice(-OUTPUT_EDGE))

// The output without what changes between two identical runs: colours, dates and clock times, durations, hex ids,
// temporary folders, process ids and ports, long numbers (epoch times, sizes), spacing. Small numbers stay: "got 5" and "got 6" differ.
export function normalizeOutput(text: string): string {
  if (typeof text !== 'string') return ''
  return clip(text)
    .replace(ANSI, '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:[.,]\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds|m|min|mins|minutes)\b/g, '<dur>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var\/folders)\/[^\s'"`:;,)]*/g, '<tmp>')
    .replace(/\b[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*?(?:Temp|tmp)[\\/][^\s'"`:;,)]*/gi, '<tmp>')
    .replace(/\b(pid|port)[\s=:#]*\d+/gi, '$1 <n>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

// The fingerprint of an output: a short hash of its normalised text. The text itself is never kept.
export function outputPrint(text: string): string {
  return hashKey(normalizeOutput(text))
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
