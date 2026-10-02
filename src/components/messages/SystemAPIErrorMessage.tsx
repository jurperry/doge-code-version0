import * as React from 'react'
import { useEffect, useState } from 'react'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { Box, Text } from 'src/ink.js'
import { formatAPIError } from 'src/services/api/errorUtils.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'

const MAX_API_ERROR_CHARS = 1000
type Props = { message: SystemAPIErrorMessage; verbose: boolean }

export function SystemAPIErrorMessage({ message, verbose }: Props): React.ReactNode {
  const { retryAttempt, error, retryInMs, maxRetries } = message
  const [countdownMs, setCountdownMs] = useState(0)
  useEffect(() => setCountdownMs(0), [message.uuid])
  useInterval(() => setCountdownMs(ms => ms + 1000), countdownMs >= retryInMs ? null : 1000)
  const retryInSeconds = Math.max(0, Math.ceil((retryInMs - countdownMs) / 1000))
  const formatted = formatAPIError(error)
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS
  const network = error instanceof APIConnectionError || error.status === 408
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{truncated ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…' : formatted}</Text>
        {truncated && <CtrlOToExpand />}
        <Text dimColor>
          {network ? '🛜 断线重连中' : '服务重试中'}，第 {retryAttempt}/{maxRetries} 轮次… {retryInSeconds > 0 ? `${retryInSeconds} 秒后重试` : '正在重试'}
        </Text>
      </Box>
    </MessageResponse>
  )
}
