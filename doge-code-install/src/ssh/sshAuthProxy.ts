import { createServer, type Server } from 'http'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens, isClaudeAISubscriber } from '../utils/auth.js'
import { getModelConnection, getModelEnvironment } from '../utils/model/runtimeModelContext.js'
import { getProxyFetchOptions } from '../utils/proxy.js'

export type SSHAuthProxy = {
  port: number
  token: string
  stop: () => void
}

function upstreamUrl(pathname: string, query: string): string {
  const subscriber = isClaudeAISubscriber()
  const base = subscriber ? getOauthConfig().BASE_API_URL : getModelConnection().baseURL
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
  const search = new URLSearchParams(query)
  const requestKeys = new Set(search.keys())
  for (const [key, value] of url.searchParams) if (!requestKeys.has(key)) search.append(key, value)
  url.search = search.toString()
  return url.toString()
}

function upstreamHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (['host', 'content-length', 'connection', 'authorization', 'x-api-key', 'x-doge-ssh-proxy'].includes(lower)) continue
    if (typeof value === 'string') result[key] = value
    else if (Array.isArray(value)) result[key] = value.join(', ')
  }
  const custom = getModelEnvironment().ANTHROPIC_CUSTOM_HEADERS
  for (const line of custom?.split(/\r?\n/) ?? []) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (key && !['authorization', 'x-api-key', 'x-doge-ssh-proxy'].includes(key.toLowerCase())) result[key] = line.slice(colon + 1).trim()
  }
  delete result.Authorization
  delete result.authorization
  delete result['x-api-key']
  delete result['X-Api-Key']

  const connection = getModelConnection()
  const oauth = getClaudeAIOAuthTokens()?.accessToken
  if (isClaudeAISubscriber() && oauth) {
    result.Authorization = `Bearer ${oauth}`
  } else if (connection.apiKey) {
    if (connection.provider !== 'anthropic' || connection.authTokenType === 'ANTHROPIC_AUTH_TOKEN') result.Authorization = `Bearer ${connection.apiKey}`
    else result['x-api-key'] = connection.apiKey
  }
  return result
}

export async function startSSHAuthProxy(): Promise<SSHAuthProxy> {
  const token = randomUUID()
  const sockets = new Set<import('net').Socket>()
  const server: Server = createServer(async (req, res) => {
    if (req.headers['x-doge-ssh-proxy'] !== token) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('SSH auth proxy: invalid tunnel token')
      return
    }
    const abort = new AbortController()
    req.once('aborted', () => abort.abort())
    res.once('close', () => abort.abort())
    try {
      const url = new URL(req.url ?? '/', 'http://doge-ssh.local')
      const response = await fetch(upstreamUrl(url.pathname, url.search), {
        method: req.method,
        headers: upstreamHeaders(req.headers),
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req as unknown as BodyInit, duplex: 'half' } : {}),
        signal: abort.signal,
        ...getProxyFetchOptions(),
      } as RequestInit)
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) headers[key] = value
      })
      res.writeHead(response.status, headers)
      if (!response.body) {
        res.end()
        return
      }
      const stream = Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`SSH auth proxy: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('无法分配本地 SSH 认证代理端口')
  }
  let stopped = false
  return {
    port: address.port,
    token,
    stop: () => {
      if (stopped) return
      stopped = true
      server.close()
      for (const socket of sockets) socket.destroy()
    },
  }
}
