import { AgentResult, Match } from '../agents/base-agent'
import { IncomingMessage } from '../agents/base-agent'
import { Listing } from '../history/store'
import type { RequirementReplyMode } from '../config'

export interface OutputMessage {
  text: string
}

export abstract class BaseOutput {
  abstract send(text: string): Promise<void>
}

// ── Formatters (shared by all output implementations) ─────────────────────────

export function formatRequirementResult(result: AgentResult, originalMsg: IncomingMessage): string {
  const time = new Date(originalMsg.timestamp).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  })

  const internal = result.matches.filter(m => m.source === 'internal_listing')
  const external = result.matches.filter(m => m.source === 'external_site')

  const lines: string[] = [
    `*Requirement:* ${originalMsg.text}`,
    `*From:* ${originalMsg.sender ?? 'Unknown'} (${originalMsg.groupName ?? originalMsg.groupId})`,
    `*Time:* ${time}`,
    '',
  ]

  if (internal.length > 0) {
    lines.push(`*INTERNAL STOCK (${internal.length} match${internal.length > 1 ? 'es' : ''}):*`)
    internal.forEach((m, i) => {
      lines.push(`${i + 1}. ${formatMatch(m)}`)
    })
    lines.push('')
  }

  if (external.length > 0) {
    lines.push(`*ONLINE (${external.length} match${external.length > 1 ? 'es' : ''}):*`)
    external.forEach((m, i) => {
      lines.push(`${i + 1}. ${formatMatch(m)}`)
    })
    lines.push('')
  }

  if (result.matches.length === 0) {
    lines.push('No matches found.')
    lines.push('')
  }

  if (result.summary) {
    lines.push(result.summary)
    lines.push('')
  }

  if (result.searchedSites.length > 0) {
    lines.push(`Searched: ${result.searchedSites.join(', ')}`)
  }

  return lines.join('\n')
}

export function formatRequirementResultMessages(
  result: AgentResult,
  originalMsg: IncomingMessage,
  mode: RequirementReplyMode
): string[] {
  if (mode === 'combined' || result.matches.length === 0) {
    return [formatRequirementResult(result, originalMsg)]
  }

  const time = new Date(originalMsg.timestamp).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  })

  const messages: string[] = []
  for (let i = 0; i < result.matches.length; i++) {
    const m = result.matches[i]!
    const sourceLabel = m.source === 'internal_listing' ? 'INTERNAL STOCK' : 'ONLINE'
    const parts: string[] = [
      `*Requirement:* ${originalMsg.text}`,
      `*From:* ${originalMsg.sender ?? 'Unknown'} (${originalMsg.groupName ?? originalMsg.groupId})`,
      `*Time:* ${time}`,
      `*Match ${i + 1}/${result.matches.length}* (${sourceLabel})`,
      '',
      formatMatch(m),
    ]

    if (i === result.matches.length - 1) {
      if (result.summary) {
        parts.push('')
        parts.push(result.summary)
      }
      if (result.searchedSites.length > 0) {
        parts.push('')
        parts.push(`Searched: ${result.searchedSites.join(', ')}`)
      }
    }

    messages.push(parts.join('\n'))
  }

  return messages
}

function formatMatch(m: Match): string {
  const parts: string[] = []
  if (m.dealerName) parts.push(m.dealerName)
  if (m.details)    parts.push(`   ${m.details}`)
  if (m.location)   parts.push(`   Location: ${m.location}`)
  if (m.price)      parts.push(`   Price: ${m.price}`)
  if (m.link)       parts.push(`   ${m.link}`)
  if (m.internalListing?.contact) parts.push(`   Contact: ${m.internalListing.contact}`)
  const conf = m.confidence === 'high' ? 'High match' : m.confidence === 'medium' ? 'Possible match' : 'Low match'
  parts.push(`   ${conf}`)
  return parts.join('\n')
}

export function formatListingSaved(listing: Listing, originalMsg: IncomingMessage): string {
  const parts: string[] = ['*Listing Saved*']

  const carTitle = [listing.make, listing.model, listing.variant, listing.year].filter(Boolean).join(' ')
  if (carTitle) parts.push(carTitle)

  const specs: string[] = []
  if (listing.fuelType)  specs.push(listing.fuelType)
  if (listing.color)     specs.push(listing.color)
  if (listing.kmDriven)  specs.push(`${listing.kmDriven.toLocaleString()} km`)
  if (specs.length)      parts.push(specs.join(', '))

  if (listing.price)          parts.push(`Price: ${listing.price}`)
  if (listing.conditionRating) parts.push(`Condition: ${listing.conditionRating}`)
  if (listing.location)       parts.push(`Location: ${listing.location}`)
  if (listing.contact)        parts.push(`Contact: ${listing.contact}`)

  parts.push(`Posted by: ${originalMsg.sender ?? 'Unknown'} in ${originalMsg.groupName ?? originalMsg.groupId}`)

  return parts.join('\n')
}
