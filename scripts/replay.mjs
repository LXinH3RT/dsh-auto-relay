// Replay real session logs through the watchdog itself.
//
// The unit tests prove the state machine against synthetic events. This script
// checks what those cannot: that the events THIS profile writes are recognised,
// in the order it writes them, with the occupancy the log implies.
//
// It drives `createWatcher` rather than re-implementing the counting, so the
// numbers below are what the plugin would actually do on that session. It reads
// persisted logs only — no Host, no live session, no scheduling.
//
// Usage:
//   node scripts/replay.mjs [--session <id>] [--limit <n>] [--threshold <pct>] [--count <n>]
//
// Exits non-zero when no compression was recognised at all, because that means
// the detector no longer matches this profile's vocabulary.

import { findLogs, readLog } from './session-log.mjs'
import { DEFAULT_COMPRESS_TOOLS, compressionMarker } from '../lib/compress-events.js'
import { createWatcher, occupancy } from '../lib/watch.js'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const limit = Number(arg('limit', '5'))
const thresholdPercent = Number(arg('threshold', '50'))
const consecutiveCount = Number(arg('count', '5'))
const wanted = arg('session', null)

const logs = findLogs().filter((log) => wanted === null || log.id === wanted).slice(0, limit)
if (logs.length === 0) {
  console.error('no session logs matched')
  process.exit(1)
}

const TOOLS = new Set(DEFAULT_COMPRESS_TOOLS)
let totalRecords = 0
let totalMarkers = 0
let totalRelays = 0

for (const log of logs) {
  let records
  try {
    records = readLog(log.path)
  } catch (error) {
    console.error(`${log.id}: unreadable (${String(error?.message ?? error)})`)
    continue
  }

  // The surface fold the Host keeps, rebuilt from the log. Only the parts that
  // move the occupancy reading matter: the window from `request/context`, the
  // prompt size from a usage sample, and the surface size so `projectedTokens`
  // matches what the meter would show.
  let contextWindow = null
  let pressureTokens = null
  let surfaceTokens = 0
  let sampledSurfaceTokens = null

  /** The pressure the Host would project at this instant. */
  function currentPressure() {
    if (pressureTokens === null && contextWindow === null) return null
    return {
      ...(pressureTokens === null ? {} : { pressureTokens }),
      ...(contextWindow === null ? {} : { contextWindow }),
      ...(pressureTokens === null
        ? {}
        : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - (sampledSurfaceTokens ?? surfaceTokens)) }),
    }
  }

  const relays = []
  const seen = []
  const watcher = createWatcher({
    config: {
      enabled: true,
      thresholdPercent,
      consecutiveCount,
      incrementTitle: true,
      separator: '-',
      delaySeconds: 1,
      defaultTitle: '自动接力',
      promptTemplate: '{sessionId}',
      ignoreSubagents: true,
      oncePerSession: true,
      compressTools: DEFAULT_COMPRESS_TOOLS.join(','),
    },
    readOccupancy: () => occupancy(currentPressure()),
    readTitle: () => 'replay-1',
    hasOpenTurn: () => false,
    handOff: async (session, armed) => {
      relays.push(armed)
      return { sessionId: 'session-replay-continuation', title: 'replay-2' }
    },
    log: () => {},
    warn: (message) => console.error(`  warn: ${message}`),
  })

  const session = { id: log.id, header: {} }

  for (const record of records) {
    totalRecords += 1
    const data = record.data ?? {}

    if (record.type === 'request/context' && typeof data.contextWindow === 'number') {
      contextWindow = data.contextWindow
    }
    if (
      (record.type === 'assistant/message' || record.type === 'assistant/attempt')
      && typeof data.usage?.inputTokens === 'number'
    ) {
      pressureTokens = data.usage.inputTokens + (data.usage.cacheReadTokens ?? 0) + (data.usage.cacheWriteTokens ?? 0)
      sampledSurfaceTokens = surfaceTokens
    }

    // Capture what the detector sees, for the per-compression report.
    const marker = compressionMarker(record, TOOLS)
    if (marker !== null && marker.phase === 'start') {
      totalMarkers += 1
      seen.push({ id: marker.id, source: marker.source, measured: occupancy(currentPressure()) })
    }
    if (marker !== null && marker.phase === 'end') {
      // A compression shrinks the surface, but only the START reading decides
      // whether it counts, so nothing to fold here.
    }

    watcher.handleSessionEvent(session, record)
  }

  // Let any in-flight hand-off settle before reporting.
  await new Promise((resolve) => setImmediate(resolve))
  const inspected = watcher.inspect(log.id)
  totalRelays += relays.length

  const qualifying = seen.filter((mark) => mark.measured !== null && mark.measured.percent >= thresholdPercent)
  console.log(`\n${log.id}`)
  console.log(`  records        ${records.length}`)
  console.log(`  window         ${contextWindow ?? '(none)'}`)
  console.log(`  compressions   ${seen.length} (${qualifying.length} at or above ${thresholdPercent}%)`)
  if (seen.length > 0) {
    const percents = seen.map((mark) => (mark.measured === null ? 'n/a' : `${mark.measured.percent}%`))
    console.log(`  occupancy      ${percents.join(' ')}`)
  }
  console.log(`  running count  ${inspected?.consecutive ?? 0}`)
  console.log(`  relays         ${relays.length}${relays.length > 0 ? ` at ${relays.map((r) => `${r.percent}%`).join(', ')}` : ''}`)
}

console.log(`\n${totalRecords} records, ${totalMarkers} compressions, ${totalRelays} relay(s) across ${logs.length} log(s)`)
if (totalMarkers === 0) {
  console.error('FAIL: no compression events recognised — the detector no longer matches this profile')
  process.exit(1)
}
