// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isWorkflowStepChild } from '../../tools/WorkflowTool/stepChildEnv.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * Whether background memory consolidation should run. User setting
 * (autoDreamEnabled in settings.json) overrides the GrowthBook default
 * when explicitly set; otherwise falls through to tengu_onyx_plover.
 */
export function isAutoDreamEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    if (isWorkflowStepChild()) return false
    // App sessions send an explicit preference, including for the off state.
    const hostSetting = process.env.DOGE_HEADLESS_AUTO_DREAM
    if (hostSetting === '0' || hostSetting === '1') return hostSetting === '1'
  }
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: unknown } | null>(
    'tengu_onyx_plover',
    null,
  )
  return gb?.enabled === true
}
