import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ProofReviewCard } from '@/components/product-experience/ProofReviewCard'

test('tells the user to trigger requests without claiming proof started', () => {
  const html = renderToStaticMarkup(
    <ProofReviewCard
      state={{ phase: 'reading', snapshot: null, error: null }}
      onConfirm={vi.fn()}
      onReread={vi.fn()}
    />,
  )
  expect(html).toContain('监听已就绪')
  expect(html).toContain('刷新当前页面')
  expect(html).not.toContain('正在生成证明')
  expect(html).not.toContain('确认数据并开始证明')
})

test('shows the original failure code without a success label', () => {
  const html = renderToStaticMarkup(
    <ProofReviewCard
      state={{
        phase: 'failed',
        snapshot: null,
        error: 'REVIEW_ACCOUNT_MISMATCH',
      }}
      onConfirm={vi.fn()}
      onReread={vi.fn()}
    />,
  )
  expect(html).toContain('REVIEW_ACCOUNT_MISMATCH')
  expect(html).not.toContain('验证通过')
  expect(html).toContain('技术失败不代表条件不满足')
})

test('shows the read-confirm-prove flow with the current step', () => {
  const html = renderToStaticMarkup(
    <ProofReviewCard
      state={{ phase: 'reading', snapshot: null, error: null }}
      onConfirm={vi.fn()}
      onReread={vi.fn()}
    />,
  )
  expect(html).toContain('读取数据')
  expect(html).toContain('核对数据')
  expect(html).toContain('生成证明')
  expect(html).toContain('aria-current="step"')
})
