import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CampaignTaskCache } from '@/lib/storage'
import { MetadataBadge } from './MetadataBadge'

const task = {
  campaignId: 'campaign-1',
  tweetId: '1',
  actionType: 'LIKE',
  expectedReward: 1,
  reserved: false,
} satisfies CampaignTaskCache

describe('Lighthouse Selected available order scope', () => {
  it('shows text scope for selected available tasks and not legacy tasks', () => {
    expect(
      renderToStaticMarkup(
        <MetadataBadge tasks={[{ ...task, lighthouseSelectedOnly: true }]} />,
      ),
    ).toContain('仅灯塔严选可接')
    expect(
      renderToStaticMarkup(<MetadataBadge tasks={[task]} />),
    ).not.toContain('仅灯塔严选可接')
  })
})
