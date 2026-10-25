// OTLP/HTTP JSON logs for sensorium. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
// Records carry event names, counts and short ids, never file contents or secrets.

type Value = string | number | boolean
type Record_ = { timeUnixNano: string; severityText: string; body: { stringValue: string }; attributes: { key: string; value: Record<string, Value> }[] }

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, "")
const service = process.env.OTEL_SERVICE_NAME ?? "roll"
const headers: Record<string, string> = { "content-type": "application/json" }
for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
  const at = pair.indexOf("=")
  if (at > 0) headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim())
}

let queue: Record_[] = []

function attr(key: string, value: Value): { key: string; value: Record<string, Value> } {
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } }
  if (typeof value === "boolean") return { key, value: { boolValue: value } }
  return { key, value: { stringValue: value } }
}

export function log(event: string, attributes: Record<string, Value | undefined> = {}, severity: "INFO" | "WARN" | "ERROR" = "INFO") {
  const line = { event, ...attributes }
  if (severity === "INFO") console.log(JSON.stringify(line))
  else console.error(JSON.stringify(line))
  if (!endpoint) return
  queue.push({
    timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
    severityText: severity,
    body: { stringValue: event },
    attributes: Object.entries({ event, ...attributes }).filter(([, v]) => v !== undefined).map(([k, v]) => attr(k, v as Value)),
  })
  if (queue.length >= 100) void flush()
}

export async function flush() {
  if (!endpoint || queue.length === 0) return
  const records = queue
  queue = []
  const body = { resourceLogs: [{ resource: { attributes: [attr("service.name", service)] }, scopeLogs: [{ scope: { name: "roll" }, logRecords: records }] }] }
  try {
    const res = await fetch(`${endpoint}/v1/logs`, { method: "POST", headers, body: JSON.stringify(body) })
    if (!res.ok) console.error(JSON.stringify({ event: "otel.export_failed", status: res.status }))
  } catch (error) {
    console.error(JSON.stringify({ event: "otel.export_failed", error: String(error) }))
  }
}

if (endpoint) setInterval(() => void flush(), 5000).unref()
