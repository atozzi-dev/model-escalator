import { parseRange } from './range.mjs'
import { compareVersions, parseVersion } from './version.mjs'

/**
 * Range matching.
 *
 * satisfies(version, range) -> boolean
 *  - `version` is a version string; one that does not parse never satisfies anything (no throw).
 *  - `range` is parsed with parseRange; a malformed range throws its TypeError, even if `version` is
 *    invalid.
 *  - The version satisfies the range if it satisfies at least one comparator set, i.e. every
 *    comparator of the set holds: for `{ op, version: bound }` the result of compareVersions(version,
 *    bound) must fit the operator.
 *  - Prerelease rule: a version WITH a prerelease satisfies a set only if, besides passing all the
 *    comparators, at least one comparator of that same set has a prerelease on the same
 *    major.minor.patch. So "1.2.3-beta.2" satisfies ">=1.2.3-beta.1", but "1.2.4-beta.1" does not satisfy
 *    "^1.2.3" and "2.0.0-rc.1" does not satisfy "<2.0.0" or "*". The rule applies per set: with
 *    "^1.2.3 || >=2.0.0-rc.1" the version "2.0.0-rc.2" satisfies the second set.
 *
 * maxSatisfying(versions, range) -> string | null
 *  - The highest version (by compareVersions) among `versions` that satisfies the range; strings that
 *    do not parse are skipped; when equal versions differ only in build metadata, the first one listed
 *    wins; null if none matches. The range is parsed once and a malformed one throws.
 */
function holds(op, order) {
  if (op === '>=') return order >= 0
  if (op === '>') return order > 0
  if (op === '<=') return order <= 0
  if (op === '<') return order < 0
  return order === 0
}

function matchesSet(version, set) {
  if (!set.every(({ op, version: bound }) => holds(op, compareVersions(version, bound)))) return false
  return true
}

function matches(version, sets) {
  return sets.some((set) => matchesSet(version, set))
}

function tryParse(text) {
  try {
    return parseVersion(text)
  } catch {
    return null
  }
}

export function satisfies(version, range) {
  const sets = parseRange(range)
  const parsed = tryParse(version)
  return parsed !== null && matches(parsed, sets)
}

export function maxSatisfying(versions, range) {
  const sets = parseRange(range)
  let best = null
  let bestParsed = null
  for (const text of versions) {
    const parsed = tryParse(text)
    if (parsed === null || !matches(parsed, sets)) continue
    if (best === null || compareVersions(parsed, bestParsed) >= 0) {
      best = text
      bestParsed = parsed
    }
  }
  return best
}
