// Enumerate the event types a real DSH session log actually stores, so the
// watchdog folds vocabulary that this Host really produces rather than the
// vocabulary the stock implementation would produce.
//
// Read-only. Usage:
//   ELECTRON_RUN_AS_NODE=1 "<electron exe>" scripts/verify-events.mjs <session-id-prefix>

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
const WANTED = process.argv[2] ?? ''

/** Every `session.v*.jsonl.zstd` under the sessions root, newest first. */
function logs(root) {
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
                    found.push({ path: full, at: stat.mtimeMs, size: stat.size })
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

const selected = WANTED === ''
    ? logs(SESSIONS).slice(0, 3)
    : logs(SESSIONS).filter((file) => path.basename(path.dirname(file.path)).includes(WANTED))

if (selected.length === 0) {
    console.log('no matching session log')
    process.exit(0)
}

for (const file of selected) {
    const id = path.basename(path.dirname(file.path))
    let text
    try {
        text = zlib.zstdDecompressSync(fs.readFileSync(file.path)).toString('utf8')
    } catch (error) {
        console.log(`${id}: unreadable (${error.message})`)
        continue
    }
    const counts = new Map()
    const firstSeen = new Map()
    let total = 0
    let unparsed = 0
    for (const line of text.split('\n')) {
        if (line === '') continue
        total += 1
        let event
        try {
            event = JSON.parse(line)
        } catch {
            unparsed += 1
            continue
        }
        const type = event?.type ?? '(no type)'
        counts.set(type, (counts.get(type) ?? 0) + 1)
        if (!firstSeen.has(type)) firstSeen.set(type, event)
    }
    console.log('')
    console.log(`=== ${id}  ${(file.size / 1024 / 1024).toFixed(1)}MB  ${total} lines, ${unparsed} unparsed ===`)
    for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(6)}  ${type}`)
    }
    // Show the payload keys of anything compression-adjacent, whatever it is called.
    for (const [type, event] of firstSeen) {
        if (!/compact|compress|summar|prune|bili|relay|archive/u.test(type)) continue
        console.log(`  --- ${type}: ${JSON.stringify(event.data).slice(0, 400)}`)
    }
}
