import { useEffect, useRef } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  effortModelKey,
  getRememberedEffort,
} from '../utils/effortMemory.js'
import { getInitialEffortSetting } from '../utils/effort.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'

/**
 * Restore each model's own effort level when the session model changes.
 *
 * Write sites store the chosen level in `effortByModel`; this hook only
 * restores the incoming model's remembered level. Missing memory falls back to
 * the persisted global effortLevel so a settings default does not silently
 * disappear after switching models.
 *
 * Saving on switch is intentionally NOT done here: `effortValue` may already
 * belong to the new model by the time the effect runs, so saving here could
 * attribute the new level to the old model.
 */
export function useEffortModelMemory(): void {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const setAppState = useSetAppState()

  const raw =
    mainLoopModelForSession ?? mainLoopModel ?? getDefaultMainLoopModelSetting()
  const resolvedModel = parseUserSpecifiedModel(raw)
  const modelKey = effortModelKey(resolvedModel)
  const previousModelKey = useRef<string | undefined>(modelKey)

  useEffect(() => {
    if (previousModelKey.current === undefined) {
      previousModelKey.current = modelKey
      return
    }
    if (modelKey === undefined || modelKey === previousModelKey.current) {
      previousModelKey.current = modelKey
      return
    }
    previousModelKey.current = modelKey
    setAppState(prev => {
      const remembered = getRememberedEffort(prev.effortByModel, resolvedModel)
      const next =
        remembered === undefined
          ? getInitialEffortSetting()
          : (remembered ?? undefined)
      if (next === prev.effortValue) return prev
      return { ...prev, effortValue: next }
    })
  }, [modelKey, resolvedModel, setAppState])
}
