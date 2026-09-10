import { expect, test, vi } from 'vitest'
import { ProductProofReview } from '../zktls/review-channel'

test('never exposes review to page senders or accepts their confirmation', async () => {
  const review = new ProductProofReview(vi.fn())
  expect(
    review.isPopup({
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup.html'),
    }),
  ).toBe(true)
  expect(
    review.isPopup({ id: chrome.runtime.id, url: 'https://app.example.com' }),
  ).toBe(false)
  expect(
    review.isPopup({
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup.html'),
      tab: { id: 1 } as chrome.tabs.Tab,
    }),
  ).toBe(false)
})

test('starts no review work if owner authorization has gone away', async () => {
  const review = new ProductProofReview(vi.fn())
  const prove = vi.fn()
  await expect(
    review.run(
      {
        sessionId: 's',
        connectorId: 'c',
        correlationId: 'r',
        reviewContext: {
          tabId: 1,
          expectedWallet: null,
          title: 't',
          ownerSessionId: 'o',
          configVersion: 1,
        },
      },
      prove,
      async () => {
        throw new Error('REVIEW_OWNER_CHANGED')
      },
    ),
  ).rejects.toThrow('REVIEW_OWNER_CHANGED')
  expect(prove).not.toHaveBeenCalled()
})
