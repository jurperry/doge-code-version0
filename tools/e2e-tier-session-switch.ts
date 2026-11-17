// 档位切换一律会话级，默认档采用当前连接的 sonnet。
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), 'test', 'verify-tier-switch-config')
process.env.CLAUDE_CONFIG_DIR = TMP
// global-default 路径会经 clearLegacyTierState → saveGlobalConfig，
// 该写入口在 enableConfigs() 之前被门禁（config.ts），test 环境豁免。
process.env.NODE_ENV = 'test'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const initialStorage = {
  customApiEndpoint: {
    model: 'deepseek-v4-pro[1m]',
    savedModels: ['deepseek-v4-pro[1m]', 'glm-5.3'],
    // 旧版本遗留的全局档位状态 —— 切换 default（global）时应被清掉
    activeTier: 'haiku',
    tierModels: { haiku: 'deepseek-v4-flash' },
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
    ],
  },
}
writeFileSync(join(TMP, '.credentials.json'), JSON.stringify(initialStorage))
writeFileSync(join(TMP, '.claude.json'), JSON.stringify({
  customApiEndpoint: { model: 'deepseek-v4-pro[1m]', savedModels: ['deepseek-v4-pro[1m]', 'glm-5.3'] },
}))

process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro[1m]'
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'

const { switchTierBound, resolveSessionDefaultModel } = await import('../src/utils/model/switchModelProfile.bindings.js')
const { defaultCatalogSelection, readModelCatalog } = await import('../src/utils/model/modelCatalog.js')

let state: { mainLoopModel: string | null, mainLoopModelForSession: string | null } = {
  mainLoopModel: 'deepseek-v4-pro[1m]',
  mainLoopModelForSession: null,
}
const setAppState = (updater: (prev: any) => any) => { state = updater(state) }

const readStored = () => {
  const p = join(TMP, '.credentials.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

const failures: string[] = []
const check = (cond: boolean, msg: string) => { if (!cond) failures.push(msg) }

// 1) 会话内切 haiku 档：session 槽位 = deepseek-v4-flash，磁盘不动
switchTierBound('haiku', { syncToDisk: () => { failures.push('session 档位切换不应落盘') }, setAppState })
check(state.mainLoopModelForSession === 'deepseek-v4-flash', `haiku 档应进 session 槽位，实际: ${state.mainLoopModelForSession}`)
check(state.mainLoopModel === 'deepseek-v4-pro[1m]', '主模型槽位不应被改写')

// 2) 会话内选 Default：= sonnet 档（deepseek-v4-pro），而非启动基线/别名
switchTierBound(null, { syncToDisk: () => { failures.push('session default 不应落盘') }, setAppState })
check(state.mainLoopModelForSession === 'deepseek-v4-pro', `Default 应解析为 sonnet 档 deepseek-v4-pro，实际: ${state.mainLoopModelForSession}`)

// 3) global 语义下切 opus 档：仍只进 session 槽位，磁盘不动
switchTierBound('opus', { syncToDisk: () => { failures.push('global 档位切换也不应落盘') }, setAppState, sessionScoped: false })
check(state.mainLoopModelForSession === 'deepseek-v4-pro[1m]', `未配置的 opus 档回落主模型，实际: ${state.mainLoopModelForSession}`)

// 4) global default：回到存储主模型，并清掉遗留 activeTier/tierModels
switchTierBound(null, { syncToDisk: () => { failures.push('custom 用户 default 不应调 syncToDisk') }, setAppState, sessionScoped: false })
check(state.mainLoopModel === 'deepseek-v4-pro[1m]' && state.mainLoopModelForSession === null, 'global default 应回到存储主模型并清 session')
check(readStored().customApiEndpoint === undefined, '迁移应清除整个旧模型配置')
const catalog = readModelCatalog()
check(defaultCatalogSelection(catalog).model?.upstreamModel === 'deepseek-v4-pro[1m]', '目录默认主模型不应变化')
check(catalog?.connections[0]?.roles?.haiku !== undefined, '旧配置中显式 Haiku 角色应迁移到目录')

// 5) 用户回归场景：磁盘基线=deepseek，会话已切到 kimi（env 描述激活 provider，
//    kimi 未配 sonnet 档 → applyModelProfile 已删 tier env）。/model 选 Default
//    的提示消息与实际提交都必须跟随激活 provider（kimi 主模型），
//    绝不能把磁盘基线的 sonnet 档模型名发给 kimi 的 endpoint。
process.env.ANTHROPIC_MODEL = 'kimi-k3[1m]'
delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
check(resolveSessionDefaultModel() === 'kimi-k3[1m]', `Default 应跟随激活 provider 主模型 kimi-k3[1m]（而非基线 sonnet 档），实际: ${resolveSessionDefaultModel()}`)
switchTierBound(null, { syncToDisk: () => { failures.push('session default 不应落盘') }, setAppState })
check(state.mainLoopModelForSession === 'kimi-k3[1m]', `Default 提交值应为 kimi-k3[1m]，实际: ${state.mainLoopModelForSession}`)

// 6) 激活 provider 配置了 sonnet 档：Default 解析该档位模型
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k3'
check(resolveSessionDefaultModel() === 'kimi-k3', `Default 应为 kimi 的 sonnet 档 kimi-k3，实际: ${resolveSessionDefaultModel()}`)

rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAILURES:')
  for (const f of failures) console.error(' -', f)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
