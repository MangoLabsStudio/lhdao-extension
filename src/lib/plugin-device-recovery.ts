const PLUGIN_DEVICE_DENIED = 'PLUGIN_DEVICE_DENIED'

export function isPluginDeviceDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes(PLUGIN_DEVICE_DENIED)
}
