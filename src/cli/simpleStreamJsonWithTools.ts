// Enhanced stream-json handler with tool support for Bun on Windows
// Workaround for Bun bug where print.ts cannot be loaded
import { joinBaseUrl } from '../services/api/joinBaseUrl.js';
import { createInterface } from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, resolve } from 'path';

interface StreamJsonMessage {
  type: string;
  request_id?: string;
  session_id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; [key: string]: any }>;
  };
  request?: {
    subtype: string;
    systemPrompt?: string[];
  };
  parent_tool_use_id?: string | null;
}

// OpenAI-compatible API types
type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

type OpenAIStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
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
  messages: OpenAIChatMessage[],
  tools?: any[],
): Promise<{ stream: ReadableStreamDefaultReader<Uint8Array>; model: string }> {
  const url = joinBaseUrl(baseURL, 'chat/completions');

  // Convert Anthropic tools to OpenAI format
  const openaiTools = tools?.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));

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
      ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
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

// Tool definitions matching Claude Code's tools
const tools: Anthropic.Tool[] = [
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. The file_path parameter must be an absolute path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Writes content to a file. Creates the file if it does not exist. The file_path parameter must be an absolute path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacements in files. The file must be read first before editing.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to replace',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Executes a bash command and returns its output.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        description: {
          type: 'string',
          description: 'Clear description of what this command does',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool. Supports glob patterns like "**/*.js" or "src/**/*.ts".',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description: 'The directory to search in. Defaults to current working directory.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search tool for finding text patterns in files. Supports regex patterns.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to current working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.js", "**/*.tsx")',
        },
      },
      required: ['pattern'],
    },
  },
];

// Tool execution functions
async function executeTool(toolName: string, toolInput: any): Promise<string> {
  console.error(`[TOOL] Executing ${toolName} with input:`, JSON.stringify(toolInput).slice(0, 100));

  try {
    switch (toolName) {
      case 'Read': {
        const filePath = toolInput.file_path;
        if (!existsSync(filePath)) {
          return `Error: File not found: ${filePath}`;
        }
        const content = readFileSync(filePath, 'utf-8');
        // Add line numbers like cat -n
        const lines = content.split('\n');
        const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
        return numbered;
      }

      case 'Write': {
        const filePath = toolInput.file_path;
        const content = toolInput.content;
        // Create directory if it doesn't exist
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, content, 'utf-8');
        return `File written successfully: ${filePath}`;
      }

      case 'Edit': {
        const filePath = toolInput.file_path;
        const oldString = toolInput.old_string;
        const newString = toolInput.new_string;

        if (!existsSync(filePath)) {
          return `Error: File not found: ${filePath}`;
        }

        const content = readFileSync(filePath, 'utf-8');

        // Check if old_string exists
        if (!content.includes(oldString)) {
          return `Error: String not found in file. The old_string must match exactly.`;
        }

        // Check if old_string is unique
        const occurrences = content.split(oldString).length - 1;
        if (occurrences > 1) {
          return `Error: String appears ${occurrences} times in file. The old_string must be unique.`;
        }

        const newContent = content.replace(oldString, newString);
        writeFileSync(filePath, newContent, 'utf-8');
        return `File edited successfully: ${filePath}`;
      }

      case 'Bash': {
        const command = toolInput.command;
        try {
          const output = execSync(command, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024, // 10MB
            timeout: 120000, // 2 minutes
            cwd: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
          });
          return output || '(Command completed with no output)';
        } catch (err: any) {
          return `Error executing command: ${err.message}\nStderr: ${err.stderr || ''}\nStdout: ${err.stdout || ''}`;
        }
      }

      case 'Glob': {
        const pattern = toolInput.pattern;
        const searchPath = toolInput.path || process.env.CTI_DEFAULT_WORKDIR || process.cwd();

        try {
          // Use find command for glob pattern matching
          const findCmd = `find "${searchPath}" -name "${pattern}" -type f 2>/dev/null | head -100`;
          const output = execSync(findCmd, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30000,
          });

          if (!output.trim()) {
            return `No files found matching pattern: ${pattern}`;
          }

          return output.trim();
        } catch (err: any) {
          return `Error searching files: ${err.message}`;
        }
      }

      case 'Grep': {
        const pattern = toolInput.pattern;
        const searchPath = toolInput.path || process.env.CTI_DEFAULT_WORKDIR || process.cwd();
        const globPattern = toolInput.glob || '*';

        try {
          // Use grep with find for pattern matching
          let grepCmd: string;
          if (existsSync(searchPath) && !require('fs').statSync(searchPath).isDirectory()) {
            // Search in a single file
            grepCmd = `grep -n "${pattern}" "${searchPath}" 2>/dev/null | head -50`;
          } else {
            // Search in directory with glob pattern
            grepCmd = `find "${searchPath}" -name "${globPattern}" -type f -exec grep -l "${pattern}" {} \\; 2>/dev/null | head -50`;
          }

          const output = execSync(grepCmd, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30000,
          });

          if (!output.trim()) {
            return `No matches found for pattern: ${pattern}`;
          }

          return output.trim();
        } catch (err: any) {
          // grep returns exit code 1 when no matches found
          if (err.status === 1 && !err.stderr) {
            return `No matches found for pattern: ${pattern}`;
          }
          return `Error searching content: ${err.message}`;
        }
      }

      default:
        return `Error: Unknown tool: ${toolName}`;
    }
  } catch (err: any) {
    console.error(`[TOOL] Error executing ${toolName}:`, err);
    return `Error: ${err.message || String(err)}`;
  }
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
          model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
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
            console.error('[SIMPLE] Using OpenAI-compatible API with tools');

            // Conversation history for multi-turn tool use
            const messages: OpenAIChatMessage[] = [];
            if (systemPrompt) {
              messages.push({ role: 'system', content: systemPrompt });
            }
            messages.push({ role: 'user', content: userText });

            let continueLoop = true;
            let turnCount = 0;

            while (continueLoop) {
              turnCount++;
              console.error(`[SIMPLE] Turn ${turnCount}, messages: ${messages.length}`);

              const { stream: reader } = await callOpenAICompatAPI(apiKey, baseURL, model, messages, tools);

              const decoder = new TextDecoder();
              let buffer = '';
              let contentIndex = 0;
              let promptTokens = 0;
              let completionTokens = 0;
              const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
              const toolCallState = new Map<number, { id: string; name: string; arguments: string }>();
              let textContent = '';
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

                    // 兼容 reasoning_content / reasoning（vLLM / OpenRouter 等）
                    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
                    if (reasoningDelta) {
                      reasoningContent += reasoningDelta;
                    }

                    // Emit text delta
                    if (delta?.content) {
                      textContent += delta.content;
                      console.log(JSON.stringify({
                        type: 'stream_event',
                        event: {
                          type: 'content_block_delta',
                          index: contentIndex++,
                          delta: { type: 'text_delta', text: delta.content },
                        },
                      }));
                    }

                    // Handle tool calls
                    if (delta?.tool_calls) {
                      for (const toolCall of delta.tool_calls) {
                        const openAIIndex = toolCall.index ?? 0;
                        let state = toolCallState.get(openAIIndex);

                        if (!state) {
                          state = {
                            id: toolCall.id ?? `toolu_${openAIIndex}`,
                            name: toolCall.function?.name ?? '',
                            arguments: '',
                          };
                          toolCallState.set(openAIIndex, state);
                          console.error(`[SIMPLE] Tool use detected: ${state.name}`);
                          console.log(JSON.stringify({
                            type: 'stream_event',
                            event: {
                              type: 'content_block_start',
                              index: contentIndex++,
                              content_block: {
                                type: 'tool_use',
                                id: state.id,
                                name: state.name,
                                input: {},
                              },
                            },
                          }));
                        }

                        if (toolCall.id) state.id = toolCall.id;
                        if (toolCall.function?.name) state.name = toolCall.function.name;
                        if (toolCall.function?.arguments) {
                          state.arguments += toolCall.function.arguments;
                        }
                      }
                    }

                    // Handle finish
                    if (chunk.choices?.[0]?.finish_reason) {
                      console.error(`[SIMPLE] Stream completed, stop_reason: ${chunk.choices[0].finish_reason}`);

                      // Collect completed tool calls
                      for (const state of toolCallState.values()) {
                        toolCalls.push({
                          id: state.id,
                          name: state.name,
                          arguments: state.arguments,
                        });
                      }

                      // If there are tool uses, execute them and continue
                      if (toolCalls.length > 0) {
                        console.error(`[SIMPLE] Executing ${toolCalls.length} tool(s)`);

                        // Add assistant message with tool calls to history
                        // IMPORTANT: Include reasoning_content for DeepSeek multi-turn
                        const assistantMsg: OpenAIChatMessage = {
                          role: 'assistant',
                          content: textContent || null,
                          tool_calls: toolCalls.map(tc => ({
                            id: tc.id,
                            type: 'function' as const,
                            function: {
                              name: tc.name,
                              arguments: tc.arguments,
                            },
                          })),
                        };
                        // Add reasoning_content if present (required by DeepSeek)
                        if (reasoningContent) {
                          assistantMsg.reasoning_content = reasoningContent;
                        }
                        messages.push(assistantMsg);

                        // Execute tools and add results
                        for (const toolCall of toolCalls) {
                          const input = JSON.parse(toolCall.arguments || '{}');
                          const result = await executeTool(toolCall.name, input);

                          messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: result,
                          });

                          // Emit tool_result event for SDK
                          console.log(JSON.stringify({
                            type: 'stream_event',
                            event: {
                              type: 'tool_result',
                              tool_use_id: toolCall.id,
                              content: result,
                            },
                          }));
                        }

                        // Continue the loop to get Claude's response after tool execution
                        continueLoop = true;
                        break;
                      } else {
                        // No more tool uses, conversation is complete
                        continueLoop = false;

                        console.error('[SIMPLE] Conversation complete, sending result');
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
              }

              if (!continueLoop) break;
            }
          } else {
            // Use Anthropic SDK for native format
            console.error('[SIMPLE] Using Anthropic native API with tools');
            const anthropic = new Anthropic({ apiKey, ...(baseURL && { baseURL }) });

            // Conversation history for multi-turn tool use
            const messages: Anthropic.MessageParam[] = [
              { role: 'user', content: userText }
            ];

            let continueLoop = true;
            let turnCount = 0;
            let retryCount = 0;
            const maxRetries = 2;
            // No maxTurns limit - matches real doge-code behavior

            while (continueLoop) {
              turnCount++;
              console.error(`[SIMPLE] Turn ${turnCount}, messages: ${messages.length}`);

              try {
                const stream = anthropic.messages.stream({
                  model,
                  max_tokens: 8192,
                  messages,
                  tools,
                  ...(systemPrompt && { system: systemPrompt }),
                });

                // SDK expects stream_event format
                let contentIndex = 0;
                const toolUses: Array<{ id: string; name: string; input: any }> = [];
                let hasText = false;

                stream.on('text', (text) => {
                  hasText = true;
                  console.log(JSON.stringify({
                    type: 'stream_event',
                    event: {
                      type: 'content_block_delta',
                      index: contentIndex++,
                      delta: { type: 'text_delta', text },
                    },
                  }));
                });

                stream.on('contentBlock', (block) => {
                  if (block.type === 'tool_use') {
                    console.error(`[SIMPLE] Tool use detected: ${block.name}`);
                    toolUses.push({
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    });
                    // Emit tool_use event for SDK
                    console.log(JSON.stringify({
                      type: 'stream_event',
                      event: {
                        type: 'content_block_start',
                        index: contentIndex++,
                        content_block: {
                          type: 'tool_use',
                          id: block.id,
                          name: block.name,
                          input: block.input,
                        },
                      },
                    }));
                  }
                });

                // Wait for completion
                const finalMsg = await stream.finalMessage();
                console.error(`[SIMPLE] Stream completed, stop_reason: ${finalMsg.stop_reason}`);

                // Reset retry count on success
                retryCount = 0;

                // If there are tool uses, execute them and continue
                if (toolUses.length > 0) {
                  console.error(`[SIMPLE] Executing ${toolUses.length} tool(s)`);

                  // Add assistant message with tool uses to history
                  messages.push({
                    role: 'assistant',
                    content: finalMsg.content,
                  });

                  // Execute tools and add results
                  const toolResults: Anthropic.ToolResultBlockParam[] = [];
                  for (const toolUse of toolUses) {
                    const result = await executeTool(toolUse.name, toolUse.input);
                    toolResults.push({
                      type: 'tool_result',
                      tool_use_id: toolUse.id,
                      content: result,
                    });

                    // Emit tool_result event for SDK
                    console.log(JSON.stringify({
                      type: 'stream_event',
                      event: {
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: result,
                      },
                    }));
                  }

                  // Add tool results to history
                  messages.push({
                    role: 'user',
                    content: toolResults,
                  });

                  // Continue the loop to get Claude's response after tool execution
                  continueLoop = true;
                } else {
                  // No more tool uses, conversation is complete
                  continueLoop = false;

                  console.error('[SIMPLE] Conversation complete, sending result');
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
              } catch (streamErr: any) {
                // Handle stream errors (e.g., "request ended without sending any chunks")
                console.error(`[SIMPLE] Stream error on turn ${turnCount}: ${streamErr?.message || streamErr}`);

                // Check if we should retry
                if (retryCount < maxRetries && (streamErr?.message || '').includes('request ended without sending any chunks')) {
                  retryCount++;
                  console.error(`[SIMPLE] Retrying (${retryCount}/${maxRetries})...`);
                  // Don't increment turnCount, retry the same turn
                  turnCount--;
                  continue;
                } else {
                  // Max retries reached or non-retryable error
                  throw streamErr;
                }
              }
            }
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
