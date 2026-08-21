import { describe, expect, it } from 'vitest'
import { isPluginDeviceDenied } from '../plugin-device-recovery'

describe('isPluginDeviceDenied', () => {
  it('recognizes device denial inside backend error messages', () => {
    expect(
      isPluginDeviceDenied(
        '[HTTP 200] PLUGIN_DEVICE_DENIED: 你没有权限执行此操作。',
      ),
    ).toBe(true)
  })

  it('does not treat other authorization failures as device denial', () => {
    expect(isPluginDeviceDenied('PLUGIN_TOKEN_SCOPE_DENIED')).toBe(false)
  })
})
