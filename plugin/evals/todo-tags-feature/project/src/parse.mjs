const LINE = /^- \[( |x)\] (.*)$/
const DUE = /\s*@due\((\d{4}-\d{2}-\d{2})\)/

/**
 * Parses one line of a todo file, for example "- [ ] buy milk @due(2024-05-01)".
 *
 * Returns { done, title, due }, where `due` is the ISO date of an `@due(...)` marker or null.
 * The marker is removed from the title, and the title is trimmed.
 * Returns null when the line is not a todo item.
 */
export function parseLine(line) {
  const match = LINE.exec(line.trimEnd())
  if (!match) return null
  let text = match[2]
  let due = null
  const dueMatch = DUE.exec(text)
  if (dueMatch) {
    due = dueMatch[1]
    text = text.replace(DUE, '')
  }
  return { done: match[1] === 'x', title: text.trim(), due }
}

/** Parses every todo item of a multi-line text, skipping the other lines. */
export function parseText(text) {
  return text.split(/\r?\n/).map(parseLine).filter(Boolean)
}
