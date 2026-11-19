// Production-dependency audit. Fails on any advisory at moderate severity or above, except one listed in
// audit-allow.json with a reason and an expiry date — and an exception fails the audit once its date has passed,
// so nothing stays waved through by accident.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const allow = JSON.parse(readFileSync(new URL('../audit-allow.json', import.meta.url), 'utf8'))
const levels = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }
const today = new Date().toISOString().slice(0, 10)

let out
try {
  out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 })
} catch (error) {
  // npm audit exits non-zero whenever it finds something; its JSON report is still on stdout.
  out = error.stdout
}
if (!out) {
  console.error('audit: npm audit produced no report (is the registry reachable?)')
  process.exit(1)
}

const found = new Map()
for (const entry of Object.values(JSON.parse(out).vulnerabilities ?? {})) {
  for (const via of entry.via) {
    if (typeof via !== 'object' || levels[via.severity] < levels.moderate) continue
    const id = via.url.split('/').pop()
    found.set(id, { pkg: via.name, severity: via.severity, title: via.title })
  }
}

let failed = false
for (const [id, advisory] of found) {
  const exception = allow[id]
  if (!exception) {
    console.error(`audit: ${advisory.severity} ${id} in ${advisory.pkg}: ${advisory.title}`)
    failed = true
  } else if (exception.until < today) {
    console.error(`audit: the exception for ${id} expired on ${exception.until}; review it`)
    failed = true
  } else {
    console.log(`audit: ${id} in ${advisory.pkg} allowed until ${exception.until}: ${exception.reason}`)
  }
}
for (const id of Object.keys(allow)) {
  if (!found.has(id)) console.log(`audit: the exception for ${id} is no longer needed; remove it`)
}
if (failed) process.exit(1)
console.log(`audit ok: ${found.size} advisory(ies) at moderate or above, each with a current exception`)
