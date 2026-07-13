import { test, expect } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { isClientError, isImageUnsupportedError } from './errors.js'

test('isImageUnsupportedError: matches common "image not supported" wording', () => {
  expect(isImageUnsupportedError(new Error('image input is not supported'))).toBe(
    true,
  )
  expect(
    isImageUnsupportedError(new Error('Image is not supported by this model')),
  ).toBe(true)
  expect(
    isImageUnsupportedError(new Error('model does not support image input')),
  ).toBe(true)
  expect(isImageUnsupportedError(new Error('image input unsupported'))).toBe(true)
  expect(isImageUnsupportedError(new Error('vision not supported'))).toBe(true)
  expect(isImageUnsupportedError(new Error('vision unsupported on this endpoint'))).toBe(
    true,
  )
  expect(isImageUnsupportedError(new Error('multimodal not supported'))).toBe(true)
  expect(
    isImageUnsupportedError(new Error('this endpoint does not support image')),
  ).toBe(true)
  expect(isImageUnsupportedError(new Error('no vision capability'))).toBe(true)
  expect(isImageUnsupportedError(new Error('invalid image'))).toBe(true)
})

test('isImageUnsupportedError: matches APIError (SDK Error subclass) by message', () => {
  // Third-party endpoints return 4xx; the SDK wraps them as APIError, whose
  // message becomes `${status} ${error.message}` (see APIError.makeMessage).
  const headers = new Headers()
  headers.set('request-id', 'req_test')
  const apiError = new APIError(
    400,
    { message: 'image input is not supported', type: 'invalid_request_error' },
    'image input is not supported',
    headers,
  )
  expect(isImageUnsupportedError(apiError)).toBe(true)
})

test('isImageUnsupportedError: does not match unrelated errors', () => {
  expect(isImageUnsupportedError(new Error('rate limit exceeded'))).toBe(false)
  expect(isImageUnsupportedError(new Error('prompt is too long'))).toBe(false)
  expect(isImageUnsupportedError(new Error('internal server error'))).toBe(false)
  expect(isImageUnsupportedError(new Error('model not found'))).toBe(false)
  expect(isImageUnsupportedError(new Error('context length exceeded'))).toBe(false)
})

test('isImageUnsupportedError: does NOT match size-limit errors (isMediaSizeError domain)', () => {
  // These belong to isMediaSizeError (size/dimension rejections) and must NOT
  // be classified as capability rejections - they feed a different (stubbed)
  // recovery path and would conflate the two failure modes.
  expect(
    isImageUnsupportedError(new Error('image exceeds maximum allowed size')),
  ).toBe(false)
  expect(
    isImageUnsupportedError(new Error('image dimensions exceed many-image limit')),
  ).toBe(false)
  expect(isImageUnsupportedError(new Error('maximum of 50 PDF pages exceeded'))).toBe(
    false,
  )
})

test('isImageUnsupportedError: unwraps CannotRetryError.originalError via duck typing', () => {
  // withRetry wraps non-retryable errors in CannotRetryError. claude.ts's
  // generator-consumption catch passes the wrapper straight in; the predicate
  // must unwrap it without importing the class (circular import avoidance).
  const wrapper = Object.assign(new Error('Cannot retry: attempt failed'), {
    originalError: new Error('image input is not supported'),
  })
  expect(isImageUnsupportedError(wrapper)).toBe(true)

  // Wrapper around a size error must still NOT match (unwrap + exclude).
  const wrapperSize = Object.assign(new Error('Cannot retry'), {
    originalError: new Error('image exceeds maximum allowed size'),
  })
  expect(isImageUnsupportedError(wrapperSize)).toBe(false)
})

test('isImageUnsupportedError: returns false for non-Error inputs', () => {
  expect(isImageUnsupportedError(null)).toBe(false)
  expect(isImageUnsupportedError(undefined)).toBe(false)
  expect(isImageUnsupportedError('image not supported')).toBe(false)
  expect(isImageUnsupportedError({ message: 'image not supported' })).toBe(false)
  expect(isImageUnsupportedError(42)).toBe(false)
})

test('isImageUnsupportedError: matches GLM "Model only support text input" wording', () => {
  // GLM's anthropic-compatible endpoint returns this 400 when the model lacks
  // vision. Critically, it contains NO image/vision/multimodal keyword - the
  // reason the pure-keyword approach failed and why claude.ts also has the
  // isClientError + messagesContainImage fallback. Verified against the real
  // error: 400 {"error":{"code":"InvalidParameter","message":"Model only
  // support text input Request id: ...","type":"BadRequest"}}.
  expect(
    isImageUnsupportedError(
      new Error(
        '400 {"error":{"code":"InvalidParameter","message":"Model only support text input Request id: 02178395565593693b918b1415a5310eff3f6e1414d2c03d423e1","param":"","type":"BadRequest"}}',
      ),
    ),
  ).toBe(true)
  expect(
    isImageUnsupportedError(new Error('Model only support text input')),
  ).toBe(true)
  expect(
    isImageUnsupportedError(new Error('this model only supports text')),
  ).toBe(true)
  expect(isImageUnsupportedError(new Error('text input only'))).toBe(true)
})

test('isClientError: matches 4xx APIError and unwraps CannotRetryError', () => {
  const err400 = new APIError(
    400,
    { message: 'bad request', type: 'invalid_request_error' },
    'bad request',
    new Headers(),
  )
  const err500 = new APIError(
    500,
    { message: 'server error', type: 'internal_error' },
    'server error',
    new Headers(),
  )
  expect(isClientError(err400)).toBe(true)
  expect(isClientError(err500)).toBe(false)
  // Wrapped in CannotRetryError (duck-typed via originalError)
  const wrapper = Object.assign(new Error('Cannot retry: attempt failed'), {
    originalError: err400,
  })
  expect(isClientError(wrapper)).toBe(true)
  const wrapper500 = Object.assign(new Error('Cannot retry'), {
    originalError: err500,
  })
  expect(isClientError(wrapper500)).toBe(false)
})

test('isClientError: returns false for non-APIError inputs', () => {
  expect(isClientError(new Error('some error'))).toBe(false)
  expect(isClientError(null)).toBe(false)
  expect(isClientError('400')).toBe(false)
})
