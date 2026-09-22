import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
})

it('does not execute inherited serializers while initializing envelope bounds', async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
  let calls = 0
  let probe: typeof import('../binance-square-probe')
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        calls += 1
        return null
      },
    })
    vi.resetModules()
    probe = await import('../binance-square-probe')
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, 'toJSON', previous)
    } else {
      Reflect.deleteProperty(Object.prototype, 'toJSON')
    }
  }

  const envelope = (digits: number) => ({
    __lhBinanceProbe: true,
    observation: {
      id: '123e4567-e89b-42d3-a456-426614174000',
      method: 'POST',
      path: '/bapi/example',
      status: 200,
      target: { kind: 'CONTENT', id: '335389698745313' },
      requestShape: { text: `<string:${'1'.repeat(digits)}>` },
      responseShape: { code: '<digits:1>' },
      capturedAt: '2026-08-04T00:00:00.000Z',
    },
  })
  const baseLength = JSON.stringify(envelope(1)).length - 1
  const oversized = envelope(16_400 - baseLength)

  expect(calls).toBe(0)
  expect(JSON.stringify(oversized)).toHaveLength(16_400)
  expect(probe.parseProbeObservation(oversized.observation)).not.toBeNull()
  expect(probe.parseProbeObservationMessage(oversized)).toBeNull()
})
