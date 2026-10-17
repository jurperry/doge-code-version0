/** Run each unit-test file in a clean process to isolate global settings/mocks. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const testRoot = join(root, 'test')
await mkdir(testRoot, { recursive: true })
const sandbox = await mkdtemp(join(testRoot, 'network-isolated-suite-'))
const files = [...new Bun.Glob('{src,tools}/**/*.test.{ts,tsx}').scanSync({ cwd: root })].sort()
const results: Array<{ file: string; exit: number; pass: number; fail: number }> = []
try {
  for (const file of files) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|DOGE_|CLAUDE_CODE_)/.test(key)) delete env[key]
    env.CLAUDE_CONFIG_DIR = join(sandbox, String(results.length))
    env.CLAUDE_CODE_TEST_FIXTURES_ROOT = env.CLAUDE_CONFIG_DIR
    env.NODE_ENV = 'test'
    // These existing feature tests enter bare mode and enumerate tools/models.
    // They need a local dummy key; credential recovery tests must stay key-free.
    if (['src/commands/agent-teams/index.test.ts', 'src/utils/agentSwarmsEnabled.test.ts', 'src/utils/processUserInput/processUserInput.agentTeams.test.ts'].includes(file.replaceAll('\\', '/'))) env.DOGE_API_KEY = 'local-unit-test'
    const child = Bun.spawn([process.execPath, 'test', file], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const output = stdout + stderr
    const result = { file, exit, pass: Number(output.match(/\b(\d+) pass\b/)?.[1] ?? 0), fail: Number(output.match(/\b(\d+) fail\b/)?.[1] ?? 0) }
    results.push(result)
    console.log(`${exit === 0 ? 'PASS' : 'FAIL'} ${file} ${result.pass}/${result.pass + result.fail}`)
    if (exit !== 0) await writeFile(join(testRoot, 'network-isolated-' + file.replaceAll(/[\\/:]/g, '-') + '.log'), output)
  }
  await writeFile(join(testRoot, 'network-isolated-results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ files: results.length, pass: results.reduce((n, r) => n + r.pass, 0), fail: results.reduce((n, r) => n + r.fail, 0), failedFiles: results.filter(r => r.exit !== 0).map(r => r.file) }))
} finally { await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
process.exitCode = results.some(r => r.exit !== 0) ? 1 : 0
