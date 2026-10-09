/**
 * Serialises rows (arrays of values) to CSV text.
 *
 * - Values are converted with String(); null and undefined become empty fields.
 * - A field is quoted when it contains a comma, a double quote or a line break;
 *   quotes inside a quoted field are doubled.
 * - Fields are separated by commas and rows by \r\n, with no trailing line break.
 */
export function toCsv(rows) {
  return rows.map((row) => row.map(formatField).join(',')).join('\r\n')
}

function formatField(value) {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
