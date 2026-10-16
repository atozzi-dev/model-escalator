/**
 * Semantic versions, as strict as semver.org.
 *
 * parseVersion(text) -> { major, minor, patch, prerelease }
 *  - Exactly "MAJOR.MINOR.PATCH", optionally followed by "-PRERELEASE" and/or "+BUILD". No leading "v",
 *    no spaces, no missing parts.
 *  - MAJOR, MINOR and PATCH are non-negative integers without leading zeros ("0" is fine, "01" is not).
 *  - PRERELEASE is a dot-separated list of non-empty identifiers made of [0-9A-Za-z-]. An identifier
 *    of digits only is numeric and must not have leading zeros; it is returned as a number. Any other
 *    identifier is returned as a string. A version without prerelease has `prerelease: []`.
 *  - BUILD metadata (dot-separated identifiers of [0-9A-Za-z-], leading zeros allowed) is validated and
 *    then dropped: it never takes part in comparisons.
 *  - Anything else throws a TypeError.
 *
 * compareVersions(a, b) -> -1 | 0 | 1, for two version strings or parsed versions.
 *  - Compares major, minor and patch numerically.
 *  - If those are equal, a version WITH a prerelease is lower than one without ("1.0.0-rc.1" < "1.0.0").
 *  - Two prereleases are compared identifier by identifier: numeric identifiers numerically and lower
 *    than alphanumeric ones; alphanumeric identifiers by ASCII order; if all shared identifiers are
 *    equal, the list with fewer identifiers is lower ("1.0.0-alpha" < "1.0.0-alpha.1").
 *  - Build metadata is ignored ("1.0.0+a" equals "1.0.0+b").
 */
const NUMBER = '\\d+'
const PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const BUILD_ID = '[0-9A-Za-z-]+'
const VERSION = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`,
)

export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null
  if (!match) throw new TypeError(`invalid version: ${text}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  }
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0)

function compareIdentifiers(a, b) {
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return sign(x[part] - y[part])
  }
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0
  if (x.prerelease.length === 0) return -1
  if (y.prerelease.length === 0) return 1
  const shared = Math.min(x.prerelease.length, y.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifiers(x.prerelease[i], y.prerelease[i])
    if (c !== 0) return c
  }
  return sign(x.prerelease.length - y.prerelease.length)
}
