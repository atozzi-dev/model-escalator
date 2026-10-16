import { parseVersion } from './version.mjs'

/**
 * Parses a version range into comparator sets.
 *
 *   parseRange(text) -> Array<Array<{ op, version }>>
 *
 * The result is an OR of sets; a version matches the range if it matches every comparator of at least
 * one set. `op` is one of ">=", ">", "<=", "<", "=" and `version` a parsed version (see parseVersion).
 *
 * Grammar:
 *  - Sets are separated by "||"; blanks around them are ignored. An empty set (or an empty range)
 *    means "*".
 *  - A set is either a hyphen range "A - B" (spaces around the hyphen are required) or one or more
 *    space-separated simple ranges. Whitespace between an operator and its version (">= 1.2.3") is
 *    allowed.
 *  - A partial version has 1 to 3 parts; a missing part, "x", "X" or "*" is a wildcard. A wildcard may
 *    only be followed by wildcards ("1.x.3" is invalid). Prereleases are allowed only on full versions.
 *  - "*", "x" or "" match everything: ">=0.0.0".
 *  - Plain or "=" partials: "1.2.3" is exactly that version; "1.2" and "1.2.x" are >=1.2.0 <1.3.0;
 *    "1" and "1.x" are >=1.0.0 <2.0.0.
 *  - "~": allows patch-level changes if a minor is given, minor-level changes otherwise.
 *    ~1.2.3 and ~1.2 are >=1.2.x <1.3.0; ~1 is >=1.0.0 <2.0.0; ~0.2.3 is >=0.2.3 <0.3.0.
 *  - "^": allows changes that keep the leftmost non-zero part. ^1.2.3 is >=1.2.3 <2.0.0;
 *    ^0.2.3 is >=0.2.3 <0.3.0; ^0.0.3 is >=0.0.3 <0.0.4; ^1.2 is >=1.2.0 <2.0.0; ^0.0 is >=0.0.0 <0.1.0;
 *    ^0 is >=0.0.0 <1.0.0; ^1.2.x is >=1.2.0 <2.0.0; ^0.0.x is >=0.0.0 <0.1.0. A prerelease on the full
 *    version is kept in the lower bound: ^1.2.3-beta.2 is >=1.2.3-beta.2 <2.0.0.
 *  - Comparisons with a partial: ">1.2" is >=1.3.0, ">1" is >=2.0.0, ">=1.2" is >=1.2.0, "<1.2" is
 *    <1.2.0, "<=1.2" is <1.3.0, "<=1" is <2.0.0, "<1" is <1.0.0, ">1.2.3" and the other full versions
 *    compare as they are.
 *  - Hyphen ranges are inclusive: a partial lower bound is filled with zeros ("1.2 - 2.3.4" is
 *    >=1.2.0 <=2.3.4); a partial upper bound allows everything inside it ("1.2.3 - 2.3" is
 *    >=1.2.3 <2.4.0, "1.2.3 - 2" is >=1.2.3 <3.0.0).
 *  - Anything else throws a TypeError.
 */
const WILDCARD = /^(?:x|X|\*)$/
const PARTIAL = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

const gte = (version) => ({ op: '>=', version })
const lt = (version) => ({ op: '<', version })
const v = (major, minor, patch, prerelease = []) => ({ major, minor, patch, prerelease })

/** { major, minor, patch, prerelease, parts } where `parts` is how many numeric parts were given. */
function parsePartial(text) {
  const match = PARTIAL.exec(text)
  if (!match) throw new TypeError(`invalid range: ${text}`)
  const pieces = [match[1], match[2], match[3]]
  let parts = 0
  for (const piece of pieces) {
    if (piece === undefined) break
    if (WILDCARD.test(piece)) break
    parts++
  }
  for (let i = parts + 1; i < 3; i++) {
    if (pieces[i] !== undefined && !WILDCARD.test(pieces[i])) throw new TypeError(`invalid range: ${text}`)
  }
  if (parts === 3) return { ...parseVersion(text), parts }
  if (match[4] || text.includes('+')) throw new TypeError(`invalid range: ${text}`)
  const [major, minor] = pieces.map((p) => (p === undefined || WILDCARD.test(p) ? 0 : Number(p)))
  return { ...v(major, parts >= 2 ? minor : 0, 0), parts }
}

/** Upper bound (exclusive) just above everything covered by a partial, or null for "*". */
function ceiling(p) {
  if (p.parts === 0) return null
  if (p.parts === 1) return v(p.major + 1, 0, 0)
  return v(p.major, p.minor + 1, 0)
}

function simple(op, text) {
  const p = parsePartial(text)
  const version = v(p.major, p.minor, p.patch, p.prerelease)
  if (p.parts === 3 && op !== '~' && op !== '^') {
    return [{ op: op === '' ? '=' : op, version }]
  }
  if (op === '' || op === '=') {
    const top = ceiling(p)
    return top ? [gte(version), lt(top)] : [gte(v(0, 0, 0))]
  }
  if (op === '~') {
    if (p.parts === 0) return [gte(v(0, 0, 0))]
    return [gte(version), lt(v(p.major, p.minor + 1, 0))]
  }
  if (op === '^') {
    if (p.parts === 0) return [gte(v(0, 0, 0))]
    let top
    if (p.major > 0) top = v(p.major + 1, 0, 0)
    else if (p.parts === 1) top = v(1, 0, 0)
    else top = v(0, p.minor + 1, 0)
    return [gte(version), lt(top)]
  }
  const top = ceiling(p)
  if (op === '>') return [{ op: '>', version }]
  if (op === '>=') return [gte(version)]
  if (op === '<') return [lt(version)]
  // "<="
  return p.parts === 3 ? [{ op: '<=', version }] : top ? [lt(top)] : [gte(v(0, 0, 0))]
}

function parseSet(text) {
  const source = text.trim()
  if (source === '') return [gte(v(0, 0, 0))]
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(source)
  if (hyphen) {
    const from = parsePartial(hyphen[1])
    const to = parsePartial(hyphen[2])
    const lower = gte(v(from.major, from.minor, from.patch, from.prerelease))
    if (to.parts === 3) return [lower, { op: '<=', version: v(to.major, to.minor, to.patch, to.prerelease) }]
    return [lower, { op: '<=', version: v(to.major, to.minor, to.patch, to.prerelease) }]
  }
  const comparators = []
  for (const token of source.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(token)
    comparators.push(...simple(match[1] ?? '', match[2]))
  }
  return comparators
}

export function parseRange(text) {
  if (typeof text !== 'string') throw new TypeError(`invalid range: ${text}`)
  return text.split('||').map(parseSet)
}
