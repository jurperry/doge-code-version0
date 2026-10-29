import * as React from 'react'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { Box } from '../ink.js'
import { CondensedLogo } from './LogoV2/CondensedLogo.js'
import { LogoV2 } from './LogoV2/LogoV2.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'
import { StatusNotices } from './StatusNotices.js'

type Props = {
  agentDefinitions?: AgentDefinitionsResult
  /** Use the compact welcome layout when vertical space is limited. */
  compact?: boolean
}

// Keep this subtree stable across message updates. In the legacy scrollback
// layout it is the first sibling before all MessageRows; in fullscreen it is
// pinned above the ScrollBox. Memoizing prevents either layout from repainting
// the message tree because only the conversation changed.
export const LogoHeader = React.memo(function LogoHeader({ agentDefinitions, compact = false }: Props) {
  return (
    <OffscreenFreeze>
      <Box flexDirection="column" gap={1}>
        {compact ? <CondensedLogo /> : <LogoV2 />}
        <React.Suspense fallback={null}>
          <StatusNotices agentDefinitions={agentDefinitions} />
        </React.Suspense>
      </Box>
    </OffscreenFreeze>
  )
})
