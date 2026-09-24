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

  it('does not assign the detail URL tweet id to another author’s ad', () => {
    window.history.replaceState({}, '', '/owner/status/123456')
    document.body.innerHTML = `
      <article><div data-testid="User-Name"><a role="link" href="/owner">Owner</a></div></article>
      <article><div data-testid="User-Name"><a role="link" href="/advertiser">Ad</a></div></article>`
    const [main, ad] = document.querySelectorAll('article')
    expect(extractTweetIdFromArticle(main)).toBe('123456')
    expect(extractTweetIdFromArticle(ad)).toBeNull()
  })

  it('does not use a nested quoted tweet as the outer article identity', () => {
    window.history.replaceState({}, '', '/owner/status/123456')
    document.body.innerHTML = `
      <article id="ad">
        <div data-testid="User-Name"><a role="link" href="/advertiser">Ad</a></div>
        <article><a href="/owner/status/123456"><time>Quoted</time></a></article>
      </article>`
    expect(extractTweetIdFromArticle(document.querySelector('#ad')!)).toBeNull()
  })
})
