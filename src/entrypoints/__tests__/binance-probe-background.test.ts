import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BinanceProbeObservation } from '@/lib/binance-square-probe'
import {
  appendBinanceProbeObservation,
  handleBinanceProbeRequest,
  liveBinanceProbeObservations,
} from '../background'

const NOW = Date.parse('2026-08-04T00:00:00.000Z')

function observation(
  overrides: Partial<BinanceProbeObservation> = {},
): BinanceProbeObservation {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    method: 'POST',
    path: '/bapi/example',
    status: 200,
    target: { kind: 'CONTENT', id: '335389698745313' },
    requestShape: { postId: '<target:CONTENT>' },
    responseShape: { code: '<digits:1>' },
    capturedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  }
}

function storageHarness(initial: Record<string, unknown> = {}) {
  const stored = { ...initial }
  const get = vi.fn(async (key: string) => ({ [key]: stored[key] }))
  const set = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(stored, value)
  })
  vi.stubGlobal('chrome', { storage: { session: { get, set } } })
  return { stored, get, set }
}

describe('Binance Square probe background store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does no storage work when beta capture is disabled', async () => {
    const { get, set } = storageHarness()

    await expect(
      liveBinanceProbeObservations({ now: NOW, enabled: false }),
    ).resolves.toEqual([])
    await appendBinanceProbeObservation(observation(), {
      now: NOW,
      enabled: false,
    })

    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps every probe RPC storage-free when beta capture is disabled', async () => {
    const { get, set } = storageHarness()
    const requests = [
      { type: 'get-binance-probe-targets' },
      {
        type: 'report-binance-probe-observation',
        observation: observation(),
      },
      { type: 'export-binance-probe-observations' },
      { type: 'clear-binance-probe-observations' },
    ] as const

    for (const request of requests) {
      await handleBinanceProbeRequest(request, { now: NOW, enabled: false })
    }

    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('drops invalid and expired observations and compacts storage', async () => {
    const live = observation()
    const expired = observation({
      id: '123e4567-e89b-42d3-a456-426614174001',
      capturedAt: new Date(NOW - 24 * 60 * 60 * 1_000 - 1).toISOString(),
    })
    const { stored, set } = storageHarness({
      binanceSquareProbeObservations: [
        expired,
        { ...live, method: 'GET' },
        live,
      ],
    })

    await expect(
      liveBinanceProbeObservations({ now: NOW, enabled: true }),
    ).resolves.toEqual([live])
    expect(stored.binanceSquareProbeObservations).toEqual([live])
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('authorizes only current reserved targets', async () => {
    const allowed = observation()
    const unauthorized = observation({
      id: '123e4567-e89b-42d3-a456-426614174001',
      target: { kind: 'CONTENT', id: '999999' },
    })
    const { stored } = storageHarness({
      binanceSquareTasks: {
        byContentId: {
          '335389698745313': [
            {
              campaignId: 'reserved',
              actionType: 'LIKE',
              targetUrl:
                'https://www.binance.com/en/square/post/335389698745313',
              targetContentId: '335389698745313',
              reserved: true,
            },
          ],
          '999999': [
            {
              campaignId: 'available',
              actionType: 'LIKE',
              targetUrl: 'https://www.binance.com/en/square/post/999999',
              targetContentId: '999999',
              reserved: false,
            },
          ],
        },
        byAuthorId: {},
      },
      binanceSquareProbeObservations: [],
    })

    await appendBinanceProbeObservation(unauthorized, {
      now: NOW,
      enabled: true,
    })
    await appendBinanceProbeObservation(allowed, {
      now: NOW,
      enabled: true,
    })

    expect(stored.binanceSquareProbeObservations).toEqual([allowed])
  })

  it('deduplicates by sanitized shape and retains the newest capture', async () => {
    const newer = observation({
      id: '123e4567-e89b-42d3-a456-426614174001',
      capturedAt: new Date(NOW - 500).toISOString(),
    })
    const older = observation({
      id: '123e4567-e89b-42d3-a456-426614174002',
      capturedAt: new Date(NOW - 2_000).toISOString(),
    })
    const newest = observation({
      id: '123e4567-e89b-42d3-a456-426614174003',
      capturedAt: new Date(NOW).toISOString(),
    })
    const harness = storageHarness({
      binanceSquareTasks: {
        byContentId: {
          '335389698745313': [{ reserved: true }],
        },
        byAuthorId: {},
      },
      binanceSquareProbeObservations: [newer],
    })

    await appendBinanceProbeObservation(older, { now: NOW, enabled: true })
    expect(harness.stored.binanceSquareProbeObservations).toEqual([newer])

    await appendBinanceProbeObservation(newest, { now: NOW, enabled: true })
    expect(harness.stored.binanceSquareProbeObservations).toEqual([newest])
  })

  it('keeps only the newest 100 live observations', async () => {
    const values = Array.from({ length: 101 }, (_, index) =>
      observation({
        id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
        status: index,
        capturedAt: new Date(NOW - 101 + index).toISOString(),
      }),
    )
    const { stored } = storageHarness({
      binanceSquareProbeObservations: values,
    })

    const result = await liveBinanceProbeObservations({
      now: NOW,
      enabled: true,
    })

    expect(result).toHaveLength(100)
    expect(result[0].status).toBe(1)
    expect(stored.binanceSquareProbeObservations).toEqual(result)
  })

  it('implements target, report, export, and clear without GraphQL', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const value = observation()
    const { stored } = storageHarness({
      binanceSquareTasks: {
        byContentId: {
          '335389698745313': [{ reserved: true }],
        },
        byAuthorId: {},
      },
      binanceSquareProbeObservations: [],
    })

    await expect(
      handleBinanceProbeRequest(
        { type: 'get-binance-probe-targets' },
        { now: NOW, enabled: true },
      ),
    ).resolves.toEqual({
      type: 'binance-probe-targets',
      targets: [{ kind: 'CONTENT', id: '335389698745313' }],
    })
    await expect(
      handleBinanceProbeRequest(
        { type: 'report-binance-probe-observation', observation: value },
        { now: NOW, enabled: true },
      ),
    ).resolves.toEqual({ type: 'ack' })
    await expect(
      handleBinanceProbeRequest(
        { type: 'export-binance-probe-observations' },
        { now: NOW, enabled: true },
      ),
    ).resolves.toEqual({
      type: 'binance-probe-observations',
      observations: [value],
    })
    await expect(
      handleBinanceProbeRequest(
        { type: 'clear-binance-probe-observations' },
        { now: NOW, enabled: true },
      ),
    ).resolves.toEqual({ type: 'ack' })
    expect(stored.binanceSquareProbeObservations).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
