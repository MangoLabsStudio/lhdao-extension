export {}

const originElement = document.querySelector<HTMLParagraphElement>('#origin')!
const connector = document.querySelector<HTMLParagraphElement>('#connector')!
const allow = document.querySelector<HTMLButtonElement>('#allow')!
const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
const requestId = new URLSearchParams(location.search).get('request_id')
type Preview = { origin: string; connectorId: string }
let preview: Preview | null = null

void (async () => {
  if (!requestId) {
    statusElement.textContent = 'Permission request is invalid.'
    return
  }
  preview = (await chrome.runtime.sendMessage({
    type: 'zktls-permission-preview',
    requestId,
  })) as Preview | null
  if (!preview) {
    statusElement.textContent = 'Permission request has expired.'
    return
  }
  originElement.textContent = `Origin: ${preview.origin}`
  connector.textContent = `Connector: ${preview.connectorId}`
  allow.disabled = false
})()

allow.addEventListener('click', () => {
  if (!preview || !requestId) return
  allow.disabled = true
  void chrome.permissions
    .request({ origins: [`${preview.origin}/*`] })
    .then(async (granted) => {
      await chrome.runtime.sendMessage({
        type: 'zktls-permission-result',
        requestId,
        granted,
      })
      statusElement.textContent = granted
        ? 'Allowed. Return to Lighthouse.'
        : 'Denied. Return to Lighthouse.'
    })
})
