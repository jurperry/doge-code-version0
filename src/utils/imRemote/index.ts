export { imRemote, wrapImRemoteToolCounter } from './client.js'
export { runImRemoteDaemon } from './daemon.js'
export {
  generatePairCode,
  imRemoteConfigPath,
  imRemoteConfigReady,
  loadImRemoteConfig,
  normalizeImRemoteConfig,
  PAIR_CODE_TTL_MS,
  saveImRemoteConfig,
} from './config.js'
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
} from './types.js'
