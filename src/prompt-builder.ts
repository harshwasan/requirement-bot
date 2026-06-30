import { config } from './config'
import { HistoryContext, Listing, Result } from './history/store'

const MAX_PROMPT_LISTINGS = 10
const MAX_PROMPT_PAST_RESULTS = 5
const MAX_USER_TEXT_LENGTH = 2000

/** Escape user-provided text before injecting into prompts to prevent prompt injection */
export function sanitizeForPrompt(text: string): string {
  return text
    .slice(0, MAX_USER_TEXT_LENGTH)
    // Remove or escape characters that could break prompt structure
    .replace(/"""/g, "'''")   // triple-quote used as delimiters in prompts
    .replace(/\\/g, '\\\\')   // backslash escaping
    .trim()
}

function formatDate(ts: number): string {
  if (!ts || isNaN(ts)) return 'Unknown date'
  return new Date(ts).toLocaleDateString('en-PK', {
    day: '2-digit', month: 'short', year: 'numeric'
  })
}

function formatListing(l: Listing): string {
  const parts: string[] = []
  const title = [l.make, l.model, l.variant].filter(Boolean).join(' ')
  if (title) parts.push(title)
  if (l.year) parts.push(`Year: ${l.year}`)
  if (l.color) parts.push(`Color: ${l.color}`)
  if (l.fuelType) parts.push(`Fuel: ${l.fuelType}`)
  if (l.kmDriven != null) parts.push(`KM: ${l.kmDriven.toLocaleString()}`)
  if (l.price) parts.push(`Price: ${l.price}`)
  if (l.conditionRating) parts.push(`Condition: ${l.conditionRating}`)
  if (l.contact) parts.push(`Contact: ${l.contact}`)
  if (l.sender) parts.push(`Posted by: ${l.sender}`)
  if (l.groupName) parts.push(`Group: ${l.groupName}`)
  parts.push(`Date: ${formatDate(l.postedAt)}`)
  return parts.join(' | ')
}

function formatPastResult(r: Result): string {
  return [
    r.dealerName ? `Dealer: ${r.dealerName}` : null,
    r.link ? `Link: ${r.link}` : null,
    r.price ? `Price: ${r.price}` : null,
    r.details ? `Details: ${r.details}` : null,
    `Source: ${r.source ?? 'unknown'}`,
    `Found: ${formatDate(r.foundAt)}`,
    `Available: ${r.stillAvailable ? 'Yes' : 'Unknown'}`,
  ].filter(Boolean).join(' | ')
}

export function buildClassifierPrompt(
  text: string,
  hasImages: boolean,
  history?: Array<{sender: string, text: string}>
): string {
  const safeText = sanitizeForPrompt(text)

  const historySection = history && history.length > 0
    ? `\nRecent group conversation (for context):\n${
        history.map(h => `  ${h.sender}: ${sanitizeForPrompt(h.text)}`).join('\n')
      }\n`
    : ''

  return `You are a silent lurker in a ${config.domainDescription} WhatsApp group. Your job is to catch EVERY car requirement, no matter how it is phrased — formal, casual, in passing, mid-conversation, or in reply to someone.

Classify the message as one of:
- "requirement" — ANYONE expressing a need, want, or search for a car. This includes:
    * Direct: "need a Corolla 2020", "looking for WagonR"
    * Casual: "koi Civic hai?", "bhai mere liye car dhundh", "anyone have a good Swift?"
    * Conversational: "I'm thinking of getting a Fortuner", "my uncle wants a diesel SUV"
    * Asking on behalf of others: "client chahiye ek Verna", "customer is looking for..."
    * Any question about car availability: "does anyone have X available?"
    * WHEN IN DOUBT and group history shows someone asking about a car → requirement

- "listing" — someone is SELLING or OFFERING a car. Must have clear selling intent.
    STRONG listing signals: price + contact info, "for sale", "available", images of the car
    WEAK (not enough alone): just car specs, just a model name

- "irrelevant" — pure chat, greetings, questions about non-car topics, admin messages

- "needs_clarification" — use this ONLY when you genuinely cannot tell even after reading context

BIAS: Always prefer "requirement" over "irrelevant" when there is ANY car-related need expressed.
Missing a requirement is worse than a false positive.

HEURISTIC: Text-only message with just car specs and NO price/contact/selling language → "requirement"
${historySection}
Message: """${safeText}"""
Has images: ${hasImages}

Reply with ONLY ONE WORD: requirement | listing | irrelevant | needs_clarification`
}

export function buildListingExtractorPrompt(text: string, hasImages: boolean): string {
  const safeText = sanitizeForPrompt(text)
  return `You are a data extractor for a ${config.domainDescription} business.

Extract all available information from this listing message and return a JSON object.

For used cars, extract these fields (use null for missing):
{
  "make": "brand name e.g. Toyota, Honda",
  "model": "model name e.g. Corolla, Civic",
  "variant": "variant/trim e.g. GLI, VX, CVT",
  "year": 2020,
  "fuel_type": "Petrol | Diesel | CNG | Hybrid | Electric",
  "color": "color name — also infer from image if available",
  "km_driven": 45000,
  "price": "price as stated e.g. '38 lakh' or 'negotiable'",
  "condition_rating": "Excellent | Good | Fair | Poor | Accident-free",
  "location": "city or area",
  "contact": "phone number or contact info",
  "extra_details": { "any": "other relevant info" }
}

Message: """${safeText}"""
Has images: ${hasImages}${hasImages ? ' — check images for color, condition, and visible features' : ''}

Return ONLY valid JSON, no explanation.`
}

export function buildSearchSystemPrompt(context: HistoryContext): string {
  const sitesStr = config.searchSites.join(', ')

  // Limit context to avoid token overflow
  const listings = context.internalListings.slice(0, MAX_PROMPT_LISTINGS)
  const pastResults = context.pastResults.slice(0, MAX_PROMPT_PAST_RESULTS)

  const internalSection = listings.length > 0
    ? `INTERNAL STOCK (${listings.length} listings in your own database):
${listings.map((l, i) => `${i + 1}. ${formatListing(l)}`).join('\n')}`
    : 'INTERNAL STOCK: No matching listings in your database.'

  const historySection = pastResults.length > 0
    ? `PREVIOUSLY FOUND ONLINE (${pastResults.length} past results — verify if still available):
${pastResults.map((r, i) => `${i + 1}. ${formatPastResult(r)}`).join('\n')}`
    : 'PREVIOUSLY FOUND ONLINE: No past results for similar requirements.'

  return `You are a ${config.domainDescription} requirement search bot.

YOUR ONLY JOB:
1. Check internal stock first (already provided below)
2. Search ONLY these websites: ${sitesStr}
3. Find listings that match the requirement
4. Return structured results

STRICT RULES — you MUST follow these:
- NEVER access any website not listed above
- NEVER engage in conversation or answer questions
- NEVER do anything except search and report matches
- If you cannot find a match, say so clearly
- Always check previously found results — if they match, include them (they may still be available)

AVAILABLE TOOLS:
- web_search(query, site): Search a specific allowed site
- scrape_page(url): Fetch and parse a listing page (only allowed sites)
- report_results(matches): Submit your final results and end the session

--- CONTEXT ---

${internalSection}

${historySection}

--- END CONTEXT ---

When done, call report_results() with all matches you found (internal + online combined).`
}
