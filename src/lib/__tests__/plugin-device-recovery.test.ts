import { describe, expect, it } from 'vitest'
import { isPluginDeviceDenied } from '../plugin-device-recovery'

describe('plugin device recovery', () => {
  it.each([
    'PLUGIN_DEVICE_DENIED: 您没有权限执行此操作。',
    '[HTTP 200] PLUGIN_DEVICE_DENIED: 您没有权限执行此操作。',
  ])('recognizes a device denial in %s', (message) => {
    expect(isPluginDeviceDenied(message)).toBe(true)
  })

  it('ignores unrelated plugin errors', () => {
    expect(isPluginDeviceDenied('PLUGIN_OPERATION_DENIED')).toBe(false)
  })
})
