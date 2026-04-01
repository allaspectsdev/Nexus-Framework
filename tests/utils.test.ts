import { describe, test, expect } from 'bun:test'
import { assertWithinRoot } from '../src/utils/pathSecurity.js'
import { escapeXml } from '../src/utils/escapeXml.js'
import { estimateTokens, estimateMessageTokens, formatTokens } from '../src/utils/tokens.js'
import { formatDuration, formatCost, shortId } from '../src/utils/format.js'

describe('assertWithinRoot', () => {
  const root = '/tmp/test-root'

  test('allows paths within root', () => {
    expect(assertWithinRoot('/tmp/test-root/file.txt', root)).toBe('/tmp/test-root/file.txt')
  })

  test('allows nested paths within root', () => {
    expect(assertWithinRoot('/tmp/test-root/sub/dir/file.txt', root)).toBe('/tmp/test-root/sub/dir/file.txt')
  })

  test('rejects paths outside root', () => {
    expect(() => assertWithinRoot('/etc/passwd', root)).toThrow('outside allowed root')
  })

  test('rejects path traversal with ..', () => {
    expect(() => assertWithinRoot('/tmp/test-root/../../../etc/passwd', root)).toThrow('outside allowed root')
  })

  test('rejects relative traversal', () => {
    expect(() => assertWithinRoot('../../etc/passwd', root)).toThrow('outside allowed root')
  })

  test('resolves relative paths within root using default cwd', () => {
    // Relative path from cwd should resolve to within cwd
    const result = assertWithinRoot('./package.json')
    expect(result).toBe(process.cwd() + '/package.json')
  })
})

describe('escapeXml', () => {
  test('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b')
  })

  test('escapes angle brackets', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;')
  })

  test('escapes quotes', () => {
    expect(escapeXml('"hello" \'world\'')).toBe('&quot;hello&quot; &apos;world&apos;')
  })

  test('escapes XML injection attempt', () => {
    const malicious = '</summary><script>alert(1)</script>'
    const escaped = escapeXml(malicious)
    expect(escaped).not.toContain('</')
    expect(escaped).toContain('&lt;/summary&gt;')
  })

  test('leaves safe strings unchanged', () => {
    expect(escapeXml('hello world 123')).toBe('hello world 123')
  })
})

describe('estimateTokens', () => {
  test('estimates tokens as chars / 4', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('estimateMessageTokens', () => {
  test('estimates based on JSON serialization', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const tokens = estimateMessageTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBe(Math.ceil(JSON.stringify(messages).length / 4))
  })
})

describe('formatTokens', () => {
  test('formats small numbers directly', () => {
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })

  test('formats thousands with K suffix', () => {
    expect(formatTokens(1234)).toBe('1.2K')
    expect(formatTokens(99999)).toBe('100.0K')
  })

  test('formats large numbers as rounded K', () => {
    expect(formatTokens(123456)).toBe('123K')
  })
})

describe('formatDuration', () => {
  test('formats milliseconds', () => {
    expect(formatDuration(42)).toBe('42ms')
  })

  test('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s')
  })

  test('formats minutes', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
  })
})

describe('formatCost', () => {
  test('formats tiny costs with 4 decimals', () => {
    expect(formatCost(0.001)).toBe('$0.0010')
  })

  test('formats small costs with 3 decimals', () => {
    expect(formatCost(0.123)).toBe('$0.123')
  })

  test('formats dollar costs with 2 decimals', () => {
    expect(formatCost(5.678)).toBe('$5.68')
  })
})

describe('shortId', () => {
  test('returns a string of length 12', () => {
    expect(shortId().length).toBe(12)
  })

  test('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortId()))
    expect(ids.size).toBe(100)
  })
})
