import { formatRequirementResult, formatRequirementResultMessages, formatListingSaved } from '../output/base-output'
import { AgentResult } from '../agents/base-agent'
import { IncomingMessage } from '../agents/base-agent'
import { Listing } from '../history/store'

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-1',
    text: 'Looking for Toyota Corolla 2020',
    sender: 'Demo User',
    groupId: '-100123',
    groupName: 'Demo Cars',
    source: 'telegram',
    timestamp: new Date('2024-01-15T14:30:00Z').getTime(),
    ...overrides,
  }
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    requirementId: 'req-1',
    requirementText: 'Looking for Toyota Corolla 2020',
    matches: [],
    summary: 'No results found.',
    searchedSites: ['pakwheels.com'],
    searchedAt: Date.now(),
    ...overrides,
  }
}

describe('formatRequirementResult', () => {
  it('includes the requirement text', () => {
    const out = formatRequirementResult(makeResult(), makeMsg())
    expect(out).toContain('Toyota Corolla 2020')
  })

  it('includes sender name', () => {
    const out = formatRequirementResult(makeResult(), makeMsg())
    expect(out).toContain('Demo User')
  })

  it('includes group name', () => {
    const out = formatRequirementResult(makeResult(), makeMsg())
    expect(out).toContain('Demo Cars')
  })

  it('shows no-matches message when matches is empty', () => {
    const out = formatRequirementResult(makeResult({ matches: [] }), makeMsg())
    expect(out).toContain('No matches found')
  })

  it('shows internal stock section for internal matches', () => {
    const result = makeResult({
      matches: [{
        dealerName: 'Demo Seller',
        details: 'Toyota Corolla 2020, White',
        price: '42 lakh',
        confidence: 'high',
        source: 'internal_listing',
      }],
    })
    const out = formatRequirementResult(result, makeMsg())
    expect(out).toContain('INTERNAL STOCK')
    expect(out).toContain('Demo Seller')
  })

  it('shows online section for external matches', () => {
    const result = makeResult({
      matches: [{
        dealerName: 'PakWheels',
        link: 'https://pakwheels.com/1234',
        price: '43 lakh',
        details: 'Toyota Corolla',
        confidence: 'medium',
        source: 'external_site',
      }],
    })
    const out = formatRequirementResult(result, makeMsg())
    expect(out).toContain('ONLINE')
    expect(out).toContain('pakwheels.com/1234')
  })

  it('shows searched sites', () => {
    const out = formatRequirementResult(
      makeResult({ searchedSites: ['pakwheels.com', 'olx.com.pk'] }),
      makeMsg()
    )
    expect(out).toContain('pakwheels.com')
    expect(out).toContain('olx.com.pk')
  })

  it('handles unknown sender gracefully', () => {
    const out = formatRequirementResult(makeResult(), makeMsg({ sender: undefined }))
    expect(out).toContain('Unknown')
  })

  it('separates internal and external matches correctly', () => {
    const result = makeResult({
      matches: [
        { details: 'Internal', confidence: 'high', source: 'internal_listing' },
        { details: 'External', confidence: 'medium', source: 'external_site' },
      ],
    })
    const out = formatRequirementResult(result, makeMsg())
    const internalPos = out.indexOf('INTERNAL STOCK')
    const onlinePos = out.indexOf('ONLINE')
    expect(internalPos).toBeLessThan(onlinePos)
  })
})

describe('formatRequirementResultMessages', () => {
  it('returns one combined message when mode is combined', () => {
    const result = makeResult({
      matches: [
        { details: 'Internal 1', confidence: 'high', source: 'internal_listing' },
        { details: 'External 1', confidence: 'medium', source: 'external_site' },
      ],
    })
    const out = formatRequirementResultMessages(result, makeMsg(), 'combined')
    expect(out).toHaveLength(1)
  })

  it('returns one message per match when mode is per_match', () => {
    const result = makeResult({
      matches: [
        { details: 'Internal 1', confidence: 'high', source: 'internal_listing' },
        { details: 'External 1', confidence: 'medium', source: 'external_site' },
      ],
      searchedSites: ['pakwheels.com'],
      summary: 'Done',
    })
    const out = formatRequirementResultMessages(result, makeMsg(), 'per_match')
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('Match 1/2')
    expect(out[1]).toContain('Match 2/2')
    expect(out[1]).toContain('Searched: pakwheels.com')
  })

  it('falls back to single no-match message in per_match mode when there are no matches', () => {
    const out = formatRequirementResultMessages(makeResult({ matches: [] }), makeMsg(), 'per_match')
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('No matches found')
  })
})

describe('formatListingSaved', () => {
  const listing: Listing = {
    id: 'lst-1',
    domain: 'used_cars',
    source: 'telegram',
    make: 'Toyota',
    model: 'Corolla',
    variant: 'GLI',
    year: 2019,
    fuelType: 'Petrol',
    color: 'White',
    kmDriven: 38000,
    price: '38 lakh',
    conditionRating: 'Good',
    location: 'Demo City',
    postedAt: Date.now(),
    createdAt: Date.now(),
  }

  it('includes listing saved header', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('Listing Saved')
  })

  it('includes car make and model', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('Toyota')
    expect(out).toContain('Corolla')
  })

  it('includes fuel type', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('Petrol')
  })

  it('includes color', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('White')
  })

  it('includes km driven', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('38,000')
  })

  it('includes price', () => {
    const out = formatListingSaved(listing, makeMsg())
    expect(out).toContain('38 lakh')
  })

  it('includes sender name', () => {
    const out = formatListingSaved(listing, makeMsg({ sender: 'Ali' }))
    expect(out).toContain('Ali')
  })

  it('handles listing with no make/model gracefully', () => {
    const minimal: Listing = {
      id: 'lst-2', domain: 'used_cars', source: 'telegram',
      postedAt: Date.now(), createdAt: Date.now(),
    }
    expect(() => formatListingSaved(minimal, makeMsg())).not.toThrow()
  })
})
