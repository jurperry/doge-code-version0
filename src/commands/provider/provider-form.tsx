import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { useSetAppState } from '../../state/AppState.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'
import {
  buildModelProfile,
  defaultProviderSaveDeps,
  maskSecret,
  saveAndActivateProvider,
  validateProviderForm,
  type ProviderFormValues,
  type ProviderFormat,
  type AuthTokenType,
} from './provider-storage.js'

type FormStep = 'provider' | 'baseURL' | 'apiKey' | 'authTokenType' | 'model' | 'opus' | 'sonnet' | 'haiku' | 'review'

const STEP_ORDER: FormStep[] = ['provider', 'baseURL', 'apiKey', 'authTokenType', 'model', 'opus', 'sonnet', 'haiku', 'review']

const STEP_META: Record<Exclude<FormStep, 'review'>, { title: string; hint: string }> = {
  provider: {
    title: 'API format',
    hint: 'Protocol used at the API boundary. anthropic = /v1/messages, openai = /v1/chat/completions, responses = /v1/responses.',
  },
  baseURL: {
    title: 'Base URL',
    hint: 'API endpoint, e.g. https://api.deepseek.com. Leave empty to use the official Anthropic endpoint.',
  },
  apiKey: {
    title: 'API key',
    hint: 'Stored locally in ~/.doge and sent with every request.',
  },
  authTokenType: {
    title: 'Key type',
    hint: 'How the key is sent. DOGE_API_KEY → x-api-key header (default); ANTHROPIC_AUTH_TOKEN → Authorization: Bearer header. Pick Bearer if your gateway only accepts token auth.',
  },
  model: {
    title: 'Main model',
    hint: 'Model ID for the main loop, e.g. deepseek-v4-pro. A [1m]/[2m] suffix widens the context window.',
  },
  opus: {
    title: 'Opus model',
    hint: 'Optional. Model for Opus-tier agents. Leave empty to inherit the main model.',
  },
  sonnet: {
    title: 'Sonnet model',
    hint: 'Optional. Model for Sonnet-tier agents. Leave empty to inherit the main model.',
  },
  haiku: {
    title: 'Haiku model',
    hint: 'Optional. Model for Haiku-tier agents. Leave empty to inherit the main model.',
  },
}

const PROVIDER_OPTIONS: { value: ProviderFormat; label: string; description: string }[] = [
  { value: 'anthropic', label: 'anthropic', description: 'Anthropic Messages format (/v1/messages)' },
  { value: 'openai', label: 'openai', description: 'OpenAI Chat Completions (/v1/chat/completions)' },
  { value: 'responses', label: 'responses', description: 'OpenAI Responses (/v1/responses)' },
]

const AUTH_TOKEN_TYPE_OPTIONS: { value: AuthTokenType; label: string; description: string }[] = [
  { value: 'DOGE_API_KEY', label: 'DOGE_API_KEY (x-api-key)', description: 'Sent as the x-api-key header — default, works for most providers' },
  { value: 'ANTHROPIC_AUTH_TOKEN', label: 'ANTHROPIC_AUTH_TOKEN (Bearer)', description: 'Sent as Authorization: Bearer — for gateways that only accept token auth' },
]

function initialValues(existing?: ModelProfile, initialModel?: string): ProviderFormValues {
  return {
    provider: existing?.provider ?? 'anthropic',
    baseURL: existing?.baseURL ?? '',
    apiKey: existing?.apiKey ?? '',
    authTokenType: existing?.authTokenType ?? 'DOGE_API_KEY',
    model: existing?.model ?? initialModel ?? '',
    opusModel: existing?.defaultOpusModel ?? '',
    sonnetModel: existing?.defaultSonnetModel ?? '',
    haikuModel: existing?.defaultHaikuModel ?? '',
  }
}

function prefillForStep(step: FormStep, values: ProviderFormValues): string {
  switch (step) {
    case 'baseURL': return values.baseURL ?? ''
    case 'apiKey': return values.apiKey ?? ''
    case 'model': return values.model ?? ''
    case 'opus': return values.opusModel ?? ''
    case 'sonnet': return values.sonnetModel ?? ''
    case 'haiku': return values.haikuModel ?? ''
    default: return ''
  }
}

type ProviderFormProps = {
  existing?: ModelProfile
  initialModel?: string
  onDone: (result?: string, options?: { display?: 'system' }) => void
}

export function ProviderForm({ existing, initialModel, onDone }: ProviderFormProps): React.ReactNode {
  const [values, setValues] = React.useState<ProviderFormValues>(() => initialValues(existing, initialModel))
  const [step, setStep] = React.useState<FormStep>('provider')
  const [error, setError] = React.useState<string | undefined>()
  const typedRef = React.useRef('')
  const setAppState = useSetAppState()

  // Reset the typed-value buffer whenever the step moves so pressing Enter
  // without typing submits the prefilled value (or empty → validation).
  const prefill = prefillForStep(step, values)
  React.useEffect(() => {
    typedRef.current = prefill
  }, [step, prefill])

  const advance = React.useCallback(() => {
    setError(undefined)
    const idx = STEP_ORDER.indexOf(step)
    setStep(STEP_ORDER[Math.min(idx + 1, STEP_ORDER.length - 1)])
  }, [step])

  const handleSave = React.useCallback(async () => {
    const validationError = validateProviderForm(values)
    if (validationError) {
      setError(validationError)
      return
    }
    const profile = buildModelProfile(values)
    try {
      await saveAndActivateProvider(profile, defaultProviderSaveDeps(), setAppState)
      const tiers = [
        profile.defaultOpusModel ? `opus=${profile.defaultOpusModel}` : undefined,
        profile.defaultSonnetModel ? `sonnet=${profile.defaultSonnetModel}` : undefined,
        profile.defaultHaikuModel ? `haiku=${profile.defaultHaikuModel}` : undefined,
      ].filter(Boolean).join(', ')
      onDone(
        `Provider saved and activated: ${profile.model}` +
        (tiers ? ` (${tiers})` : ''),
      )
    } catch (err) {
      onDone(
        `Failed to save provider: ${err instanceof Error ? err.message : String(err)}`,
        { display: 'system' },
      )
    }
  }, [values, onDone, setAppState])

  const handleSelect = React.useCallback((value: string) => {
    setError(undefined)
    if (step === 'provider') {
      setValues(v => ({ ...v, provider: value as ProviderFormat }))
      advance()
      return
    }
    if (step === 'authTokenType') {
      setValues(v => ({ ...v, authTokenType: value as AuthTokenType }))
      advance()
      return
    }
    if (step === 'review') {
      if (value === '__SAVE__') {
        void handleSave()
        return
      }
      if (value.startsWith('edit:')) {
        setStep(value.slice('edit:'.length) as FormStep)
      }
      return
    }
    // Input steps: Enter submits whatever is in the typed buffer.
    const raw = typedRef.current.trim()
    if (step === 'baseURL') {
      if (!raw && values.provider !== 'anthropic') {
        setError(`Base URL is required for ${values.provider} providers.`)
        return
      }
      setValues(v => ({ ...v, baseURL: raw }))
      advance()
      return
    }
    if (step === 'apiKey') {
      if (!raw) {
        setError('API key is required.')
        return
      }
      setValues(v => ({ ...v, apiKey: raw }))
      advance()
      return
    }
    if (step === 'model') {
      if (!raw) {
        setError('Main model is required.')
        return
      }
      setValues(v => ({ ...v, model: raw }))
      advance()
      return
    }
    if (step === 'opus') {
      setValues(v => ({ ...v, opusModel: raw }))
      advance()
      return
    }
    if (step === 'sonnet') {
      setValues(v => ({ ...v, sonnetModel: raw }))
      advance()
      return
    }
    if (step === 'haiku') {
      setValues(v => ({ ...v, haikuModel: raw }))
      advance()
    }
  }, [step, values.provider, advance, handleSave])

  const handleCancel = React.useCallback(() => {
    onDone('No provider saved.')
  }, [onDone])

  const stepIndex = STEP_ORDER.indexOf(step)
  const isEdit = existing?.model !== undefined

  let body: React.ReactNode
  if (step === 'provider') {
    body = (
      <Select
        options={PROVIDER_OPTIONS}
        defaultValue={values.provider}
        defaultFocusValue={values.provider}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={3}
      />
    )
  } else if (step === 'authTokenType') {
    body = (
      <Select
        options={AUTH_TOKEN_TYPE_OPTIONS}
        defaultValue={values.authTokenType ?? 'DOGE_API_KEY'}
        defaultFocusValue={values.authTokenType ?? 'DOGE_API_KEY'}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={2}
      />
    )
  } else if (step === 'review') {
    const reviewOptions = [
      { value: 'edit:provider', label: `API format: ${values.provider}`, description: 'Change' },
      { value: 'edit:baseURL', label: `Base URL: ${values.baseURL || '(official API)'}`, description: 'Change' },
      { value: 'edit:apiKey', label: `API key: ${maskSecret(values.apiKey)}`, description: 'Change' },
      { value: 'edit:authTokenType', label: `Key type: ${values.authTokenType ?? 'DOGE_API_KEY'} (${values.authTokenType === 'ANTHROPIC_AUTH_TOKEN' ? 'Bearer' : 'x-api-key'})`, description: 'Change' },
      { value: 'edit:model', label: `Main model: ${values.model}`, description: 'Change' },
      { value: 'edit:opus', label: `Opus model: ${values.opusModel || '(inherit main model)'}`, description: 'Change' },
      { value: 'edit:sonnet', label: `Sonnet model: ${values.sonnetModel || '(inherit main model)'}`, description: 'Change' },
      { value: 'edit:haiku', label: `Haiku model: ${values.haikuModel || '(inherit main model)'}`, description: 'Change' },
      { value: '__SAVE__', label: 'Save and activate', description: 'Persist and switch to this provider now' },
    ]
    body = (
      <Select
        options={reviewOptions}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={9}
      />
    )
  } else {
    const meta = STEP_META[step]
    const inputOption = {
      type: 'input' as const,
      // Key the option by step so each step gets a fresh input buffer.
      value: `input:${step}`,
      label: meta.title,
      placeholder: prefill || (step === 'baseURL' ? 'https://api.example.com' : meta.title),
      initialValue: prefill,
      allowEmptySubmitToCancel: true,
      onChange: (value: string) => { typedRef.current = value },
    }
    body = (
      <Select
        options={[inputOption]}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={1}
      />
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? `Edit Provider — ${existing?.model}` : 'Add Provider'}</Text>
      <Text dimColor>
        Step {stepIndex + 1}/{STEP_ORDER.length}: {step === 'review' ? 'Review' : STEP_META[step].title}
        {'  '}(esc to cancel)
      </Text>
      <Box flexDirection="column" marginY={1}>
        {body}
      </Box>
      {step !== 'review' && <Text dimColor>{STEP_META[step].hint}</Text>}
      {error && <Text color="red">{error}</Text>}
    </Box>
  )
}
