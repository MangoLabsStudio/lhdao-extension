import { beforeEach, describe, expect, it } from 'vitest'
import {
  extractTweetIdFromArticle,
  extractTweetIdFromUrl,
} from '../twitter-dom'

describe('extractTweetIdFromUrl', () => {
  it('parses x.com /<user>/status/<id>', () => {
    expect(extractTweetIdFromUrl('https://x.com/foo/status/123')).toBe('123')
  })

  it('parses twitter.com /<user>/status/<id>', () => {
    expect(extractTweetIdFromUrl('https://twitter.com/foo/status/456')).toBe(
      '456',
    )
  })

  it('handles trailing slash + query string', () => {
    expect(extractTweetIdFromUrl('https://x.com/foo/status/789/?s=20')).toBe(
      '789',
    )
  })

  it('handles photo / video sub-route', () => {
    expect(extractTweetIdFromUrl('https://x.com/foo/status/9999/photo/1')).toBe(
      '9999',
    )
  })

  it('returns null for non-tweet URL', () => {
    expect(extractTweetIdFromUrl('https://x.com/foo')).toBeNull()
    expect(extractTweetIdFromUrl('https://example.com')).toBeNull()
  })

  it('returns null for malformed URL', () => {
    expect(extractTweetIdFromUrl('not a url at all')).toBeNull()
    expect(extractTweetIdFromUrl('')).toBeNull()
  })

  it('rejects non-x/twitter hosts', () => {
    // Defense against fake hostnames carrying a /status/ path.
    expect(extractTweetIdFromUrl('https://evil.com/foo/status/123')).toBeNull()
  })
})

describe('extractTweetIdFromArticle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('finds first /status/ link in article', () => {
    document.body.innerHTML =
      '<article><a href="/foo/status/12345">link</a></article>'
    const article = document.querySelector('article')!
    expect(extractTweetIdFromArticle(article)).toBe('12345')
  })

  it('skips non-status links', () => {
    document.body.innerHTML = `
      <article>
        <a href="/foo">profile</a>
        <a href="/foo/status/77777">target</a>
      </article>`
    const article = document.querySelector('article')!
    expect(extractTweetIdFromArticle(article)).toBe('77777')
  })

  it('returns null if article has no /status/ link', () => {
    document.body.innerHTML = '<article><a href="/foo">link</a></article>'
    const article = document.querySelector('article')!
    expect(extractTweetIdFromArticle(article)).toBeNull()
  })

  it('returns null on empty article', () => {
    document.body.innerHTML = '<article></article>'
    const article = document.querySelector('article')!
    expect(extractTweetIdFromArticle(article)).toBeNull()
  })
})
