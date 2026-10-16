// Runs whose failures exit 0, and look-alikes that must stay quiet, as detector features only. Synthetic: they
// rebuild the shape of the 0.7 observation's one true miss (a guesser whose check printed FAIL and exited 0) and
// the normal work that shares parts of it. Ids are per run: `o` an output print, `c` a command, `e` an edited file,
// `f` the failing counts of a test summary. Every run starts on Haiku, the tier of the sandbox positives.

export type ExitZeroEvent = { o?: number; c?: number; e?: number; f?: number[] }
export type ExitZeroRun = { name: string; label: 'positive' | 'negative'; tier: 'haiku' | 'sonnet' | 'opus'; events: ExitZeroEvent[] }

const times = <T>(n: number, f: (i: number) => T[]): T[] => Array.from({ length: n }, (_, i) => f(i)).flat()

export const EXIT_ZERO_RUNS: ExitZeroRun[] = [
  // A new candidate each time, the same FAIL line back each time.
  { name: 'guesser with a new command per attempt', label: 'positive', tier: 'haiku', events: times(25, (i) => [{ o: 1, c: i + 1 }]) },
  // Edit, then the same piped check with the same failing output.
  { name: 'same piped check after every edit', label: 'positive', tier: 'haiku', events: times(20, () => [{ e: 1 }, { o: 1, c: 1 }]) },
  // Edits spread over files, the same `|| true` build failure after each.
  { name: 'same build failure after edits of several files', label: 'positive', tier: 'haiku', events: times(20, (i) => [{ e: (i % 3) + 1 }, { o: 1, c: 1 }]) },

  // Polling a log that keeps an old error: same command, same output, nothing changed in between.
  { name: 're-reading a log', label: 'negative', tier: 'haiku', events: times(30, () => [{ o: 1, c: 1 }]) },
  // Two reads that alternate, each always the same.
  { name: 'two alternating reads', label: 'negative', tier: 'haiku', events: times(15, () => [{ o: 1, c: 1 }, { o: 2, c: 2 }]) },
  // A failure fixed after a few tries, then the test run is green.
  { name: 'a failure fixed after three tries', label: 'negative', tier: 'haiku', events: [{ o: 1, c: 1 }, { e: 1 }, { o: 1, c: 1 }, { e: 1 }, { o: 1, c: 1 }, { e: 1 }, { f: [0] }, { o: 2, c: 2 }] },
  // Every attempt fails differently: the other signals' business, not this one's.
  { name: 'a different failure each time', label: 'negative', tier: 'haiku', events: times(30, (i) => [{ e: 1 }, { o: i + 1, c: i + 1 }]) },
  // The same failure twice, far apart.
  { name: 'one failure seen twice', label: 'negative', tier: 'haiku', events: [{ o: 1, c: 1 }, ...times(10, (i) => [{ e: i + 1 }, { o: i + 2, c: 2 }]), { o: 1, c: 1 }] },
]

// The same, as tool calls with their command and output (all exit 0), read through the detector's own features.
// `edit` is an Edit of that file; otherwise a shell call (`tool`, Bash by default) of `cmd` that printed `text`.
// The negatives are reads: their output names a failure and comes back after edits or with a slightly other
// command, but reading is not trying.
export type ShellCall = { edit?: string; tool?: string; cmd?: string; text?: string }
export type ShellRun = { name: string; label: 'positive' | 'negative'; tier: 'haiku' | 'sonnet' | 'opus'; calls: ShellCall[] }

const edited = (file = '/src/lib.ts'): ShellCall => ({ edit: file })

export const EXIT_ZERO_SHELL_RUNS: ShellRun[] = [
  { name: 'test script piped into tail after every edit', label: 'positive', tier: 'haiku',
    calls: times(20, () => [edited('/src/lib.sh'), { cmd: 'bash check.sh | tail -1', text: 'FAILED: adds with carry policy (expected 5, got 4)' }]) },
  { name: 'node test with || true after every edit', label: 'positive', tier: 'haiku',
    calls: times(20, () => [edited(), { cmd: 'node test.js || true', text: 'AssertionError: expected 5 to equal 4' }]) },
  { name: 'guesser behind a cd prefix', label: 'positive', tier: 'haiku',
    calls: times(25, (i) => [{ cmd: `cd sandbox && echo "w${i}" > answer.txt && bash check.sh | tail -1`, text: 'FAIL: answer.txt does not match the expected digest' }]) },

  { name: 'reading an errors module after edits', label: 'negative', tier: 'haiku',
    calls: times(20, () => [edited('/src/errors.ts'), { cmd: 'cat src/errors.ts', text: 'export class ParseError extends Error {}\n// TypeError: thrown by callers' }]) },
  { name: 'grepping for errors with varied commands', label: 'negative', tier: 'haiku',
    calls: times(20, (i) => [edited(), { cmd: `grep -rn "Error:" src${i % 2 === 0 ? '' : '/'}`, text: 'src/a.ts:3: throw new Error: bad input' }]) },
  { name: 'printing the head of a failed log', label: 'negative', tier: 'haiku',
    calls: times(20, (i) => [edited(), { cmd: `sed -n 1,${40 + (i % 3)}p log.txt`, text: 'FAIL old run\nError: timeout' }]) },
  { name: 'git diff and git log between edits', label: 'negative', tier: 'haiku',
    calls: times(15, (i) => [edited(), { cmd: i % 2 === 0 ? 'git diff' : 'git log -3', text: '- throw new Error: old\n+ fix: Failed parse' }]) },
  { name: 'filtering a log behind a cd prefix', label: 'negative', tier: 'haiku',
    calls: times(20, (i) => [edited(), { cmd: `cd app && cat out.log | grep ${i % 2 === 0 ? 'FAIL' : '-i fail'}`, text: 'FAIL: case 1' }]) },
  { name: 'PowerShell reading a log', label: 'negative', tier: 'haiku',
    calls: times(20, (i) => [edited(), { tool: 'PowerShell', cmd: `Get-Content out.log -Tail ${5 + (i % 2)}`, text: 'Error: build failed' }]) },
]
