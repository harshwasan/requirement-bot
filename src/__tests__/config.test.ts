import { parseGroupNames, isAllowedSite, isAllowedSiteName } from '../config'

describe('parseGroupNames', () => {
  it('parses valid key=value pairs', () => {
    const result = parseGroupNames('123@g.us=Demo Cars,456@g.us=Demo Property')
    expect(result).toEqual({
      '123@g.us': 'Demo Cars',
      '456@g.us': 'Demo Property',
    })
  })

  it('returns empty object for undefined input', () => {
    expect(parseGroupNames(undefined)).toEqual({})
  })

  it('returns empty object for empty string', () => {
    expect(parseGroupNames('')).toEqual({})
  })

  it('skips pairs with no = separator', () => {
    expect(parseGroupNames('noequalssign,valid=Group')).toEqual({ valid: 'Group' })
  })

  it('skips pairs with empty key or value', () => {
    expect(parseGroupNames('=emptykey,key=,valid=ok')).toEqual({ valid: 'ok' })
  })

  it('handles single pair', () => {
    expect(parseGroupNames('abc@g.us=Test')).toEqual({ 'abc@g.us': 'Test' })
  })

  it('handles value with = in it (takes only first =)', () => {
    const result = parseGroupNames('key=value=with=equals')
    expect(result).toEqual({ key: 'value=with=equals' })
  })
})

describe('isAllowedSite (full URL check)', () => {
  const sites = ['pakwheels.com', 'olx.com.pk']

  it('allows exact domain match', () => {
    expect(isAllowedSite('https://pakwheels.com/cars', sites)).toBe(true)
  })

  it('allows subdomain match', () => {
    expect(isAllowedSite('https://www.pakwheels.com/cars', sites)).toBe(true)
  })

  it('blocks unknown domain', () => {
    expect(isAllowedSite('https://evil.com/steal', sites)).toBe(false)
  })

  it('blocks subdomain of attacker that contains allowed name', () => {
    // "pakwheels.attacker.com" should NOT be allowed
    expect(isAllowedSite('https://pakwheels.attacker.com/phish', sites)).toBe(false)
  })

  it('blocks attacker domain with allowed site as subdomain path', () => {
    expect(isAllowedSite('https://attacker.com/pakwheels', sites)).toBe(false)
  })

  it('returns false for invalid URL', () => {
    expect(isAllowedSite('not-a-url', sites)).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isAllowedSite('', sites)).toBe(false)
  })
})

describe('isAllowedSiteName (short name check)', () => {
  const sites = ['pakwheels.com', 'olx.com.pk', 'car']

  it('allows exact match', () => {
    expect(isAllowedSiteName('pakwheels.com', sites)).toBe(true)
  })

  it('is case insensitive', () => {
    expect(isAllowedSiteName('PAKWHEELS.COM', sites)).toBe(true)
  })

  it('blocks partial match — "car" should NOT allow "car.attacker.com"', () => {
    expect(isAllowedSiteName('car.attacker.com', sites)).toBe(false)
  })

  it('blocks unknown site name', () => {
    expect(isAllowedSiteName('random-site.com', sites)).toBe(false)
  })

  it('handles trailing slash in input', () => {
    expect(isAllowedSiteName('pakwheels.com/', sites)).toBe(true)
  })

  it('handles http:// prefix in input', () => {
    expect(isAllowedSiteName('http://pakwheels.com', sites)).toBe(true)
  })
})
