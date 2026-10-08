// e2e：/skills 面板必须展示内置（bundled）技能——此前过滤器只认
// skills/commands_DEPRECATED/plugin/mcp，bundled 被上游设计排除，
// 空磁盘技能目录时面板恒显示 "No skills found"。
// 修复：SkillsMenu 增加 bundled 过滤与 "Bundled skills" 分组（编译产物扩槽）。
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'verify-skills-menu-tmp')
// config 门禁：NODE_ENV=test 豁免 "Config accessed before allowed"，
// CLAUDE_CONFIG_DIR 指向沙箱避免读真实 ~/.doge（对齐 e2e-provider-form）。
process.env.NODE_ENV = 'test'
process.env.CLAUDE_CONFIG_DIR = TMP
process.env.CLAUDE_CODE_TMPDIR = TMP
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: 'e2e',
  BUILD_TIME: '',
  PACKAGE_URL: 'test',
  NATIVE_PACKAGE_URL: 'test',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: 'test',
}
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class FakeStdout extends Stream {
  frames: string[] = []
  columns = 120
  rows = 40
  isTTY = true
  write(chunk: string | Uint8Array): boolean {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }
}

class FakeStdin extends Stream {
  private pending: string[] = []
  isTTY = true
  isRaw = false
  setRawMode(enabled: boolean) {
    this.isRaw = enabled
    return this
  }
  setEncoding(_enc: string) { return this }
  resume() { return this }
  pause() { return this }
  ref() {}
  unref() {}
  read(_size?: number): string | null {
    return this.pending.shift() ?? null
  }
  pushKeys(keys: string) {
    this.pending.push(keys)
    this.emit('readable')
  }
}

const ESC = String.fromCharCode(27)
function stripAnsi(s: string): string {
  return s
    .replace(new RegExp(ESC + String.raw`\[(\d*)C`, 'g'), (_m: string, n: string) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(new RegExp(ESC + String.raw`\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(ESC + String.raw`\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`, 'g'), '')
    .replace(new RegExp(ESC + '[()][B0]', 'g'), '')
    .replace(new RegExp(ESC + '[>=<][0-9a-zA-Z]*', 'g'), '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

const { clearBundledSkills, getBundledSkills } = await import('../src/skills/bundledSkills.js')
const { initAnthropicSkills } = await import('../src/skills/bundled/anthropic/index.js')
clearBundledSkills()
initAnthropicSkills()
const bundledCommands = getBundledSkills()
if (bundledCommands.length !== 18) {
  console.error(`(FAIL) expected 18 bundled skills, got ${bundledCommands.length}`)
  process.exit(1)
}

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider } = await import('../src/state/AppState.js')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.js')
const { SkillsMenu } = await import('../src/components/skills/SkillsMenu.js')

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

function contentFrames(): string[] {
  return stdout.frames.filter(f => stripAnsi(f).replace(/\s/g, '').length > 20)
}
function lastText(): string {
  const frames = contentFrames()
  return stripAnsi(frames.at(-1) ?? '')
}

const instance = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(KeybindingSetup, null,
      React.createElement(SkillsMenu, {
        onExit: () => {},
        commands: bundledCommands,
      }))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const text = lastText()
check(text.length > 0, '面板有渲染输出')
check(text.includes('Bundled skills (内置)'), '分组标题标注 "Bundled skills (内置)"')
check(text.includes('· bundled'), 'bundled 条目带 "· bundled" 标签')
check(text.includes('.doge/skills/'), '底部常驻外置技能安装位置提示')
check(text.includes('(外置)'), '提示中标注外置')
check(text.includes('docx'), '列表包含 docx')
check(text.includes('xlsx'), '列表包含 xlsx')
check(text.includes('canvas-design'), '列表包含 canvas-design')
check(text.includes('python'), '列表包含 python')
check(text.includes('18 skills'), '副标题计数 18 skills')
check(!text.includes('No skills found'), '不再显示 No skills found')

instance.unmount()
await sleep(200)

// 场景二：内置 + 外置（项目磁盘技能）混排——外置组头须带 (外置) 标注与路径
const diskCommand = {
  type: 'prompt',
  name: 'my-own-skill',
  description: 'A user authored disk skill',
  loadedFrom: 'skills',
  source: 'projectSettings',
  userInvocable: true,
  hasUserSpecifiedDescription: true,
  contentLength: 0,
  progressMessage: 'running',
  getPromptForCommand: async () => [{ type: 'text', text: 'x' }],
}
stdout.frames.length = 0
const instance2 = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(KeybindingSetup, null,
      React.createElement(SkillsMenu, {
        onExit: () => {},
        commands: [...bundledCommands, diskCommand as never],
      }))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)
const text2 = lastText()
check(text2.includes('Bundled skills (内置)'), '混排：内置组头标注')
check(text2.includes('Project skills (外置)'), '混排：外置组头标注 "Project skills (外置)"')
check(text2.includes('my-own-skill'), '混排：外置技能列出')
check(text2.includes('· bundled'), '混排：内置条目仍带 bundled 标签')
check(!text2.includes('my-own-skill · bundled'), '混排：外置条目不带 bundled 标签')

instance2.unmount()
await sleep(200)
rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
