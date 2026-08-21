import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

function permissionPage(): void {
  document.body.innerHTML = `
    <p id="origin"></p>
    <p id="connector"></p>
    <button type="button" id="allow" disabled>Allow</button>
    <p id="status">Loading</p>
  `
  history.replaceState({}, '', '/zktls-permission.html?request_id=req-1')
}

describe('zkTLS permission page', () => {
  beforeEach(() => {
    vi.resetModules()
    permissionPage()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('shows only safe hostnames and requests the exact signed patterns', async () => {
    const send = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: { type?: string }) =>
        message.type === 'zktls-permission-preview'
          ? {
              origins: [
                'https://api.example.com:8443',
                'https://app.example.com',
              ],
              connectorId: 'product-volume',
            }
          : null) as never)
    const request = vi
      .spyOn(chrome.permissions, 'request')
      .mockImplementation((async () => true) as never)

    await import('@/entrypoints/zktls-permission/main')
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>('#allow')?.disabled,
      ).toBe(false),
    )

    expect(document.querySelector('#origin')?.textContent).toBe(
      'Origins: api.example.com:8443, app.example.com',
    )
    expect(document.querySelector('#origin')?.textContent).not.toContain(
      'https://',
    )
    document.querySelector<HTMLButtonElement>('#allow')?.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith({
      origins: ['https://api.example.com:8443/*', 'https://app.example.com/*'],
    })
    expect(send).toHaveBeenLastCalledWith({
      type: 'zktls-permission-result',
      requestId: 'req-1',
      granted: true,
    })
  })

  test('rejects a preview with extra fields before requesting permission', async () => {
    vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue({
      origins: ['https://app.example.com'],
      connectorId: 'product-volume',
      injected: 'https://evil.example.com',
    })
    const request = vi.spyOn(chrome.permissions, 'request')

    await import('@/entrypoints/zktls-permission/main')
    await vi.waitFor(() =>
      expect(document.querySelector('#status')?.textContent).toBe(
        'Permission request has expired.',
      ),
    )
    expect(request).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('#allow')?.disabled).toBe(
      true,
    )
  })
})
