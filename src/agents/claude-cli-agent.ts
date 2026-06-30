import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { config } from '../config'
import { CarListing, HistoryContext, store } from '../history/store'
import {
  buildClassifierPrompt,
  buildListingExtractorPrompt,
  sanitizeForPrompt,
} from '../prompt-builder'
import { AgentResult, BaseAgent, IncomingMessage, Match, MessageProcessResult, MessageType } from './base-agent'
import { createLogger } from '../logger'
import { getClaudeCallbackPendingCount, waitForClaudeCallback } from '../claude-callback'
import { randomUUID } from 'crypto'

const log = createLogger('claude-cli-agent')

const CLI_TIMEOUT_SHORT = 120_000
const CLI_TIMEOUT_LONG = 600_000
const VISIBLE_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const VISIBLE_POLL_MS = 1000

interface VisibleJob {
  id: string
  promptFile: string
  outputFile: string
  doneFile: string
  allowedTools: string[]
  createdAt: number
}

interface VisibleHost {
  key: string
  queueRoot: string
  jobsDir: string
  pidFile: string
  startPromise: Promise<void> | null
}

export class ClaudeCliAgent extends BaseAgent {
  private visibleBaseRoot = path.join(os.tmpdir(), 'reqbot-claude-visible')
  private visibleHosts = new Map<string, VisibleHost>()

  private normalizeAllowedTools(allowTools: boolean | string[]): string[] {
    if (Array.isArray(allowTools)) return allowTools
    return allowTools ? ['WebSearch', 'WebFetch', 'Bash'] : []
  }

  private getTsxBinPath(): string {
    const bin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    return path.resolve(__dirname, '../../node_modules/.bin', bin)
  }

  private callCliHidden(
    prompt: string,
    { timeoutMs = CLI_TIMEOUT_SHORT, allowTools = false }: { timeoutMs?: number; allowTools?: boolean | string[] } = {}
  ): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const tmp = os.tmpdir()
    const pFile = path.join(tmp, `reqbot-${id}-prompt.txt`)
    const oFile = path.join(tmp, `reqbot-${id}-output.txt`)

    const projectRoot = path.resolve(__dirname, '../../')
    const runnerScript = path.resolve(__dirname, '../../src/tools/run-claude.ts')

    fs.writeFileSync(pFile, prompt, 'utf8')
    const normalizedTools = this.normalizeAllowedTools(allowTools)
    const toolArgs = normalizedTools.length > 0 ? ['--allowedTools', normalizedTools.join(',')] : []

    return new Promise((resolve, reject) => {
      const tsxBin = this.getTsxBinPath()
      const child = spawn(
        tsxBin, [runnerScript, pFile, oFile, ...toolArgs],
        { windowsHide: true, stdio: 'ignore', cwd: projectRoot }
      )

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.on('close', () => {
        clearTimeout(timer)
        const out = fs.existsSync(oFile) ? fs.readFileSync(oFile, 'utf8').trim() : ''
        try { fs.unlinkSync(pFile) } catch { /* ignore */ }
        try { fs.unlinkSync(oFile) } catch { /* ignore */ }
        resolve(out)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private callCliVisible(
    prompt: string,
    { timeoutMs = CLI_TIMEOUT_LONG, allowTools = false, label = '', hostKey = 'default' }: {
      timeoutMs?: number
      allowTools?: boolean | string[]
      label?: string
      hostKey?: string
    } = {}
  ): Promise<string> {
    return this.enqueueVisibleJob(prompt, { timeoutMs, allowTools, label, hostKey })
  }

  private async enqueueVisibleJob(
    prompt: string,
    {
      timeoutMs,
      allowTools,
      label,
      hostKey,
    }: { timeoutMs: number; allowTools: boolean | string[]; label: string; hostKey: string }
  ): Promise<string> {
    const host = this.getOrCreateVisibleHost(hostKey)
    await this.ensureVisibleHost(host, label)

    fs.mkdirSync(host.queueRoot, { recursive: true })
    fs.mkdirSync(host.jobsDir, { recursive: true })

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const promptFile = path.join(host.queueRoot, `prompt-${id}.txt`)
    const outputFile = path.join(host.queueRoot, `output-${id}.txt`)
    const doneFile = path.join(host.queueRoot, `done-${id}.json`)
    const jobFile = path.join(host.jobsDir, `${Date.now()}-${id}.json`)

    const job: VisibleJob = {
      id,
      promptFile,
      outputFile,
      doneFile,
      allowedTools: this.normalizeAllowedTools(allowTools),
      createdAt: Date.now(),
    }

    const callbackToken = randomUUID()
    const callbackUrl = `http://127.0.0.1:${config.claudeCallbackPort}/claude-callback?jobId=${encodeURIComponent(id)}&token=${encodeURIComponent(callbackToken)}`
    const skillContract = this.buildCallbackSkillContract(callbackUrl)
    const promptWithCallback = `${prompt}\n\n${skillContract}`

    fs.writeFileSync(promptFile, promptWithCallback, 'utf8')
    fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8')

    let callbackResult: string | null = null
    let callbackError: Error | null = null
    waitForClaudeCallback(id, callbackToken, timeoutMs)
      .then(payload => { callbackResult = payload })
      .catch(err => { callbackError = err as Error })

    const startedAt = Date.now()
    while (true) {
      if (callbackError) {
        this.cleanupVisibleJobFiles([promptFile, outputFile, doneFile, jobFile])
        throw callbackError
      }
      if (callbackResult !== null) {
        this.cleanupVisibleJobFiles([promptFile, outputFile, doneFile, jobFile])
        return callbackResult
      }

      if (fs.existsSync(doneFile)) {
        let doneStatus: { status?: string; error?: string } = {}
        try {
          doneStatus = JSON.parse(fs.readFileSync(doneFile, 'utf8')) as { status?: string; error?: string }
        } catch { /* ignore */ }

        this.cleanupVisibleJobFiles([promptFile, outputFile, doneFile, jobFile])
        if (doneStatus.status === 'error') {
          throw new Error(doneStatus.error || 'visible claude job failed')
        }
        throw new Error('Visible Claude session ended without posting callback result')
      }

      if (Date.now() - startedAt > timeoutMs) {
        this.cleanupVisibleJobFiles([promptFile, outputFile, doneFile, jobFile])
        throw new Error(`claude CLI timed out after ${timeoutMs}ms`)
      }

      await this.sleep(VISIBLE_POLL_MS)
    }
  }

  private buildCallbackSkillContract(callbackUrl: string): string {
    return [
      'MANDATORY FINAL STEP (DO NOT SKIP):',
      'When your analysis is complete, you MUST POST your final JSON result to this callback URL exactly once.',
      `CALLBACK_URL: ${callbackUrl}`,
      'Required command format (Windows-safe):',
      `1) Save your FINAL JSON ONLY to a file, e.g. $env:TEMP\\reqbot-final.json`,
      `2) Run: curl.exe -sS -X POST "${callbackUrl}" -H "Content-Type: application/json" --data-binary "@$env:TEMP\\reqbot-final.json"`,
      '3) After successful POST, stop. Do not print extra wrappers around the JSON.',
      'If callback POST fails, retry until it succeeds.',
    ].join('\n')
  }

  private cleanupVisibleJobFiles(files: string[]): void {
    for (const file of files) {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
    }
  }

  private getOrCreateVisibleHost(key: string): VisibleHost {
    const normalized = key.trim().toLowerCase() || 'default'
    const safeKey = normalized.replace(/[^a-z0-9_-]/g, '_')
    let host = this.visibleHosts.get(safeKey)
    if (host) return host

    const queueRoot = path.join(this.visibleBaseRoot, safeKey)
    host = {
      key: safeKey,
      queueRoot,
      jobsDir: path.join(queueRoot, 'jobs'),
      pidFile: path.join(queueRoot, 'host.pid'),
      startPromise: null,
    }
    this.visibleHosts.set(safeKey, host)
    return host
  }

  private async ensureVisibleHost(host: VisibleHost, label: string): Promise<void> {
    if (host.startPromise) {
      await host.startPromise
      return
    }
    if (this.isVisibleHostRunning(host)) return

    host.startPromise = (async () => {
      fs.mkdirSync(host.queueRoot, { recursive: true })
      fs.mkdirSync(host.jobsDir, { recursive: true })

      const hostScript = path.resolve(__dirname, '../../src/tools/claude-visible-host.ts')
      const safeLabel = label.replace(/[^\x20-\x7E]/g, '').trim()
      const titleBase = safeLabel ? `${safeLabel}` : host.key
      const title = `Claude Queue: ${titleBase}`
      const hostArgs = [
        hostScript,
        '--queueDir', host.queueRoot,
        '--idleMs', String(VISIBLE_IDLE_TIMEOUT_MS),
        '--pidFile', host.pidFile,
      ]
      const tsxBin = this.getTsxBinPath()
      const projectRoot = path.resolve(__dirname, '../../')
      const scriptFile = path.join(os.tmpdir(), `reqbot-visible-host-${host.key}.ps1`)
      const psScript = [
        `Set-Location "${projectRoot.replace(/"/g, '""')}"`,
        `& "${tsxBin.replace(/"/g, '""')}" ${hostArgs.map(a => `"${a.replace(/"/g, '""')}"`).join(' ')}`,
      ].join('\n')
      fs.writeFileSync(scriptFile, '\ufeff' + psScript, 'utf8')

      log.info({ title }, 'Starting shared visible Claude window')
      const wt = spawn('wt', ['--title', title, 'powershell', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      wt.on('error', () => {
        spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }).unref()
      })
      wt.unref()
      await this.sleep(1500)
    })()

    try {
      await host.startPromise
    } finally {
      host.startPromise = null
    }
  }

  private isVisibleHostRunning(host: VisibleHost): boolean {
    try {
      if (!fs.existsSync(host.pidFile)) return false
      const pid = parseInt(fs.readFileSync(host.pidFile, 'utf8').trim(), 10)
      if (!pid || Number.isNaN(pid)) return false
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private buildInternalContextSection(context: HistoryContext): string {
    const internalListings = context.internalListings.slice(0, 5)
    const pastResults = context.pastResults.slice(0, 5)
    const lines: string[] = []

    if (internalListings.length > 0) {
      lines.push('INTERNAL INVENTORY (already fetched by the app):')
      for (const listing of internalListings) {
        const parts = [
          [listing.make, listing.model, listing.variant, listing.year].filter(Boolean).join(' '),
          listing.location ? `location=${listing.location}` : '',
          listing.price ? `price=${listing.price}` : '',
          listing.kmDriven ? `km=${listing.kmDriven}` : '',
          listing.contact ? `contact=${listing.contact}` : '',
        ].filter(Boolean)
        lines.push(`- ${parts.join(' | ')}`)
      }
      lines.push('')
    } else {
      lines.push('INTERNAL INVENTORY: no likely matches found locally.')
      lines.push('')
    }

    if (pastResults.length > 0) {
      lines.push('RECENT PAST EXTERNAL RESULTS (for context only, must re-verify if reused):')
      for (const result of pastResults) {
        const parts = [
          result.dealerName ?? 'Unknown seller',
          result.price ? `price=${result.price}` : '',
          result.link ? `link=${result.link}` : '',
          result.details ? `details=${sanitizeForPrompt(result.details)}` : '',
        ].filter(Boolean)
        lines.push(`- ${parts.join(' | ')}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private async processRequirementMessage(msg: IncomingMessage): Promise<MessageProcessResult> {
    const safeText = sanitizeForPrompt(msg.text)
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const locationStr = config.location || 'Demo City'
    const priorityStr = config.searchPriority || 'quality and condition first, then proximity to location, then price'
    const sitesStr = config.searchSites.join(', ')
    const context = store.getAgentContext(msg.text)
    const internalContextSection = this.buildInternalContextSection(context)

    const historySection = msg.groupHistory && msg.groupHistory.length > 0
      ? `\nRecent group chat:\n${msg.groupHistory.map(h => `  ${h.sender}: ${sanitizeForPrompt(h.text)}`).join('\n')}\n`
      : ''

    const prompt =
      `You are a silent assistant for a ${config.domainDescription} dealership in ${locationStr}.\n` +
      `You handle every incoming WhatsApp message in ONE pass.\n` +
      `If this is a direct chat with the owner, you may reply conversationally, answer follow-up questions about prior results, or handle a requirement/listing.\n` +
      `If this is a group message, stay task-focused.\n\n` +
      `MESSAGE\n` +
      `From: ${msg.sender ?? 'unknown'} | Chat: ${msg.groupName ?? msg.groupId}\n` +
      `Direct chat: ${msg.isDirectChat ? 'yes' : 'no'}\n` +
      `Text: """${safeText}"""\n` +
      `Has images: ${hasImages}` +
      historySection + `\n` +
      `${internalContextSection}` +
      `STEP 1 — CLASSIFY\n` +
      `Decide: reply | requirement | listing | irrelevant | needs_clarification\n` +
      `- reply: normal direct-chat reply, follow-up on previous results, or status-style conversational response\n` +
      `- requirement: ANY expression of wanting/needing a car\n` +
      `- listing: clearly selling/offering a car\n` +
      `- irrelevant: pure chat\n` +
      `- needs_clarification: genuinely unclear\n\n` +
      `STEP 2 — ACT\n` +
      `If REPLY:\n` +
      `  - answer naturally and concisely\n` +
      `  - if the user refers to earlier search results, use the visible context in this chat\n\n` +
      `If REQUIREMENT:\n` +
      `  - Location preference: ${locationStr}\n` +
      `  - Priority: ${priorityStr}\n` +
      `  - Use INTERNAL INVENTORY above first.\n` +
      `  - Then search ONLY these sites if needed: ${sitesStr}\n` +
      `  - Re-verify any past external result before returning it.\n` +
      `  - If internal inventory is empty or insufficient, you MUST search at least 2 allowed external sites before returning.\n` +
      `  - Do NOT stop after merely extracting the requirement details.\n` +
      `  - Always include searched_sites for a real search result.\n` +
      `  - If no matches exist, explain why in summary.\n\n` +
      `If LISTING with weak signals, treat as requirement.\n` +
      `If LISTING with clear signals, extract fields.\n\n` +
      `STEP 3 — Reply ONLY valid JSON in one of the expected shapes.\n` +
      `For reply use: {"type":"reply","reply":"..."}` +
      `\nFor requirement use: {"type":"requirement","matches":[...],"summary":"...","searched_sites":["site1","site2"]}` 

    log.info({
      sender: msg.sender,
      text: safeText.slice(0, 60),
      internalMatches: context.internalListings.length,
      pastResults: context.pastResults.length,
    }, 'Processing requirement-capable message')

    const raw = await this.callCliVisible(prompt, {
      timeoutMs: CLI_TIMEOUT_LONG,
      allowTools: ['WebSearch', 'WebFetch'],
      label: `${msg.groupName ?? 'group'} | ${msg.sender ?? ''}`,
      hostKey: `${msg.source}:${msg.groupId ?? 'direct'}`,
    })

    const parsed = this.parseProcessMessageResult(msg, raw)
    if (
      parsed.type === 'requirement' &&
      parsed.result.matches.length === 0 &&
      parsed.result.searchedSites.length === 0 &&
      context.internalListings.length === 0 &&
      !msg.isDirectChat
    ) {
      log.info({ text: safeText.slice(0, 60) }, 'Single-pass result lacked real search output, falling back to dedicated search flow')
      const fallback = await this.processRequirement(msg.id, msg.text, context)
      return { type: 'requirement', result: fallback }
    }

    return parsed
  }

  private parseProcessMessageResult(msg: IncomingMessage, raw: string): MessageProcessResult {
    log.info({ rawLength: raw.length, rawPreview: raw.slice(0, 300) }, 'processMessage raw output')

    let parsed: any = null
    try { parsed = JSON.parse(raw.trim()) } catch { /* try fallback */ }
    if (!parsed) {
      const stripped = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
      try { parsed = JSON.parse(stripped) } catch { /* ignore */ }
      if (!parsed) {
        try { parsed = JSON.parse(this.fixLooseJsonEscapes(stripped)) } catch { /* ignore */ }
      }
    }
    if (!parsed) {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start !== -1 && end > start) {
        const candidate = raw.slice(start, end + 1)
        try { parsed = JSON.parse(candidate) } catch { /* ignore */ }
        if (!parsed) {
          try { parsed = JSON.parse(this.fixLooseJsonEscapes(candidate)) } catch { /* ignore */ }
        }
      }
    }

    const parsedTypeRaw =
      typeof parsed?.type === 'string'
        ? parsed.type
        : typeof parsed?.classification === 'string'
          ? parsed.classification
          : null
    const parsedType = typeof parsedTypeRaw === 'string'
      ? parsedTypeRaw.trim().toLowerCase().replace(/\s+/g, '_')
      : null

    if (!parsed || !parsedType) {
      log.warn(
        {
          rawLength: raw.length,
          raw: raw.slice(0, 500),
          parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 15) : [],
        },
        'Could not parse or classify processMessage result',
      )
      return { type: 'irrelevant' }
    }

    if (parsedType === 'reply') {
      return { type: 'reply', reply: typeof parsed.reply === 'string' ? parsed.reply : 'Okay.' }
    }
    if (parsedType === 'rate_limited') throw new Error('RATE_LIMIT_DETECTED')
    if (parsedType === 'irrelevant') return { type: 'irrelevant' }
    if (parsedType === 'needs_clarification') return { type: 'needs_clarification' }

    if (parsedType === 'listing') {
      const listing = (parsed && typeof parsed.listing === 'object' && parsed.listing) ? parsed.listing : parsed
      return {
        type: 'listing',
        listing: {
          make: listing.make ?? undefined,
          model: listing.model ?? undefined,
          variant: listing.variant ?? undefined,
          year: typeof listing.year === 'number' ? listing.year : undefined,
          fuelType: listing.fuel_type ?? undefined,
          color: listing.color ?? undefined,
          kmDriven: typeof listing.km_driven === 'number' ? listing.km_driven : undefined,
          price: listing.price ?? undefined,
          conditionRating: listing.condition_rating ?? undefined,
          location: listing.location ?? undefined,
          contact: listing.contact ?? undefined,
          extraDetails: listing.extra_details ?? undefined,
        },
      }
    }

    if (parsedType === 'requirement') {
      const rawMatches: any[] = Array.isArray(parsed.matches)
        ? parsed.matches
        : Array.isArray(parsed.external_listings)
          ? parsed.external_listings
          : []
      const matches: Match[] = rawMatches
        .filter((m: any) => m && typeof m === 'object')
        .map((m: any) => ({
          dealerName:
            typeof m.dealer_name === 'string'
              ? m.dealer_name
              : typeof m.dealerName === 'string'
                ? m.dealerName
                : typeof m.title === 'string'
                  ? m.title
                  : undefined,
          link:
            typeof m.link === 'string'
              ? m.link
              : typeof m.url === 'string'
                ? m.url
                : undefined,
          price:
            typeof m.price === 'string'
              ? m.price
              : typeof m.price === 'number'
                ? String(m.price)
                : undefined,
          details:
            typeof m.details === 'string'
              ? m.details
              : typeof m.description === 'string'
                ? m.description
                : typeof m.title === 'string'
                  ? m.title
                  : '',
          confidence: (['high', 'medium', 'low'] as const).includes(m.confidence) ? m.confidence : 'medium',
          location:
            typeof m.location === 'string'
              ? m.location
              : typeof m.city === 'string'
                ? m.city
                : undefined,
          source: 'external_site' as const,
        }))

      return {
        type: 'requirement',
        result: {
          requirementId: msg.id,
          requirementText: msg.text,
          matches,
          summary:
            typeof parsed.summary === 'string'
              ? parsed.summary
              : typeof parsed.search_summary === 'string'
                ? parsed.search_summary
                : 'Search completed.',
          searchedSites: Array.isArray(parsed.searched_sites)
            ? parsed.searched_sites
            : Array.isArray(parsed.searchedSites)
              ? parsed.searchedSites
              : [],
          searchedAt: Date.now(),
        },
      }
    }

    return { type: 'irrelevant' }
  }

  private fixLooseJsonEscapes(input: string): string {
    let out = ''
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]
      if (ch !== '\\') {
        out += ch
        continue
      }

      const next = input[i + 1]
      if (!next) {
        out += '\\\\'
        continue
      }

      if ('"\\/bfnrtu'.includes(next)) {
        out += ch + next
        i++
        continue
      }

      out += '\\\\' + next
      i++
    }
    return out
  }

  getRuntimeStatus(): string {
    const parts: string[] = []
    for (const host of this.visibleHosts.values()) {
      const running = this.isVisibleHostRunning(host)
      let queued = 0
      try {
        if (fs.existsSync(host.jobsDir)) {
          queued = fs.readdirSync(host.jobsDir).filter(name => name.endsWith('.json')).length
        }
      } catch {
        queued = 0
      }
      parts.push(`${host.key}: ${running ? 'running' : 'stopped'}, queued=${queued}`)
    }
    const base = parts.length > 0 ? `Subagents: ${parts.join(' | ')}` : 'Subagents: none started'
    return `${base} | callbacks_pending=${getClaudeCallbackPendingCount()}`
  }

  async classifyMessage(msg: IncomingMessage): Promise<MessageType> {
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const prompt = buildClassifierPrompt(msg.text, hasImages, msg.groupHistory)
    const raw = await this.callCliHidden(prompt, { timeoutMs: CLI_TIMEOUT_SHORT })
    const text = raw.toLowerCase()
    if (text.includes('requirement')) return 'requirement'
    if (text.includes('listing')) return 'listing'
    if (text.includes('clarification')) return 'needs_clarification'
    return 'irrelevant'
  }

  async extractListing(msg: IncomingMessage): Promise<CarListing> {
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const prompt = buildListingExtractorPrompt(msg.text, hasImages)
    const raw = await this.callCliHidden(prompt, { timeoutMs: CLI_TIMEOUT_SHORT })
    return this.parseListingJson(raw)
  }

  private parseListingJson(raw: string): CarListing {
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try {
      const parsed = JSON.parse(jsonStr)
      return {
        make: parsed.make ?? undefined,
        model: parsed.model ?? undefined,
        variant: parsed.variant ?? undefined,
        year: typeof parsed.year === 'number' ? parsed.year : undefined,
        fuelType: parsed.fuel_type ?? undefined,
        color: parsed.color ?? undefined,
        kmDriven: typeof parsed.km_driven === 'number' ? parsed.km_driven : undefined,
        price: parsed.price ?? undefined,
        conditionRating: parsed.condition_rating ?? undefined,
        location: parsed.location ?? undefined,
        contact: parsed.contact ?? undefined,
        extraDetails: parsed.extra_details && typeof parsed.extra_details === 'object' ? parsed.extra_details : undefined,
      }
    } catch {
      log.warn('Failed to parse listing JSON — storing raw response')
      return { extraDetails: { raw_response: raw.slice(0, 500) } }
    }
  }

  async processRequirement(
    requirementId: string,
    requirementText: string,
    context: HistoryContext
  ): Promise<AgentResult> {
    const allMatches: Match[] = []
    const safeReq = sanitizeForPrompt(requirementText)
    const sitesStr = config.searchSites.join(', ')
    const locationStr = config.location || 'Demo City'
    const priorityStr = config.searchPriority || 'quality and condition first, then proximity to location, then price'
    const internalContextSection = this.buildInternalContextSection(context)

    const prompt =
      `You are a used car search agent for a dealership based in ${locationStr}.\n\n` +
      `REQUIREMENT: "${safeReq}"\n\n` +
      `LOCATION PREFERENCE: ${locationStr} and surrounding areas.\n` +
      `RANKING PRIORITY: ${priorityStr}\n\n` +
      `${internalContextSection}` +
      `ALLOWED WEBSITES (search ONLY these):\n${sitesStr}\n\n` +
      `Use the INTERNAL INVENTORY above first.\n` +
      `Use WebSearch / WebFetch only when you need external verification or additional matches.\n\n` +
      `Return ONLY JSON:\n` +
      `{"matches":[{"dealer_name":"...","link":"https://...","price":"...","details":"...","confidence":"high|medium|low","location":"..."}],"summary":"...","searched_sites":["site1"]}`

    log.info({ requirement: safeReq }, 'Sending search task to claude CLI')

    let summary = 'Search completed.'
    const searchedSites: string[] = []

    try {
      const raw = await this.callCliVisible(prompt, {
        timeoutMs: CLI_TIMEOUT_LONG,
        allowTools: ['WebSearch', 'WebFetch'],
        label: 'search',
        hostKey: 'search',
      })
      const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed = JSON.parse(json)
      if (typeof parsed.summary === 'string') summary = parsed.summary
      if (Array.isArray(parsed.searched_sites)) searchedSites.push(...parsed.searched_sites)
      if (Array.isArray(parsed.matches)) {
        for (const m of parsed.matches) {
          if (typeof m !== 'object' || m === null) continue
          allMatches.push({
            dealerName: typeof m.dealer_name === 'string' ? m.dealer_name : undefined,
            link: typeof m.link === 'string' ? m.link : undefined,
            price: typeof m.price === 'string' ? m.price : undefined,
            details: typeof m.details === 'string' ? m.details : '',
            confidence: (['high', 'medium', 'low'] as const).includes(m.confidence) ? m.confidence : 'medium',
            location: typeof m.location === 'string' ? m.location : undefined,
            source: 'external_site',
          })
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to parse search results from claude CLI')
      summary = 'Search completed but results could not be parsed.'
    }

    return {
      requirementId,
      requirementText,
      matches: allMatches,
      summary,
      searchedSites,
      searchedAt: Date.now(),
    }
  }

  async processMessage(msg: IncomingMessage): Promise<MessageProcessResult> {
    return this.processRequirementMessage(msg)
  }
}
