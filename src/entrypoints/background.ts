/**
 * Background service worker entrypoint.
 *
 * Currently a stub — full implementation lands in Task 23 (alarm-driven
 * task sync + chrome.storage caching + GraphQL fetcher).
 */

export default defineBackground(() => {
  console.log('[lhdao] background worker booted')
})
