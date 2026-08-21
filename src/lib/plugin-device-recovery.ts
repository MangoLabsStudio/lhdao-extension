export function isPluginDeviceDenied(error: unknown): boolean {
  return typeof error === 'string' && /\bPLUGIN_DEVICE_DENIED\b/i.test(error)
}
