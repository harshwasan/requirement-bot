import { config, isAllowedSite, isAllowedSiteName } from '../config'
import { CarListing, HistoryContext } from '../history/store'
import { buildClassifierPrompt, buildListingExtractorPrompt, buildSearchSystemPrompt } from '../prompt-builder'
import { AgentResult, BaseAgent, IncomingMessage, Match, MessageType } from './base-agent'
import { createLogger } from '../logger'
import * as cheerio from 'cheerio'

const log = createLogger('ollama-agent')

/**
 * Ollama agent — uses local open-source models via the Ollama HTTP API.
 * Note: Image/vision support depends on the model (e.g. llava supports vision).
 * Tool use is handled manually via JSON parsing since Ollama's function calling
 * support varies by model. We use a ReAct-style loop instead.
 */
export class OllamaAgent extends BaseAgent {
  private baseUrl: string
  private model: string

  constructor() {
    super()
    this.baseUrl = config.ollamaBaseUrl
    this.model = config.ollamaModel
  }

  private async chat(messages: { role: string; content: string }[], maxTokens = 2000): Promise<string> {
    const { default: fetch } = await import('node-fetch')
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    })
    const data = await res.json() as any
    return data.message?.content ?? ''
  }

  async classifyMessage(msg: IncomingMessage): Promise<MessageType> {
    const prompt = buildClassifierPrompt(msg.text, (msg.imageBase64?.length ?? 0) > 0)
    const response = await this.chat([{ role: 'user', content: prompt }], 10)
    const text = response.trim().toLowerCase()
    if (text.includes('requirement')) return 'requirement'
    if (text.includes('listing')) return 'listing'
    return 'irrelevant'
  }

  async extractListing(msg: IncomingMessage): Promise<CarListing> {
    const prompt = buildListingExtractorPrompt(msg.text, (msg.imageBase64?.length ?? 0) > 0)
    const raw = await this.chat([{ role: 'user', content: prompt }], 1000)
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    try {
      const parsed = JSON.parse(jsonStr)
      return {
        make: parsed.make, model: parsed.model, variant: parsed.variant,
        year: parsed.year, fuelType: parsed.fuel_type, color: parsed.color,
        kmDriven: parsed.km_driven, price: parsed.price,
        conditionRating: parsed.condition_rating, location: parsed.location,
        contact: parsed.contact, extraDetails: parsed.extra_details,
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

    // Internal listings as immediate matches
    for (const listing of context.internalListings) {
      allMatches.push({
        dealerName: listing.sender,
        details: [listing.make, listing.model, listing.year, listing.color].filter(Boolean).join(', '),
        price: listing.price,
        confidence: 'high',
        source: 'internal_listing',
        internalListing: listing,
      })
    }

    // ReAct-style loop for models without native function calling
    const messages = [
      {
        role: 'system', content: systemPrompt + `

When you want to use a tool, output EXACTLY this format (no other text on those lines):
ACTION: tool_name
INPUT: {"key": "value"}

When you are done and want to submit results, output:
ACTION: report_results
INPUT: {"matches": [...], "summary": "..."}

After submitting, stop.`
      },
      { role: 'user', content: `Find matches for: "${requirementText}"` },
    ]

    let summary = 'Search completed.'
    let loopCount = 0

    while (loopCount < 10) {
      loopCount++
      const response = await this.chat(messages, 2000)
      messages.push({ role: 'assistant', content: response })

      const actionMatch = response.match(/ACTION:\s*(\w+)\s*\nINPUT:\s*(\{[\s\S]*?\})/)
      if (!actionMatch) break // no action found — agent is done

      const [, action, inputStr] = actionMatch
      let toolResult = ''

      try {
        const args = JSON.parse(inputStr!)

        if (action === 'report_results') {
          summary = args.summary ?? summary
          for (const m of args.matches ?? []) {
            allMatches.push({ dealerName: m.dealer_name, link: m.link, price: m.price, details: m.details ?? '', confidence: m.confidence ?? 'medium', source: 'external_site' })
          }
          break
        } else if (action === 'web_search') {
          toolResult = await this.safeWebSearch(args.query, args.site, searchedSites)
        } else if (action === 'scrape_page') {
          toolResult = await this.safeScrape(args.url)
        } else {
          toolResult = `Unknown action: ${action}`
        }
      } catch (err: any) {
        toolResult = `Error: ${err.message}`
      }

      messages.push({ role: 'user', content: `Tool result:\n${toolResult}` })
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
    if (!isAllowedSiteName(site, config.searchSites)) return `ERROR: Site "${site}" not allowed.`
    searchedSites.add(site)
    try {
      const html = await this.fetchHtml(`https://www.google.com/search?q=${encodeURIComponent(`${query} site:${site}`)}&num=10`)
      const $ = cheerio.load(html)
      const results: string[] = []
      $('div.g').slice(0, 6).each((_, el) => {
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
