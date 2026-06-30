import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config()

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback
}

function list(key: string, fallback: string[] = []): string[] {
  const val = process.env[key]
  if (!val) return fallback
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

export function parseGroupNames(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  return Object.fromEntries(
    raw.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(pair => {
        const eqIdx = pair.indexOf('=')
        if (eqIdx < 0) return null
        const k = pair.slice(0, eqIdx).trim()
        const v = pair.slice(eqIdx + 1).trim()
        return k && v ? [k, v] : null
      })
      .filter((entry): entry is [string, string] => entry !== null)
  )
}

function safeResolvePath(raw: string, base: string): string {
  const resolved = path.resolve(raw)
  // Allow absolute paths within common working dirs, but block obvious traversal like /etc
  // Primarily guards against DB_PATH=/etc/passwd style attacks
  if (resolved.startsWith('/etc') || resolved.startsWith('/proc') || resolved.startsWith('/sys')) {
    throw new Error(`Unsafe path in configuration: ${raw}`)
  }
  return resolved
}

function clampInt(value: number, min: number, max: number, name: string): number {
  if (isNaN(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got: ${value}`)
  }
  return value
}

export type InputSource = 'whatsapp' | 'telegram' | 'both'
export type OutputTarget = 'telegram' | 'whatsapp' | 'both'
export type AIProvider = 'claude' | 'codex' | 'ollama' | 'claude-cli'
export type Domain = 'used_cars' | 'real_estate' | 'custom'
export type RequirementReplyMode = 'combined' | 'per_match'

export interface Config {
  inputSource: InputSource
  waAllowedGroups: string[]
  waGroupNames: Record<string, string>
  tgAllowedGroups: string[]
  tgBotToken: string
  outputTarget: OutputTarget
  waOutputTargets: string[]
  tgOutputTargets: string[]
  aiProvider: AIProvider
  aiModel: string
  anthropicApiKey: string
  openaiApiKey: string
  ollamaBaseUrl: string
  ollamaModel: string
  domain: Domain
  domainDescription: string
  searchSites: string[]
  location: string           // preferred search location e.g. "Demo City"
  searchPriority: string     // ranking preference e.g. "quality, distance, price"
  dailyResetHour: number
  maxConcurrentAgents: number
  dbPath: string
  imagesDir: string
  logLevel: string
  logPretty: boolean
  maxImageSizeBytes: number
  requirementReplyMode: RequirementReplyMode
  claudeCallbackPort: number
}

export const config: Config = {
  inputSource: (optional('INPUT_SOURCE', 'telegram')) as InputSource,
  waAllowedGroups: list('WA_ALLOWED_GROUPS'),
  waGroupNames: parseGroupNames(process.env['WA_GROUP_NAMES']),
  tgAllowedGroups: list('TG_ALLOWED_GROUPS'),
  tgBotToken: optional('TG_BOT_TOKEN', ''),
  outputTarget: (optional('OUTPUT_TARGET', 'telegram')) as OutputTarget,
  waOutputTargets: list('WA_OUTPUT_TARGETS'),
  tgOutputTargets: list('TG_OUTPUT_TARGETS'),
  aiProvider: (optional('AI_PROVIDER', 'claude')) as AIProvider,
  aiModel: optional('AI_MODEL', 'claude-opus-4-8'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  openaiApiKey: optional('OPENAI_API_KEY', ''),
  ollamaBaseUrl: optional('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaModel: optional('OLLAMA_MODEL', 'llama3.1'),
  domain: (optional('DOMAIN', 'used_cars')) as Domain,
  domainDescription: optional('DOMAIN_DESCRIPTION', 'used cars and vehicles'),
  searchSites: list('SEARCH_SITES', ['pakwheels.com', 'olx.com.pk']),
  location: optional('LOCATION', ''),
  searchPriority: optional('SEARCH_PRIORITY', 'quality, distance, price'),
  dailyResetHour: clampInt(parseInt(optional('DAILY_RESET_HOUR', '0'), 10), 0, 23, 'DAILY_RESET_HOUR'),
  maxConcurrentAgents: clampInt(parseInt(optional('MAX_CONCURRENT_AGENTS', '1'), 10), 1, 10, 'MAX_CONCURRENT_AGENTS'),
  dbPath: safeResolvePath(optional('DB_PATH', './data/requirement-bot.db'), process.cwd()),
  imagesDir: safeResolvePath(optional('IMAGES_DIR', './data/images'), process.cwd()),
  logLevel: optional('LOG_LEVEL', 'info'),
  logPretty: optional('LOG_PRETTY', 'true') === 'true',
  maxImageSizeBytes: parseInt(optional('MAX_IMAGE_SIZE_BYTES', String(5 * 1024 * 1024)), 10), // 5 MB default
  requirementReplyMode: (optional('REQUIREMENT_REPLY_MODE', 'combined')) as RequirementReplyMode,
  claudeCallbackPort: clampInt(parseInt(optional('CLAUDE_CALLBACK_PORT', '8787'), 10), 1, 65535, 'CLAUDE_CALLBACK_PORT'),
}

export function getGroupName(jidOrId: string): string {
  return config.waGroupNames[jidOrId] ?? jidOrId
}

/** Validate that a given URL hostname exactly matches or is a subdomain of an allowed site */
export function isAllowedSite(url: string, allowedSites: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return allowedSites.some(site => {
      const s = site.toLowerCase().replace(/^https?:\/\//, '')
      return hostname === s || hostname.endsWith(`.${s}`)
    })
  } catch {
    return false
  }
}

/** Validate a site name (not a full URL) against the whitelist */
export function isAllowedSiteName(siteName: string, allowedSites: string[]): boolean {
  const s = siteName.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  return allowedSites.some(allowed => {
    const a = allowed.toLowerCase()
    // Exact match only — "car" does NOT allow "car.attacker.com"
    return s === a
  })
}
