import Anthropic from '@anthropic-ai/sdk'
import * as cheerio from 'cheerio'
import { config, isAllowedSite, isAllowedSiteName } from '../config'
import { CarListing, HistoryContext } from '../history/store'
import { buildClassifierPrompt, buildListingExtractorPrompt, buildSearchSystemPrompt, sanitizeForPrompt } from '../prompt-builder'
import { AgentResult, BaseAgent, IncomingMessage, Match, MessageType } from './base-agent'
import { createLogger } from '../logger'

const log = createLogger('claude-agent')
const FETCH_TIMEOUT_MS = 15_000
const MAX_LOOPS = 15

export class ClaudeAgent extends BaseAgent {
  private client: Anthropic

  constructor() {
    super()
    this.client = new Anthropic({ apiKey: config.anthropicApiKey })
  }

  // ── Classify ───────────────────────────────────────────────────────────────

  async classifyMessage(msg: IncomingMessage): Promise<MessageType> {
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const prompt = buildClassifierPrompt(msg.text, hasImages, msg.groupHistory)

    const response = await this.client.messages.create({
      model: config.aiModel,
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    })

    const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined
    const text = textBlock?.text?.trim().toLowerCase() ?? ''
    if (text.includes('requirement')) return 'requirement'
    if (text.includes('listing')) return 'listing'
    return 'irrelevant'
  }

  // ── Extract listing ────────────────────────────────────────────────────────

  async extractListing(msg: IncomingMessage): Promise<CarListing> {
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const textPrompt = buildListingExtractorPrompt(msg.text, hasImages)

    const contentBlocks: Anthropic.MessageParam['content'] = []

    for (const b64 of msg.imageBase64 ?? []) {
      // Validate base64 size before sending to API
      const sizeBytes = Math.ceil(b64.length * 0.75)
      if (sizeBytes > config.maxImageSizeBytes) {
        log.warn({ sizeBytes, max: config.maxImageSizeBytes }, 'Image too large, skipping')
        continue
      }
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
      })
    }

    contentBlocks.push({ type: 'text', text: textPrompt })

    const response = await this.client.messages.create({
      model: config.aiModel,
      max_tokens: 1000,
      messages: [{ role: 'user', content: contentBlocks }],
    })

    const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined
    const raw = textBlock?.text?.trim() ?? '{}'

    return this.parseListingJson(raw)
  }

  private parseListingJson(raw: string): CarListing {
    // Strip markdown code fences
    const jsonStr = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()

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
        extraDetails: parsed.extra_details && typeof parsed.extra_details === 'object'
          ? parsed.extra_details
          : undefined,
      }
    } catch (err) {
      log.warn({ err }, 'Failed to parse listing JSON — returning raw as extra_details')
      return { extraDetails: { raw_response: raw.slice(0, 500) } }
    }
  }

  // ── Process requirement (agentic tool-use loop) ───────────────────────────

  async processRequirement(
    requirementId: string,
    requirementText: string,
    context: HistoryContext
  ): Promise<AgentResult> {
    const systemPrompt = buildSearchSystemPrompt(context)
    const searchedSites = new Set<string>()
    const allMatches: Match[] = []

    // Internal listings as immediate high-confidence matches
    for (const listing of context.internalListings) {
      allMatches.push({
        dealerName: listing.sender,
        details: [
          listing.make, listing.model, listing.variant,
          listing.year, listing.color,
          listing.kmDriven != null ? `${listing.kmDriven.toLocaleString()} km` : null,
          listing.conditionRating
        ].filter(Boolean).join(', '),
        price: listing.price,
        confidence: 'high',
        source: 'internal_listing',
        internalListing: listing,
      })
    }

    const tools: Anthropic.Tool[] = [
      {
        name: 'web_search',
        description: 'Search a specific allowed website for listings matching the requirement',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'The search query' },
            site: { type: 'string', description: `Must be one of: ${config.searchSites.join(', ')}` },
          },
          required: ['query', 'site'],
        },
      },
      {
        name: 'scrape_page',
        description: 'Fetch and read the content of a listing page from an allowed site',
        input_schema: {
          type: 'object' as const,
          properties: {
            url: { type: 'string', description: 'Full URL of the listing page' },
          },
          required: ['url'],
        },
      },
      {
        name: 'report_results',
        description: 'Submit your final search results and end the session',
        input_schema: {
          type: 'object' as const,
          properties: {
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  dealer_name: { type: 'string' },
                  link: { type: 'string' },
                  price: { type: 'string' },
                  details: { type: 'string' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
                required: ['details', 'confidence'],
              },
            },
            summary: { type: 'string' },
          },
          required: ['matches', 'summary'],
        },
      },
    ]

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Find matches for this requirement: "${sanitizeForPrompt(requirementText)}"`,
      },
    ]

    let summary = 'Search completed.'
    let loopCount = 0
    let done = false

    while (loopCount < MAX_LOOPS && !done) {
      loopCount++

      const response = await this.client.messages.create({
        model: config.aiModel,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      })

      const toolUses = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]

      if (toolUses.length === 0) {
        const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined
        if (textBlock) summary = textBlock.text
        break
      }

      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const tool of toolUses) {
        let result = ''

        // Safely parse tool input
        let input: Record<string, unknown>
        try {
          input = typeof tool.input === 'object' && tool.input !== null
            ? tool.input as Record<string, unknown>
            : {}
        } catch {
          input = {}
        }

        if (tool.name === 'report_results') {
          summary = typeof input['summary'] === 'string' ? input['summary'] : summary
          const matches = Array.isArray(input['matches']) ? input['matches'] : []

          for (const m of matches) {
            if (typeof m !== 'object' || m === null) continue
            const match = m as Record<string, unknown>
            allMatches.push({
              dealerName: typeof match['dealer_name'] === 'string' ? match['dealer_name'] : undefined,
              link: typeof match['link'] === 'string' ? match['link'] : undefined,
              price: typeof match['price'] === 'string' ? match['price'] : undefined,
              details: typeof match['details'] === 'string' ? match['details'] : '',
              confidence: (['high', 'medium', 'low'] as const).includes(match['confidence'] as any)
                ? match['confidence'] as 'high' | 'medium' | 'low'
                : 'medium',
              source: 'external_site',
            })
          }

          result = 'Results submitted. Session complete.'
          done = true

        } else if (tool.name === 'web_search') {
          const query = typeof input['query'] === 'string' ? input['query'] : ''
          const site = typeof input['site'] === 'string' ? input['site'] : ''
          result = await this.safeWebSearch(query, site, searchedSites)

        } else if (tool.name === 'scrape_page') {
          const url = typeof input['url'] === 'string' ? input['url'] : ''
          result = await this.safeScrape(url)
        }

        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result })
      }

      messages.push({ role: 'user', content: toolResults })
    }

    return {
      requirementId,
      requirementText,
      matches: allMatches,
      summary,
      searchedSites: Array.from(searchedSites),
      searchedAt: Date.now(),
    }
  }

  // ── Tool implementations ───────────────────────────────────────────────────

  private async safeWebSearch(query: string, site: string, searchedSites: Set<string>): Promise<string> {
    if (!query.trim()) return 'ERROR: Empty query'

    // Exact hostname match — prevents "car.attacker.com" from passing "car" allowlist
    if (!isAllowedSiteName(site, config.searchSites)) {
      return `ERROR: Site "${site}" is not in the allowed list. Only search: ${config.searchSites.join(', ')}`
    }

    searchedSites.add(site)

    const encodedQuery = encodeURIComponent(`${query} site:${site}`)
    const searchUrl = `https://www.google.com/search?q=${encodedQuery}&num=10`

    try {
      const html = await this.fetchHtml(searchUrl)
      const $ = cheerio.load(html)

      const results: string[] = []
      $('div.g').slice(0, 8).each((_, el) => {
        const title = $(el).find('h3').first().text().trim()
        const link = $(el).find('a').first().attr('href') ?? ''
        const snippet = $(el).find('.VwiC3b, .st').first().text().trim()
        if (title && (link.startsWith('http') || link.startsWith('/'))) {
          results.push(`Title: ${title}\nURL: ${link}\nSnippet: ${snippet}`)
        }
      })

      if (results.length === 0) {
        return `No results found on ${site} for: "${query}"`
      }
      return `Results from ${site} for "${query}":\n\n${results.join('\n\n---\n\n')}`
    } catch (err: any) {
      log.warn({ site, query }, `Web search failed: ${err.message}`)
      return `Search failed for ${site}: ${err.message}`
    }
  }

  private async safeScrape(url: string): Promise<string> {
    if (!url.trim()) return 'ERROR: Empty URL'

    // Validate against full URL — blocks subdomain attacks
    if (!isAllowedSite(url, config.searchSites)) {
      return `ERROR: Cannot scrape "${url}" — not in allowed sites list.`
    }

    try {
      const html = await this.fetchHtml(url)
      const $ = cheerio.load(html)
      $('script, style, nav, footer, header, .ads, #ads').remove()
      const text = $('main, article, .listing, .car-detail, body')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000)
      return text || 'Page content could not be extracted.'
    } catch (err: any) {
      log.warn({ url }, `Scrape failed: ${err.message}`)
      return `Scrape failed: ${err.message}`
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const { default: fetch } = await import('node-fetch')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        signal: controller.signal as any,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    } finally {
      clearTimeout(timer)
    }
  }
}
