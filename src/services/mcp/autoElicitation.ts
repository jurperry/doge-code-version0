import type { ElicitRequestParams, ElicitResult, PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { getCurrentPermissionMode, isCurrentAutoPlan } from '../../utils/permissions/currentPermissionMode.js'
import { isZeroAskAutoActive, isZeroAskPlanInterlude } from '../../utils/permissions/autoBypass.js'

type FormValue = string | number | boolean | string[]
const validator = new AjvJsonSchemaValidator()

/** Server defaults win; otherwise use the first option or a bounded primitive. */
function automaticValue(schema: PrimitiveSchemaDefinition): FormValue | undefined {
  if (schema.default !== undefined) return schema.default
  if (schema.type === 'boolean') return true
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.type === 'integer') {
      return schema.minimum !== undefined ? Math.ceil(schema.minimum) : Math.floor(Math.min(0, schema.maximum ?? 0))
    }
    return schema.minimum ?? Math.min(0, schema.maximum ?? 0)
  }
  if (schema.type === 'array') {
    const options = 'enum' in schema.items ? schema.items.enum : schema.items.anyOf.map((option) => option.const)
    return options.slice(0, Math.min(schema.maxItems ?? options.length, Math.max(1, schema.minItems ?? 0)))
  }
  if ('enum' in schema) return schema.enum[0] ?? ''
  if ('oneOf' in schema) return schema.oneOf[0]?.const ?? ''
  const minimum = 'minLength' in schema ? schema.minLength ?? 0 : 0
  const maximum = 'maxLength' in schema ? schema.maxLength ?? 4096 : 4096
  if (minimum > maximum || minimum > 4096) return undefined
  if ('format' in schema && schema.format) {
    const now = new Date().toISOString()
    const candidates = {
      email: ['auto@example.invalid', 'a@b.co'],
      uri: ['http://localhost', 'a:b'],
      date: [now.slice(0, 10)],
      'date-time': [now, now.replace(/\.\d{3}Z$/, 'Z')],
    }[schema.format]
    return candidates.find((value) => value.length >= minimum && value.length <= maximum)
  }
  return 'auto'.padEnd(minimum, ' ').slice(0, maximum)
}

/** TUI, SDK and URL-retry elicitation share this zero-ask fallback. */
export function getAutomaticElicitationResponse(params: ElicitRequestParams): ElicitResult | undefined {
  const mode = getCurrentPermissionMode()
  if (!isZeroAskAutoActive({ mode }) && !isZeroAskPlanInterlude({ mode, prePlanMode: 'bypassPermissions', autoPlan: isCurrentAutoPlan() })) return undefined
  if (params.mode === 'url') return { action: 'accept' }
  const required = new Set(params.requestedSchema.required ?? [])
  const content: Record<string, FormValue> = Object.create(null)
  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    if (required.has(name) || schema.default !== undefined) {
      const value = automaticValue(schema)
      if (value === undefined) return { action: 'decline' }
      content[name] = value
    }
  }
  // An unsatisfiable schema must terminate automatically rather than open a dialog.
  return validator.getValidator(params.requestedSchema)(content).valid ? { action: 'accept', content } : { action: 'decline' }
}
