import initSqlJs, { Database } from 'sql.js'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { config } from '../config'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Requirement {
  id: string
  rawText: string
  source: 'whatsapp' | 'telegram'
  groupId?: string
  groupName?: string
  sender?: string
  timestamp: number
  status: 'pending' | 'processing' | 'done' | 'failed'
}

export interface Result {
  id: string
  requirementId: string
  dealerName?: string
  link?: string
  price?: string
  details?: string
  confidence?: 'high' | 'medium' | 'low'
  source?: 'external_site' | 'internal_listing'
  foundAt: number
  lastVerified?: number
  stillAvailable?: boolean
}

export interface CarListing {
  make?: string
  model?: string
  variant?: string
  year?: number
  fuelType?: string
  color?: string
  kmDriven?: number
  price?: string
  conditionRating?: string
  location?: string
  contact?: string
  extraDetails?: Record<string, unknown>
}

export interface Listing extends CarListing {
  id: string
  domain: string
  source: 'whatsapp' | 'telegram'
  groupId?: string
  groupName?: string
  sender?: string
  rawText?: string
  imagePaths?: string[]
  postedAt: number
  createdAt: number
}

export interface HistoryContext {
  pastResults: Result[]
  internalListings: Listing[]
}

// ── Store ─────────────────────────────────────────────────────────────────────

class HistoryStore {
  private db!: Database
  private dbPath: string
  private ready: Promise<void>

  constructor(dbPath: string) {
    this.dbPath = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs()

    // Load existing DB from disk or create new
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath)
      this.db = new SQL.Database(fileBuffer)
    } else {
      this.db = new SQL.Database()
    }

    this.runSchema()
    this.persist() // initial save
  }

  private runSchema(): void {
    const schemaPath = path.join(__dirname, 'schema.sql')
    const schema = fs.readFileSync(schemaPath, 'utf-8')
    // sql.js supports multi-statement run
    try {
      this.db.run(schema)
    } catch {
      // Ignore "already exists" — run statements one by one as fallback
      const statements = schema.split(';').map(s => s.trim()).filter(Boolean)
      for (const stmt of statements) {
        try { this.db.run(stmt) } catch { /* already exists */ }
      }
    }
  }

  /** Persist DB to disk (call after every write) */
  private persist(): void {
    const data = this.db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }

  private run(sql: string, params: any[] = []): void {
    this.db.run(sql, params)
    this.persist()
  }

  private query<T = Record<string, any>>(sql: string, params: any[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T)
      }
      return rows
    } finally {
      stmt.free()
    }
  }

  async waitReady(): Promise<void> {
    await this.ready
  }

  // ── Requirements ────────────────────────────────────────────────────────────

  saveRequirement(req: Omit<Requirement, 'id' | 'status'>): Requirement {
    const id = randomUUID()
    this.run(
      `INSERT INTO requirements (id, raw_text, source, group_id, group_name, sender, timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, req.rawText, req.source, req.groupId ?? null, req.groupName ?? null, req.sender ?? null, req.timestamp]
    )
    return { id, ...req, status: 'pending' }
  }

  updateRequirementStatus(id: string, status: Requirement['status']): void {
    this.run(`UPDATE requirements SET status = ? WHERE id = ?`, [status, id])
  }

  getRequirement(id: string): Requirement | undefined {
    const rows = this.query<any>(`SELECT * FROM requirements WHERE id = ? LIMIT 1`, [id])
    if (rows.length === 0) return undefined
    const row = rows[0]!
    return {
      id: row.id, rawText: row.raw_text, source: row.source,
      groupId: row.group_id ?? undefined, groupName: row.group_name ?? undefined,
      sender: row.sender ?? undefined, timestamp: row.timestamp, status: row.status,
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  saveResults(requirementId: string, results: Omit<Result, 'id' | 'requirementId' | 'foundAt'>[]): Result[] {
    const now = Date.now()
    const saved: Result[] = []
    for (const r of results) {
      const id = randomUUID()
      this.run(
        `INSERT INTO results (id, requirement_id, dealer_name, link, price, details, confidence, source, found_at, still_available)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, requirementId, r.dealerName ?? null, r.link ?? null, r.price ?? null, r.details ?? null, r.confidence ?? null, r.source ?? null, now]
      )
      saved.push({ id, requirementId, foundAt: now, ...r, stillAvailable: r.stillAvailable ?? true })
    }
    return saved
  }

  getPastResultsForKeywords(keywords: string, limit = 10): Result[] {
    const rows = this.query<any>(
      `SELECT r.* FROM results r
       JOIN requirements req ON req.id = r.requirement_id
       WHERE req.raw_text LIKE ? AND r.still_available = 1
       ORDER BY r.found_at DESC LIMIT ?`,
      [`%${keywords}%`, limit]
    )
    return rows.map(row => ({
      id: row.id, requirementId: row.requirement_id,
      dealerName: row.dealer_name ?? undefined, link: row.link ?? undefined,
      price: row.price ?? undefined, details: row.details ?? undefined,
      confidence: row.confidence ?? undefined, source: row.source ?? undefined,
      foundAt: row.found_at, lastVerified: row.last_verified ?? undefined,
      stillAvailable: !!row.still_available,
    }))
  }

  // ── Listings ─────────────────────────────────────────────────────────────────

  saveListing(listing: Omit<Listing, 'id' | 'createdAt'>): Listing {
    const id = randomUUID()
    const now = Date.now()
    this.run(
      `INSERT INTO listings (
        id, domain, source, group_id, group_name, sender, raw_text, image_paths,
        make, model, variant, year, fuel_type, color, km_driven, price,
        condition_rating, location, contact, extra_details, posted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, listing.domain, listing.source,
        listing.groupId ?? null, listing.groupName ?? null, listing.sender ?? null,
        listing.rawText ?? null,
        listing.imagePaths ? JSON.stringify(listing.imagePaths) : null,
        listing.make ?? null, listing.model ?? null, listing.variant ?? null,
        listing.year ?? null, listing.fuelType ?? null, listing.color ?? null,
        listing.kmDriven ?? null, listing.price ?? null,
        listing.conditionRating ?? null, listing.location ?? null, listing.contact ?? null,
        listing.extraDetails ? JSON.stringify(listing.extraDetails) : null,
        listing.postedAt, now,
      ]
    )
    return { id, createdAt: now, ...listing }
  }

  /** Simple keyword search over listings (FTS not available in sql.js without extensions) */
  searchListings(query: string, domain: string = config.domain, limit = 10): Listing[] {
    const keywords = query.split(/\s+/).filter(w => w.length > 2)
    const conditions = keywords.map(() =>
      `(make LIKE ? OR model LIKE ? OR variant LIKE ? OR color LIKE ? OR raw_text LIKE ?)`
    ).join(' OR ')

    const params: any[] = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`, `%${k}%`, `%${k}%`])
    params.push(domain, limit)

    const sql = conditions
      ? `SELECT * FROM listings WHERE (${conditions}) AND domain = ? ORDER BY posted_at DESC LIMIT ?`
      : `SELECT * FROM listings WHERE domain = ? ORDER BY posted_at DESC LIMIT ?`

    const rows = this.query<any>(conditions ? sql : sql, conditions ? params : [domain, limit])
    return rows.map(r => this.rowToListing(r))
  }

  getRecentListings(domain: string = config.domain, limit = 20): Listing[] {
    const rows = this.query<any>(
      `SELECT * FROM listings WHERE domain = ? ORDER BY posted_at DESC LIMIT ?`,
      [domain, limit]
    )
    return rows.map(r => this.rowToListing(r))
  }

  private safeJsonParse(raw: string | null | undefined): Record<string, unknown> | undefined {
    if (!raw) return undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  private rowToListing(row: any): Listing {
    return {
      id: row.id, domain: row.domain, source: row.source,
      groupId: row.group_id ?? undefined, groupName: row.group_name ?? undefined,
      sender: row.sender ?? undefined, rawText: row.raw_text ?? undefined,
      imagePaths: this.safeJsonParse(row.image_paths) as string[] | undefined,
      make: row.make ?? undefined, model: row.model ?? undefined,
      variant: row.variant ?? undefined, year: row.year ?? undefined,
      fuelType: row.fuel_type ?? undefined, color: row.color ?? undefined,
      kmDriven: row.km_driven ?? undefined, price: row.price ?? undefined,
      conditionRating: row.condition_rating ?? undefined,
      location: row.location ?? undefined, contact: row.contact ?? undefined,
      extraDetails: this.safeJsonParse(row.extra_details),
      postedAt: row.posted_at, createdAt: row.created_at,
    }
  }

  getAgentContext(requirementText: string): HistoryContext {
    const keywords = requirementText.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(' ')
    const pastResults = this.getPastResultsForKeywords(keywords)
    const internalListings = this.searchListings(keywords)
    return { pastResults, internalListings }
  }

  close(): void {
    this.persist()
    this.db.close()
  }
}

// Singleton — initialized async, but exposed synchronously after first await in index.ts
let _store: HistoryStore | null = null

export function getStore(): HistoryStore {
  if (!_store) _store = new HistoryStore(config.dbPath)
  return _store
}

export const store = new Proxy({} as HistoryStore, {
  get(_target, prop) {
    return (...args: any[]) => (getStore() as any)[prop](...args)
  }
})
