// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isWorkflowStepChild } from '../../tools/WorkflowTool/stepChildEnv.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Whether background memory consolidation should run. Desktop and CLI
 * share settings.json and the same off default.
 */
export function isAutoDreamEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    if (isWorkflowStepChild()) return false
    // App sessions send an explicit preference, including for the off state.
    const hostSetting = process.env.DOGE_HEADLESS_AUTO_DREAM
    if (hostSetting === '0' || hostSetting === '1') return hostSetting === '1'
  }
  return getInitialSettings().autoDreamEnabled === true
}
