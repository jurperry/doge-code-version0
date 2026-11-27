import { resolveProfileReference } from '../../utils/model/profileIdentity.js'
/**
 * Provider-profile lookup for workflow steps (CLI 2.1.282).
 * Kept separate from engine.ts so command generation stays a light import
 * (engine pulls the whole runAgent chain, which circularly imports
 * commands.ts — the exact cycle the upstream lazy-require pattern avoided).
 */

import { getGlobalConfig } from '../../utils/config.js'
import {
  type ModelProfile,
  readCustomApiStorage,
} from '../../utils/customApiStorage.js'

/** All model profiles from both storage sources (same aggregation as P6). */
export function collectWorkflowProfiles(): ModelProfile[] {
  const global = getGlobalConfig().customApiEndpoint?.modelProfiles ?? []
  const local = readCustomApiStorage().modelProfiles ?? []
  const seen = new Set<string>()
  const out: ModelProfile[] = []
  for (const p of [...local, ...global]) {
    if (!p || typeof p.model !== 'string') continue
    const key = `${p.providerName ?? ''}|${p.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** Find a profile by providerName (primary) or exact model id (fallback). */
export function findWorkflowProfile(name: string): ModelProfile | undefined {
  const profiles = collectWorkflowProfiles()
  return (
    resolveProfileReference(profiles, name) ??
    profiles.find(p => p.providerName === name) ??
    profiles.find(p => p.model === name)
  )
}
