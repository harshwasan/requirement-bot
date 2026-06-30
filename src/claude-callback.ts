import * as http from 'http'
import { URL } from 'url'
import { createLogger } from './logger'

const log = createLogger('claude-callback')

interface PendingCallback {
  token: string
  resolve: (payload: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingCallback>()
let serverStarted = false

export function startClaudeCallbackServer(port: number): void {
  if (serverStarted) return

  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end('Method Not Allowed')
        return
      }

      const host = req.headers.host ?? `127.0.0.1:${port}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname !== '/claude-callback') {
        res.statusCode = 404
        res.end('Not Found')
        return
      }

      const jobId = url.searchParams.get('jobId') ?? ''
      const token = url.searchParams.get('token') ?? ''
      const waiter = pending.get(jobId)

      if (!jobId || !token || !waiter) {
        res.statusCode = 404
        res.end('Unknown job')
        return
      }
      if (waiter.token !== token) {
        res.statusCode = 403
        res.end('Invalid token')
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').trim()
        clearTimeout(waiter.timer)
        pending.delete(jobId)
        waiter.resolve(body)
        res.statusCode = 200
        res.end('ok')
      })
      req.on('error', (err) => {
        clearTimeout(waiter.timer)
        pending.delete(jobId)
        waiter.reject(err as Error)
        res.statusCode = 500
        res.end('error')
      })
    } catch (err) {
      log.error({ err }, 'Callback server handler failed')
      res.statusCode = 500
      res.end('error')
    }
  })

  server.listen(port, '127.0.0.1', () => {
    serverStarted = true
    log.info({ port }, 'Claude callback server listening')
  })

  server.on('error', (err) => {
    log.error({ err }, 'Claude callback server failed')
  })
}

export function waitForClaudeCallback(jobId: string, token: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId)
      reject(new Error(`Callback timed out for job ${jobId}`))
    }, timeoutMs)

    pending.set(jobId, { token, resolve, reject, timer })
  })
}

export function getClaudeCallbackPendingCount(): number {
  return pending.size
}
