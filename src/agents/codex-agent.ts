import OpenAI from 'openai'
import * as cheerio from 'cheerio'
import { config, isAllowedSite, isAllowedSiteName } from '../config'
import { CarListing, HistoryContext } from '../history/store'
import { buildClassifierPrompt, buildListingExtractorPrompt, buildSearchSystemPrompt } from '../prompt-builder'
import { AgentResult, BaseAgent, IncomingMessage, Match, MessageType } from './base-agent'
import { createLogger } from '../logger'

const log = createLogger('codex-agent')

export class CodexAgent extends BaseAgent {
  private client: OpenAI

  constructor() {
    super()
    this.client = new OpenAI({ apiKey: config.openaiApiKey })
  }

  async classifyMessage(msg: IncomingMessage): Promise<MessageType> {
    const prompt = buildClassifierPrompt(msg.text, (msg.imageBase64?.length ?? 0) > 0)
    const response = await this.client.chat.completions.create({
      model: config.aiModel,
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = response.choices[0]?.message?.content?.trim().toLowerCase() ?? ''
    if (text.includes('requirement')) return 'requirement'
    if (text.includes('listing')) return 'listing'
    return 'irrelevant'
  }

  async extractListing(msg: IncomingMessage): Promise<CarListing> {
    const hasImages = (msg.imageBase64?.length ?? 0) > 0
    const textPrompt = buildListingExtractorPrompt(msg.text, hasImages)

    const content: OpenAI.ChatCompletionContentPart[] = []

    for (const b64 of msg.imageBase64 ?? []) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      })
    }
    content.push({ type: 'text', text: textPrompt })

    const response = await this.client.chat.completions.create({
      model: config.aiModel,
      max_tokens: 1000,
      messages: [{ role: 'user', content }],
    })

    const raw = response.choices[0]?.message?.content?.trim() ?? '{}'
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

    try {
      const parsed = JSON.parse(jsonStr)
      return {
        make: parsed.make ?? undefined,
        model: parsed.model ?? undefined,
        variant: parsed.variant ?? undefined,
        year: parsed.year ?? undefined,
        fuelType: parsed.fuel_type ?? undefined,
        color: parsed.color ?? undefined,
        kmDriven: parsed.km_driven ?? undefined,
        price: parsed.price ?? undefined,
        conditionRating: parsed.condition_rating ?? undefined,
        location: parsed.location ?? undefined,
        contact: parsed.contact ?? undefined,
        extraDetails: parsed.extra_details ?? undefined,
      }
    } catch {
      return { extraDetails: { raw_response: raw } }
    }
  }

  async processRequirement(
    requirementId: string,
    requirementText: string,
    context: HistoryContext
  ): Promise<AgentResult> {
    const systemPrompt = buildSearchSystemPrompt(context)
    const searchedSites = new Set<string>()
    const allMatches: Match[] = []

    // Add internal listings immediately
    for (const listing of context.internalListings) {
      allMatches.push({
        dealerName: listing.sender,
        details: [listing.make, listing.model, listing.variant, listing.year, listing.color].filter(Boolean).join(', '),
        price: listing.price,
        confidence: 'high',
        source: 'internal_listing',
        internalListing: listing,
      })
    }

    const tools: OpenAI.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search an allowed website for matching listings',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              site: { type: 'string', description: `One of: ${config.searchSites.join(', ')}` },
            },
            required: ['query', 'site'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'scrape_page',
          description: 'Fetch content of a listing page from an allowed site',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'report_results',
          description: 'Submit final results and end session',
          parameters: {
            type: 'object',
            properties: {
              matches: { type: 'array', items: { type: 'object' } },
              summary: { type: 'string' },
            },
            required: ['matches', 'summary'],
          },
        },
      },
    ]

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Find matches for this requirement: "${requirementText}"` },
    ]

    let summary = 'Search completed.'
    let loopCount = 0

    while (loopCount < 15) {
      loopCount++
      const response = await this.client.chat.completions.create({
        model: config.aiModel,
        max_tokens: 4096,
        tools,
        messages,
      })

      const choice = response.choices[0]!
      messages.push(choice.message)

      if (!choice.message.tool_calls?.length || choice.finish_reason === 'stop') break

      const toolResults: OpenAI.ChatCompletionToolMessageParam[] = []

      for (const call of choice.message.tool_calls) {
        const args = JSON.parse(call.function.arguments)
        let result = ''

        if (call.function.name === 'report_results') {
          summary = args.summary ?? summary
          for (const m of args.matches ?? []) {
            allMatches.push({ dealerName: m.dealer_name, link: m.link, price: m.price, details: m.details, confidence: m.confidence ?? 'medium', source: 'external_site' })
          }
          result = 'Done.'
          toolResults.push({ role: 'tool', tool_call_id: call.id, content: result })
          messages.push(...toolResults)
          loopCount = 15
          break
        } else if (call.function.name === 'web_search') {
          result = await this.safeWebSearch(args.query, args.site, searchedSites)
        } else if (call.function.name === 'scrape_page') {
          result = await this.safeScrape(args.url)
        }

        toolResults.push({ role: 'tool', tool_call_id: call.id, content: result })
      }

      if (toolResults.length > 0 && loopCount < 15) messages.push(...toolResults)
    }

    return { requirementId, requirementText, matches: allMatches, summary, searchedSites: Array.from(searchedSites), searchedAt: Date.now() }
  }

  private async fetchHtml(url: string): Promise<string> {
    const { default: fetch } = await import('node-fetch')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(url, { signal: controller.signal as any, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    } finally { clearTimeout(timer) }
  }

  private async safeWebSearch(query: string, site: string, searchedSites: Set<string>): Promise<string> {
    if (!query.trim()) return 'ERROR: Empty query'
    if (!isAllowedSiteName(site, config.searchSites)) return `ERROR: Site "${site}" not allowed. Use: ${config.searchSites.join(', ')}`
    searchedSites.add(site)
    try {
      const html = await this.fetchHtml(`https://www.google.com/search?q=${encodeURIComponent(`${query} site:${site}`)}&num=10`)
      const $ = cheerio.load(html)
      const results: string[] = []
      $('div.g').slice(0, 8).each((_, el) => {
        const title = $(el).find('h3').text()
        const link = $(el).find('a').attr('href') ?? ''
        const snippet = $(el).find('.VwiC3b').text()
        if (title) results.push(`${title}\n${link}\n${snippet}`)
      })
      return results.join('\n---\n') || `No results for "${query}" on ${site}`
    } catch (err: any) { return `Search failed: ${err.message}` }
  }

  private async safeScrape(url: string): Promise<string> {
    if (!url.trim()) return 'ERROR: Empty URL'
    if (!isAllowedSite(url, config.searchSites)) return `ERROR: Cannot scrape "${url}"`
    try {
      const html = await this.fetchHtml(url)
      const $ = cheerio.load(html)
      $('script, style, nav, footer').remove()
      return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000)
    } catch (err: any) { return `Scrape failed: ${err.message}` }
  }
}
