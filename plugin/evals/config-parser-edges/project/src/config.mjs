/**
 * Parser for our INI-like configuration files.
 *
 * Format, line by line (lines end with \n or \r\n):
 * - Comments: outside double quotes, a `#` or `;` at the start of a line or right after
 *   whitespace starts a comment that runs to the end of the line. (`a#b` and
 *   `http://host/#top` contain no comment.) Lines left blank are ignored.
 * - `[name]` starts a section (name trimmed, not empty). Keys before the first section belong
 *   to the section "". A section that appears twice is merged; for a repeated key the last value wins.
 * - `key = value`, split at the first `=`: key and value are trimmed; the key must not be empty.
 *   The value may be empty.
 * - A value may be wrapped in double quotes, which keep its spaces and comment characters.
 *   Inside quotes, `\"` is a quote, `\\` a backslash, `\n` a newline and `\t` a tab.
 *   Only whitespace or a comment may follow the closing quote. A quote that does not open
 *   the value is an ordinary character.
 * - An unquoted value ending with a backslash continues on the next line: the backslash and
 *   the whitespace before it are dropped, and the next line, trimmed and without its comment,
 *   is appended after a single space (it may continue again). A continuation on the last
 *   line of the file is an error.
 *
 * Returns { [section]: { [key]: value } } with string values.
 * Throws a ConfigError whose `line` is the 1-based number of the offending line
 * (for a continued value, the line where the problem is).
 */
export class ConfigError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`)
    this.name = 'ConfigError'
    this.line = line
  }
}

export function parseConfig(text) {
  const result = { '': {} }
  let section = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].split(/[#;]/)[0].trim()
    if (line === '') continue
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new ConfigError('unterminated section header', i)
      section = line.slice(1, -1).trim()
      result[section] = {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) throw new ConfigError('expected key = value', i)
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    while (value.endsWith('\\')) {
      i++
      value = value.slice(0, -1) + lines[i].trim()
    }
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    result[section][key] = value
  }
  return result
}
