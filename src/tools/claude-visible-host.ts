#!/usr/bin/env tsx
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

interface VisibleJob {
  id: string
  promptFile: string
  outputFile: string
  doneFile: string
  allowedTools: string[]
  createdAt: number
}

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!
  return fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function writeDone(doneFile: string, payload: Record<string, unknown>): void {
  fs.writeFileSync(doneFile, JSON.stringify(payload), 'utf8')
}

async function runClaudeJob(job: VisibleJob): Promise<void> {
  const prompt = fs.readFileSync(job.promptFile, 'utf8')
  fs.mkdirSync(path.dirname(job.outputFile), { recursive: true })

  const env = { ...process.env }
  delete env['CLAUDECODE']
  const allowPermissionBypass = env.REQBOT_ALLOW_CLAUDE_BYPASS === 'true'

  console.log(`\n[${new Date().toLocaleTimeString()}] Running job ${job.id}`)
  const permissionArgs = allowPermissionBypass
    ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
    : []
  const args = [
    ...permissionArgs,
    ...(job.allowedTools.length > 0 ? [`--allowedTools=${job.allowedTools.join(',')}`] : []),
    '--',
    prompt,
  ]
  const child = spawn('claude', args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env,
  })

  let rateLimitDetected = false
  let stdoutBuf = ''
  let stderrBuf = ''
  let terminatedForRateLimit = false
  const MAX_ERR_TAIL = 4000

  const checkRateLimit = (text: string) => {
    const s = text.toLowerCase()
    return (
      s.includes('/rate-limit-options') ||
      (s.includes('rate limit') && s.includes('switch to extra usage')) ||
      s.includes('stop and wait for limit to reset')
    )
  }

  const maybeTerminateForRateLimit = () => {
    if (!rateLimitDetected || terminatedForRateLimit) return
    terminatedForRateLimit = true
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, 1000)
  }

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    process.stdout.write(chunk)
    stdoutBuf += text
    if (stdoutBuf.length > MAX_ERR_TAIL) stdoutBuf = stdoutBuf.slice(-MAX_ERR_TAIL)
    if (checkRateLimit(stdoutBuf)) {
      rateLimitDetected = true
      maybeTerminateForRateLimit()
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    process.stderr.write(chunk)
    stderrBuf += text
    if (stderrBuf.length > MAX_ERR_TAIL) stderrBuf = stderrBuf.slice(-MAX_ERR_TAIL)
    if (checkRateLimit(stderrBuf)) {
      rateLimitDetected = true
      maybeTerminateForRateLimit()
    }
  })

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      fs.writeFileSync(job.outputFile, '', 'utf8')
      if (rateLimitDetected) {
        reject(new Error('RATE_LIMIT_DETECTED'))
        return
      }
      if ((code ?? 1) === 0) resolve()
      else {
        const tail = (stderrBuf || stdoutBuf).trim()
        const detail = tail ? `\n--- claude tail ---\n${tail.slice(-MAX_ERR_TAIL)}` : ''
        reject(new Error(`claude exited with code ${code}${detail}`))
      }
    })
  })
}

async function processJob(jobFile: string): Promise<void> {
  const lockedFile = `${jobFile}.working`

  try {
    fs.renameSync(jobFile, lockedFile)
  } catch {
    return
  }

  let job: VisibleJob | null = null
  try {
    job = JSON.parse(fs.readFileSync(lockedFile, 'utf8')) as VisibleJob
  } catch (err) {
    console.error(`Failed to parse job file ${lockedFile}:`, err)
  }

  if (!job) {
    try { fs.unlinkSync(lockedFile) } catch { /* ignore */ }
    return
  }

  try {
    await runClaudeJob(job)
    writeDone(job.doneFile, { status: 'ok', id: job.id, finishedAt: Date.now() })
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err)
    writeDone(job.doneFile, { status: 'error', id: job.id, finishedAt: Date.now(), error: String(err) })
  } finally {
    try { fs.unlinkSync(lockedFile) } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  const queueDir = getArg('--queueDir', path.join(process.cwd(), '.tmp', 'reqbot-claude-visible'))
  const idleMs = parseInt(getArg('--idleMs', String(10 * 60 * 1000)), 10)
  const pidFile = getArg('--pidFile', path.join(queueDir, 'host.pid'))
  const jobsDir = path.join(queueDir, 'jobs')

  fs.mkdirSync(queueDir, { recursive: true })
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(pidFile, String(process.pid), 'utf8')

  console.log(`Claude visible host started (pid=${process.pid})`)
  console.log(`Queue dir: ${queueDir}`)
  console.log(`Idle timeout: ${Math.floor(idleMs / 1000)}s`)
  console.log('Waiting for jobs...')

  let lastActivityAt = Date.now()

  try {
    while (true) {
      const jobFiles = fs.readdirSync(jobsDir)
        .filter(name => name.endsWith('.json'))
        .map(name => path.join(jobsDir, name))
        .sort()

      if (jobFiles.length === 0) {
        if (Date.now() - lastActivityAt >= idleMs) {
          console.log(`No jobs for ${Math.floor(idleMs / 1000)}s. Exiting host.`)
          break
        }
        await sleep(1000)
        continue
      }

      lastActivityAt = Date.now()
      await processJob(jobFiles[0]!)
    }
  } finally {
    try { fs.unlinkSync(pidFile) } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('Visible Claude host crashed:', err)
  process.exit(1)
})
