export { imRemote, wrapImRemoteToolCounter } from './client.js'
export { runImRemoteDaemon } from './daemon.js'
export {
  generatePairCode,
  imRemoteConfigPath,
  imRemoteConfigReady,
  imRemoteWebConfigPath,
  imRemoteWebReady,
  loadImRemoteConfig,
  loadImRemoteWebConfig,
  normalizeImRemoteConfig,
  normalizeImRemoteWebConfig,
  PAIR_CODE_TTL_MS,
  saveImRemoteConfig,
  saveImRemoteWebConfig,
} from './config.js'
export { webUrlCandidates } from './adapters/webChat.js'
export type {
  ImAdapter,
  ImInboundMessage,
  ImOption,
  ImPlatform,
  ImRemoteClientFrame,
  ImRemoteConfig,
  ImRemoteDaemonFrame,
  ImRemoteMonitorFrame,
  ImRemoteSessionKind,
  ImRemoteWebConfig,
} from './types.js'
