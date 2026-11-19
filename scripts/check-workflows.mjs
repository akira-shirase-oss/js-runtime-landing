// Checks .github/ against GitHub's secure-use guidance, so a later edit can't quietly weaken CI:
//
//   node scripts/check-workflows.mjs [repo-dir]
//
// - every workflow sets a top-level `permissions:` and nothing asks for write access
// - every `uses:` is pinned to a full 40-character commit SHA (or is a local action)
// - no `pull_request_target` or `workflow_run` trigger, no self-hosted runner
// - no `${{ … }}` expression inside a `run:` script (pass values through `env:` instead)
// - every actions/checkout step sets `persist-credentials: false`
// - Dependabot updates both npm and github-actions
//
// Line-based on purpose: no YAML dependency, and the rules are about text that must never appear.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const dir = join(repo, '.github', 'workflows')
const failures = []
const fail = (file, line, message) => failures.push(`${file}${line ? `:${line}` : ''}: ${message}`)

const workflows = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : []
if (workflows.length === 0) fail('.github/workflows', 0, 'no workflow, so nothing runs the checks')

const STEP = /^\s*- (name|uses|run|id|if|with|env|shell|working-directory|timeout-minutes|continue-on-error):/

for (const name of workflows) {
  const file = `.github/workflows/${name}`
  const lines = readFileSync(join(dir, name), 'utf8').split(/\r?\n/)
  const indent = (l) => l.length - l.trimStart().length

  if (!lines.some((l) => /^permissions:/.test(l))) fail(file, 0, 'no top-level permissions: block (want contents: read)')

  let script = null // the indentation of the `run:` key whose block we are inside
  lines.forEach((line, i) => {
    const n = i + 1
    const code = line.replace(/\s+#.*$/, '')
    if (script !== null) {
      if (line.trim() === '' || indent(line) > script) {
        if (line.includes('${{')) fail(file, n, 'an expression inside a run: script; pass it through env:')
        return
      }
      script = null
    }
    const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(code)
    if (run) {
      if (/^[|>][-+0-9]*$/.test(run[2].trim())) script = indent(line) + (line.trimStart().startsWith('- ') ? 2 : 0)
      else if (run[2].includes('${{')) fail(file, n, 'an expression inside a run: command; pass it through env:')
    }
    if (/write-all|:\s*write\b/.test(code)) fail(file, n, `asks for write access: ${line.trim()}`)
    if (/\b(pull_request_target|workflow_run)\b/.test(code)) fail(file, n, `a dangerous trigger: ${line.trim()}`)
    if (/runs-on:.*self-hosted/.test(code)) fail(file, n, 'a self-hosted runner on a public repo')
    const uses = /^\s*(?:- )?uses:\s*['"]?([^'"\s#]+)/.exec(line)
    if (uses && !uses[1].startsWith('./') && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(uses[1]) && !/^docker:\/\/.+@sha256:[0-9a-f]{64}$/.test(uses[1])) {
      fail(file, n, `${uses[1]} is not pinned to a full commit SHA`)
    }
  })

  // Steps start at `- name:`, `- uses:` and so on; each checkout step must drop its credentials.
  const starts = lines.flatMap((l, i) => (STEP.test(l) ? [i] : []))
  starts.forEach((start, k) => {
    const step = lines.slice(start, starts[k + 1] ?? lines.length).join('\n')
    if (/uses:\s*['"]?actions\/checkout@/.test(step) && !/persist-credentials:\s*false/.test(step)) {
      fail(file, start + 1, 'actions/checkout without persist-credentials: false')
    }
  })
}

const dependabot = join(repo, '.github', 'dependabot.yml')
if (!existsSync(dependabot)) fail('.github/dependabot.yml', 0, 'missing, so pinned actions and the lockfile never get updates')
else {
  const text = readFileSync(dependabot, 'utf8')
  for (const ecosystem of ['npm', 'github-actions']) {
    if (!new RegExp(`package-ecosystem:\\s*['"]?${ecosystem}['"]?\\s*$`, 'm').test(text)) {
      fail('.github/dependabot.yml', 0, `no ${ecosystem} updates`)
    }
  }
}

if (failures.length) {
  console.error(`check-workflows: ${failures.length} failure(s)\n`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`check-workflows: ${workflows.length} workflow(s) and dependabot.yml ok`)
