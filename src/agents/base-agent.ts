import { CarListing, HistoryContext, Listing, Result } from '../history/store'

// ── Shared types ──────────────────────────────────────────────────────────────

export type MessageType = 'requirement' | 'listing' | 'irrelevant' | 'needs_clarification'

export interface IncomingMessage {
  id: string
  text: string
  sender?: string
  groupId?: string
  groupName?: string
  source: 'whatsapp' | 'telegram'
  timestamp: number
  imageBase64?: string[]   // base64-encoded images attached to the message
  groupHistory?: Array<{sender: string, text: string}>  // recent messages before this one
  isAdminCommand?: boolean  // message came from the admin's personal chat
  isDirectChat?: boolean
}

export interface Match {
  dealerName?: string
  link?: string
  price?: string
  details: string
  confidence: 'high' | 'medium' | 'low'
  source: 'external_site' | 'internal_listing'
  location?: string           // city/area of the listing
  internalListing?: Listing   // populated when source = 'internal_listing'
}

export interface AgentResult {
  requirementId: string
  requirementText: string
  matches: Match[]
  summary: string
  searchedSites: string[]
  searchedAt: number
}

export type MessageProcessResult =
  | { type: 'irrelevant' }
  | { type: 'reply'; reply: string }
  | { type: 'needs_clarification' }
  | { type: 'listing'; listing: CarListing }
  | { type: 'requirement'; result: AgentResult }

// ── Abstract base ─────────────────────────────────────────────────────────────

export abstract class BaseAgent {
  /** Classify an incoming message as a requirement, listing, or irrelevant */
  abstract classifyMessage(msg: IncomingMessage): Promise<MessageType>

  /** Extract structured listing data from a message (text + optional images) */
  abstract extractListing(msg: IncomingMessage): Promise<CarListing>

  /** Search for matches to a requirement and return structured results */
  abstract processRequirement(
    requirementId: string,
    requirementText: string,
    context: HistoryContext
  ): Promise<AgentResult>

  /**
   * Optional single-pass handler: classify AND act on the message in one call.
   * Agents that implement this avoid multiple separate round-trips.
   * Returns null if not supported (orchestrator falls back to separate calls).
   */
  processMessage?(msg: IncomingMessage): Promise<MessageProcessResult>
  getRuntimeStatus?(): string
}
