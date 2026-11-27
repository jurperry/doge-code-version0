import React, { createContext, useContext, useEffect, useState } from 'react'
import { Text } from '../../../ink.js'

export const QuestionDeadlineContext = createContext<number | undefined>(undefined)

/** Display only; the permission handler owns the actual deadline. */
export function AutoQuestionCountdown() {
  const deadlineMs = useContext(QuestionDeadlineContext)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (deadlineMs === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadlineMs])
  if (deadlineMs === undefined) return null
  const seconds = Math.max(0, Math.ceil((deadlineMs - now) / 1000))
  return <Text dimColor>五分钟未提交将采用推荐方案 · 剩余 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</Text>
}
