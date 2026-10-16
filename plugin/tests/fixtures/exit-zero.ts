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
