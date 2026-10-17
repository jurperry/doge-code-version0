// 临时功能验证（验证后删除）：/model 列表在双 provider 场景下的输出。
// 场景：终端1 激活 deepseek（带 sonnet/haiku 档），存储里另有 glm provider；
// 另一终端遗留的全局 tierModels 快照指向 glm 的模型 —— 不应污染本终端列表。
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), 'test', 'verify-model-options-config')
process.env.CLAUDE_CONFIG_DIR = TMP
// getModelOptions → getGlobalConfig 受 config 门禁（config.ts），test 环境豁免。
process.env.NODE_ENV = 'test'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

writeFileSync(join(TMP, '.credentials.json'), JSON.stringify({
  customApiEndpoint: {
    model: 'deepseek-v4-pro[1m]',
    savedModels: ['deepseek-v4-pro[1m]', 'glm-5.3'],
    // 另一终端遗留的全局快照（旧版本写入）—— 必须被忽略
    activeTier: 'haiku',
    tierModels: { opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3-flash' },
    modelProfiles: [
      {
        model: 'deepseek-v4-pro[1m]',
        providerName: 'deepseek官方',
        provider: 'openai',
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-ds',
        authTokenType: 'DOGE_API_KEY',
        defaultSonnetModel: 'deepseek-v4-pro',
        defaultHaikuModel: 'deepseek-v4-flash',
      },
      {
        model: 'glm-5.3',
        providerName: 'glm官方',
        provider: 'anthropic',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'sk-glm',
        authTokenType: 'ANTHROPIC_AUTH_TOKEN',
      },
    ],
  },
}))
writeFileSync(join(TMP, '.claude.json'), JSON.stringify({
  customApiEndpoint: {
    model: 'deepseek-v4-pro[1m]',
    savedModels: ['deepseek-v4-pro[1m]', 'glm-5.3'],
  },
}))

// 终端1 的会话 env：激活 deepseek（模拟 start script / applied profile）
process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro[1m]'
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
process.env.DOGE_API_KEY = 'sk-ds'
process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL

const { restoreTierStateFromStorage } = await import('../src/utils/model/restoreTierState.js')
restoreTierStateFromStorage()

const { getModelOptions } = await import('../src/utils/model/modelOptions.js')
const { getModelProfile } = await import('../src/utils/customApiStorage.js')
const options = getModelOptions(false)

console.log('=== /model 列表 ===')
for (const opt of options) {
  console.log(`${String(opt.label).padEnd(32)} | ${opt.description}`)
}

const failures: string[] = []
const check = (cond: boolean, msg: string) => { if (!cond) failures.push(msg) }

const isModel = (value: string | null, model: string | null) => value === model || (value !== null && getModelProfile(value)?.model === model)
const desc = (v: string | null) => options.find(o => isModel(o.value, v))?.description ?? '(missing)'
const glmRow = options.find(o => isModel(o.value, 'glm-5.3'))
check(!!glmRow, 'glm-5.3 应有一条 provider 行')
check(desc('glm-5.3') === 'Custom model(glm官方)', `glm 行描述应为 Custom model(glm官方)，实际: ${desc('glm-5.3')}`)
check(options.some(o => isModel(o.value, 'deepseek-v4-pro[1m]') && String(o.description).includes('Custom model(deepseek官方)')), '主模型行应带 Custom model(deepseek官方)')
check(String(desc('opus')).includes('deepseek-v4-pro'), `Opus 档未配置应回落主模型，实际: ${desc('opus')}`)
check(String(desc('haiku')).includes('deepseek-v4-flash') && !String(desc('haiku')).includes('glm'), `Haiku 档应显示本 provider 的 deepseek-v4-flash，实际: ${desc('haiku')}`)
check(!options.some(o => o.value === 'glm-5.3-flash'), '其他 provider 的档位模型不应单独成行')

// 清理：删除测试用配置目录
rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('\nFAILURES:')
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
