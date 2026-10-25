// Date search: a query names a year, a month or a day, and becomes a time
// range. Days are Taiwan days. Smart search (places, people, meaning) comes later.
const OFFSET = "+08:00"

export type Range = { from: number; to: number }

const at = (y: number, m: number, d: number) => Date.parse(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00${OFFSET}`)

function span(y: number, m?: number, d?: number): Range | null {
  if (m !== undefined && (m < 1 || m > 12)) return null
  if (d !== undefined && (d < 1 || d > 31)) return null
  if (m === undefined) return { from: at(y, 1, 1), to: at(y + 1, 1, 1) }
  if (d === undefined) return { from: at(y, m, 1), to: m === 12 ? at(y + 1, 1, 1) : at(y, m + 1, 1) }
  const from = at(y, m, d)
  // Date.parse rolls 2/30 over into March; refuse a day the month lacks.
  if (!Number.isFinite(from) || new Date(from + 8 * 3_600_000).getUTCDate() !== d) return null
  return { from, to: from + 86_400_000 }
}

// A year left out means the latest such month or day that is not in the future.
function latest(m: number, d: number | undefined, now: number) {
  const year = new Date(now).getUTCFullYear()
  for (const y of [year, year - 1]) {
    const range = span(y, m, d)
    if (range && range.from <= now) return range
  }
  return span(year - 1, m, d)
}

export function parseDateQuery(input: string, now = Date.now()): Range | null {
  // NFKC turns full-width digits from a Chinese input method into ASCII.
  const q = input.normalize("NFKC").trim().replace(/\s+/g, "").replace(/[年月]/g, "/").replace(/[日號号]$/, "")
  let match: RegExpExecArray | null
  if ((match = /^(\d{4})$/.exec(q))) return span(Number(match[1]))
  if ((match = /^(\d{4})[-/.](\d{1,2})\/?$/.exec(q))) return span(Number(match[1]), Number(match[2]))
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(q))) return span(Number(match[1]), Number(match[2]), Number(match[3]))
  if ((match = /^(\d{1,2})\/$/.exec(q))) return latest(Number(match[1]), undefined, now)
  if ((match = /^(\d{1,2})[-/.](\d{1,2})$/.exec(q))) return latest(Number(match[1]), Number(match[2]), now)
  return null
}
