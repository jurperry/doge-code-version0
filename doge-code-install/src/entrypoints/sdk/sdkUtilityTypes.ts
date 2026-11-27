export type NonNullableUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  /** Present when the provider reported the cache-read count, including zero. */
  cache_read_reported?: true
}
