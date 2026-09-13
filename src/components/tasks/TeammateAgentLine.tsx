/**
 * TeammateAgentLine — unified-panel row for an in_process_teammate task.
 *
 * Visual twin of AgentLine in CoordinatorAgentStatus.tsx (main-/sub-agent-
 * rows) so teammates render in the same form: `sub-agent-<name>-<activity>`.
 * Differences from the local_agent row: the identity slot is the teammate's
 * person name (tinted with its swarm color) instead of a model id, the
 * play/pause icon follows isIdle, and shutdown/plan-approval states surface
 * as `[stopping]` / `[awaiting approval]` markers (mirrors the old spinner
 * tree indicators). Kept as plain source — the panel component is a React
 * Compiler artifact and only branches here.
 */

import figures from 'figures'
import * as React from 'react'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import { BLACK_CIRCLE, PAUSE_ICON, PLAY_ICON } from '../../constants/figures.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, wrapText } from '../../ink.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import type { Theme } from '../../utils/theme.js'
import { isTerminalStatus } from './taskStatusUtils.js'

function getAgentThemeColor(
  colorName: string | undefined,
): keyof Theme | undefined {
  if (!colorName) return undefined
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
  }
  return undefined
}

type TeammateAgentLineProps = {
  task: InProcessTeammateTaskState
  isSelected?: boolean
  isViewed?: boolean
  onClick?: () => void
}

export function TeammateAgentLine({
  task,
  isSelected,
  isViewed,
  onClick,
}: TeammateAgentLineProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)

  const isRunning = !isTerminalStatus(task.status)
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    isRunning
      ? Date.now() - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )
  const elapsed = formatDuration(elapsedMs)

  const tokenCount = task.progress?.tokenCount
  const lastActivity = task.progress?.lastActivity
  const arrow = lastActivity ? figures.arrowDown : figures.arrowUp
  const tokenText =
    tokenCount !== undefined && tokenCount > 0
      ? ` · ${arrow} ${formatNumber(tokenCount)} tokens`
      : ''

  const queuedCount = task.pendingUserMessages.length
  const queuedText = queuedCount > 0 ? ` · ${queuedCount} queued` : ''

  // Precedence: AI summary > static description (same as local_agent rows).
  let displayDescription = task.progress?.summary || task.description
  if (task.shutdownRequested) displayDescription += ' [stopping]'
  else if (task.awaitingPlanApproval) displayDescription += ' [awaiting approval]'

  const highlighted = isSelected || hover
  const prefix = highlighted ? figures.pointer + ' ' : '  '
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle
  const dim = !highlighted && !isViewed
  // Icon mirrors the old spinner tree: active work ▶, idle or shutting down ⏸.
  const sep = isRunning && !task.isIdle && !task.shutdownRequested ? PLAY_ICON : PAUSE_ICON

  // Row label format: `sub-agent-<teammateName>-<task>` — the person name is
  // the steering handle (kept out of truncation, undimmed, tinted with the
  // swarm color so it matches the view banner).
  const name = `sub-agent-${task.identity.agentName}`
  const namePart = `${name}-`
  const hintPart =
    isSelected && !isViewed ? ` · x to ${isRunning ? 'stop' : 'clear'}` : ''
  const suffixPart = ` ${sep} ${elapsed}${tokenText}${queuedText}${hintPart}`
  const availableForDesc =
    columns -
    stringWidth(prefix) -
    stringWidth(`${bullet} `) -
    stringWidth(namePart) -
    stringWidth(suffixPart)
  const truncated = wrapText(
    displayDescription,
    Math.max(0, availableForDesc),
    'truncate-end',
  )
  const themeColor = getAgentThemeColor(task.identity.color)

  const line = (
    <Text dimColor={dim} bold={isViewed}>
      {prefix}
      {bullet}{' '}
      <Text dimColor={false} bold={true} color={themeColor}>
        {name}
      </Text>
      {'-'}
      {truncated} {sep} {elapsed}
      {tokenText}
      {queuedCount > 0 && <Text color="warning">{queuedText}</Text>}
      {hintPart && <Text dimColor>{hintPart}</Text>}
    </Text>
  )

  if (!onClick) return line
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {line}
    </Box>
  )
}
