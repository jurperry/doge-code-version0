// Simplified stream-json handler for Bun on Windows
// Workaround for Bun bug where print.ts cannot be loaded
import { createInterface } from 'readline';
import Anthropic from '@anthropic-ai/sdk';

interface StreamJsonMessage {
  type: string;
  request_id?: string;
  session_id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text: string }>;
  };
  request?: {
    subtype: string;
    systemPrompt?: string[];
  };
  parent_tool_use_id?: string | null;
}

// OpenAI-compatible API types
type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
}

type OpenAIStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// Helper function to call OpenAI-compatible API
async function callOpenAICompatAPI(
  apiKey: string,
  baseURL: string,
  model: string,
  userText: string,
  systemPrompt: string,
): Promise<{ stream: ReadableStreamDefaultReader<Uint8Array>; model: string }> {
  const messages: OpenAIChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userText });

  const url = `${baseURL.replace(/\/$/, '')}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 8192,
    }),
  });

  if (!response.ok || !response.body) {
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      responseText = '';
    }
    throw new Error(
      `OpenAI compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`,
    );
  }

  return { stream: response.body.getReader(), model };
}

// Helper function to parse SSE chunks
function parseSSEChunk(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() ?? '';
  return { events: parts, remainder };
}

export async function runSimpleStreamJson(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let sessionId = '';
  let systemPrompt = '';

  for await (const line of rl) {
    try {
      const msg: StreamJsonMessage = JSON.parse(line);

      if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
        // SDK sends initialize control_request, reply with control_response
        systemPrompt = msg.request.systemPrompt?.[0] || '';
        console.log(JSON.stringify({
          type: 'control_response',
          request_id: msg.request_id,
          response: { status: 'success' },
        }));
        // Also send system init for SDK
        console.log(JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: msg.session_id || '',
          model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
        }));
        continue;
      }

      if (msg.type === 'user' && msg.message) {
        console.error('[SIMPLE] Processing user message');
        sessionId = msg.session_id || sessionId;
        const userText = msg.message.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
        console.error(`[SIMPLE] User text: ${userText.slice(0, 50)}, model: ${process.env.ANTHROPIC_MODEL}`);

        const apiKey = process.env.DOGE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
        const baseURL = process.env.ANTHROPIC_BASE_URL;
        const provider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER || 'anthropic';
        console.error(`[SIMPLE] API key exists: ${!!apiKey}, baseURL: ${baseURL}, provider: ${provider}`);

        if (!apiKey) {
          console.log(JSON.stringify({
            type: 'result',
            subtype: 'error_during_execution',
            session_id: sessionId,
            is_error: true,
            errors: ['No API key configured. Set DOGE_API_KEY, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in config.env'],
          }));
          continue;
        }

        try {
          const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-20250514';

          // Use OpenAI-compatible API if provider is 'openai'
          if (provider === 'openai' && baseURL) {
            console.error('[SIMPLE] Using OpenAI-compatible API');
            const { stream: reader } = await callOpenAICompatAPI(apiKey, baseURL, model, userText, systemPrompt);

            const decoder = new TextDecoder();
            let buffer = '';
            let contentIndex = 0;
            let promptTokens = 0;
            let completionTokens = 0;
            let reasoningContent = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const parsed = parseSSEChunk(buffer);
              buffer = parsed.remainder;

              for (const rawEvent of parsed.events) {
                const dataLines = rawEvent
                  .split('\n')
                  .filter(line => line.startsWith('data:'))
                  .map(line => line.slice(5).trim());

                for (const data of dataLines) {
                  if (!data || data === '[DONE]') continue;
                  const chunk = JSON.parse(data) as OpenAIStreamChunk;
                  const delta = chunk.choices?.[0]?.delta;

                  // Update usage tokens
                  if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.prompt_tokens > 0) {
                    promptTokens = chunk.usage.prompt_tokens;
                  }
                  if (chunk.usage?.completion_tokens !== undefined && chunk.usage.completion_tokens > 0) {
                    completionTokens = chunk.usage.completion_tokens;
                  }

                  // Capture reasoning_content for DeepSeek (not emitted to user, but tracked for potential future use)
                  if (delta?.reasoning_content) {
                    reasoningContent += delta.reasoning_content;
                  }

                  // Emit text delta
                  if (delta?.content) {
                    console.log(JSON.stringify({
                      type: 'stream_event',
                      event: {
                        type: 'content_block_delta',
                        index: contentIndex++,
                        delta: { type: 'text_delta', text: delta.content },
                      },
                    }));
                  }

                  // Handle finish
                  if (chunk.choices?.[0]?.finish_reason) {
                    console.error('[SIMPLE] Stream completed, sending result');
                    console.log(JSON.stringify({
                      type: 'result',
                      subtype: 'success',
                      session_id: sessionId,
                      is_error: false,
                      usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens,
                      },
                    }));
                    rl.close();
                    process.exit(0);
                  }
                }
              }
            }
          } else {
            // Use Anthropic SDK for native format
            console.error('[SIMPLE] Using Anthropic native API');
            const anthropic = new Anthropic({ apiKey, ...(baseURL && { baseURL }) });

            const stream = anthropic.messages.stream({
              model,
              max_tokens: 8192,
              messages: [{ role: 'user', content: userText }],
              ...(systemPrompt && { system: systemPrompt }),
            });
            console.error('[SIMPLE] Stream created, waiting for completion...');

            // SDK expects stream_event format
            let contentIndex = 0;
            stream.on('text', (text) => {
              console.log(JSON.stringify({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  index: contentIndex++,
                  delta: { type: 'text_delta', text },
                },
              }));
            });

            // Wait for completion
            const finalMsg = await stream.finalMessage();
            console.error('[SIMPLE] Stream completed, sending result');

            // SDK expects result with session_id
            console.log(JSON.stringify({
              type: 'result',
              subtype: 'success',
              session_id: sessionId,
              is_error: false,
              usage: {
                input_tokens: (finalMsg as any).usage?.input_tokens ?? 0,
                output_tokens: (finalMsg as any).usage?.output_tokens ?? 0,
              },
            }));

            // Close stdin to signal completion and allow SDK to finish iteration
            rl.close();
            process.exit(0);
          }
        } catch (apiErr: any) {
          // Send error result so SDK doesn't hang
          console.error(`[SIMPLE] API error: ${apiErr?.message || apiErr}`);
          console.log(JSON.stringify({
            type: 'result',
            subtype: 'error_during_execution',
            session_id: sessionId,
            is_error: true,
            errors: [apiErr?.message || String(apiErr)],
          }));

          // Close stdin to signal completion and allow SDK to finish iteration
          rl.close();
          process.exit(1);
        }
      }
    } catch (err: any) {
      console.error(`[SIMPLE] Error: ${err?.message || err}`);
      continue;
    }
  }
}
