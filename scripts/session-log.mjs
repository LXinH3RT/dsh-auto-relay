// Read a DSH session log (`session.v*.jsonl.zstd`).
//
// The file is a CONCATENATION of independent zstd frames, one per append batch
// (a long session has thousands of them). Node's one-shot
// `zlib.zstdDecompressSync` stops after the first frame, and so does a single
// `zlib.createZstdDecompress()` stream — both yield only the header line. A
// frame-by-frame loop is therefore mandatory to read a whole log.
//
// Read-only. Usage:
//   ELECTRON_RUN_AS_NODE=1 "<electron exe>" scripts/session-log.mjs <session-id-prefix> [--types]

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const prefix = process.argv[2] ?? ''
const typesOnly = process.argv.includes('--types')

/** Every `session.v*.jsonl.zstd` under the sessions root, newest first. */
export function findLogs(root = SESSIONS) {
    const found = []
    const walk = (dir, depth) => {
        if (depth > 4) return
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full, depth + 1)
            else if (/^session\.v\d+\.jsonl\.zstd$/u.test(entry.name)) {
                try {
                    const stat = fs.statSync(full)
                    found.push({ path: full, id: path.basename(dir), at: stat.mtimeMs, size: stat.size })
                } catch {
                    // A log that vanished between listing and stat is not an error here.
                }
            }
        }
    }
    walk(root, 0)
    found.sort((a, b) => b.at - a.at)
    return found
}

/**
 * Offsets of every candidate zstd frame start. The magic can occur by chance
 * inside compressed bytes, so callers must treat each candidate as a guess and
 * fall back to the next candidate when decompression fails.
 */
function candidateStarts(buffer) {
    const starts = []
    let from = 0
    for (;;) {
        const at = buffer.indexOf(ZSTD_MAGIC, from)
        if (at === -1) return starts
        starts.push(at)
        from = at + 1
    }
}

/**
 * Decompress a concatenated-frame log into one Buffer.
 *
 * Each candidate frame start is tried against the byte range up to the next
 * few candidates: a genuine frame decodes, a chance occurrence of the magic
 * does not, so widening the range repairs an over-eager split.
 */
export function inflateFrames(buffer) {
    const starts = candidateStarts(buffer)
    const parts = []
    let index = 0
    while (index < starts.length) {
        const start = starts[index]
        let decoded = null
        let consumed = 0
        for (let next = index + 1; next <= starts.length; next += 1) {
            const end = next < starts.length ? starts[next] : buffer.length
            try {
                decoded = zlib.zstdDecompressSync(buffer.subarray(start, end))
                consumed = next - index
                break
            } catch {
                // Not a frame boundary at `end`; widen the slice.
            }
        }
        if (decoded === null) {
            // No boundary works from here: the tail is unreadable (a torn write).
            break
        }
        parts.push(decoded)
        index += consumed
    }
    return Buffer.concat(parts)
}

/** Decompress every frame of one log and return its parsed lines. */
export function readLog(file) {
    const inflated = inflateFrames(fs.readFileSync(file))
    return inflated.toString('utf8').split('\n').filter((line) => line !== '').map((line) => {
        try {
            return JSON.parse(line)
        } catch {
            return { type: '(unparsed)', raw: line.slice(0, 200) }
        }
    })
}

if (process.argv[1]?.endsWith('session-log.mjs')) {
    const file = prefix === ''
        ? findLogs()[0]
        : findLogs().find((candidate) => candidate.id.includes(prefix))
    if (file === undefined) {
        console.log(prefix === '' ? 'no session logs found' : `no log matching ${prefix}`)
        process.exit(0)
    }
    const events = readLog(file.path)
    console.log(`${file.id}  ${(file.size / 1024 / 1024).toFixed(1)}MB  ${events.length} records`)
    if (typesOnly) {
        const counts = new Map()
        const samples = new Map()
        for (const event of events) {
            const type = event?.type ?? '(no type)'
            counts.set(type, (counts.get(type) ?? 0) + 1)
            if (!samples.has(type)) samples.set(type, event)
        }
        console.log('')
        for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(6)}  ${type}`)
        }
        console.log('')
        console.log('compression-adjacent payloads:')
        for (const [type, event] of samples) {
            if (!/compact|compress|summar|prune|bili|relay|archive|surface/u.test(type)) continue
            console.log(`  --- ${type} (${counts.get(type)}×): ${JSON.stringify(event.data).slice(0, 500)}`)
        }
    }
}
