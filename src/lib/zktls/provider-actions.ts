export type ProviderAction =
  | { kind: 'wait_for_selector'; selector: string; timeout_ms: number }
  | { kind: 'click'; selector: string }
  | { kind: 'input'; selector: string; text: string }
  | { kind: 'submit'; selector: string }
  | { kind: 'navigate'; path: string }

const MAX_ACTIONS = 8
const MAX_SELECTOR_BYTES = 256
const MAX_TEXT_BYTES = 512
const MAX_WAIT_MS = 5_000
const MAX_TOTAL_WAIT_MS = 15_000

function fail(message: string): never {
  throw new Error(message)
}

function object(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object.`)
}

function boundedString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).length > max
  )
    fail(`${name} must be a bounded string.`)
  return value
}

function boundedPath(value: unknown, name: string): string {
  const path = boundedString(value, name, 512)
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('#') ||
    path.includes('\\') ||
    Array.from(path).some((char) => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    fail(`${name} must be a relative path.`)
  return path
}

export function validateProviderActions(value: unknown): ProviderAction[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS)
    fail('actions are invalid.')
  let totalWait = 0
  return value.map((item, index) => {
    const name = `actions[${index}]`
    object(item, name)
    if (item.kind === 'wait_for_selector') {
      if (
        Object.keys(item).some(
          (key) => !['kind', 'selector', 'timeout_ms'].includes(key),
        )
      )
        fail(`${name} contains an unknown field.`)
      const selector = boundedString(
        item.selector,
        `${name}.selector`,
        MAX_SELECTOR_BYTES,
      )
      if (
        typeof item.timeout_ms !== 'number' ||
        !Number.isInteger(item.timeout_ms) ||
        item.timeout_ms < 1 ||
        item.timeout_ms > MAX_WAIT_MS
      )
        fail(`${name}.timeout_ms is outside its allowed range.`)
      totalWait += item.timeout_ms
      if (totalWait > MAX_TOTAL_WAIT_MS)
        fail('actions exceed their wait limit.')
      return { kind: item.kind, selector, timeout_ms: item.timeout_ms }
    }
    if (item.kind === 'click' || item.kind === 'submit') {
      if (Object.keys(item).some((key) => !['kind', 'selector'].includes(key)))
        fail(`${name} contains an unknown field.`)
      return {
        kind: item.kind,
        selector: boundedString(
          item.selector,
          `${name}.selector`,
          MAX_SELECTOR_BYTES,
        ),
      }
    }
    if (item.kind === 'navigate') {
      if (Object.keys(item).some((key) => !['kind', 'path'].includes(key)))
        fail(`${name} contains an unknown field.`)
      return { kind: item.kind, path: boundedPath(item.path, `${name}.path`) }
    }
    if (item.kind === 'input') {
      if (
        Object.keys(item).some(
          (key) => !['kind', 'selector', 'text'].includes(key),
        )
      )
        fail(`${name} contains an unknown field.`)
      return {
        kind: item.kind,
        selector: boundedString(
          item.selector,
          `${name}.selector`,
          MAX_SELECTOR_BYTES,
        ),
        text: boundedString(item.text, `${name}.text`, MAX_TEXT_BYTES),
      }
    }
    return fail(`${name}.kind is unsupported.`)
  })
}

// This function is serialized by chrome.scripting.executeScript. Keep it
// self-contained: no remote code, page-provided code, or outer closures.
export async function runProviderActionsInPage(
  expectedOrigin: string,
  actions: ProviderAction[],
): Promise<void> {
  if (window.location.origin !== expectedOrigin)
    throw new Error('provider action origin mismatch')

  const select = (selector: string): Element => {
    const element = document.querySelector(selector)
    if (!element) throw new Error('provider action selector was not found')
    return element
  }
  const waitForSelector = (selector: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      try {
        if (document.querySelector(selector)) {
          resolve()
          return
        }
      } catch {
        reject(new Error('provider action selector was invalid'))
        return
      }
      const observer = new MutationObserver(() => {
        try {
          if (!document.querySelector(selector)) return
          clearTimeout(timer)
          observer.disconnect()
          resolve()
        } catch {
          clearTimeout(timer)
          observer.disconnect()
          reject(new Error('provider action selector was invalid'))
        }
      })
      const timer = setTimeout(() => {
        observer.disconnect()
        reject(new Error('provider action timed out'))
      }, timeoutMs)
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      })
    })

  for (const action of actions) {
    if (action.kind === 'navigate') {
      window.location.assign(action.path)
      continue
    }
    if (action.kind === 'wait_for_selector') {
      await waitForSelector(action.selector, action.timeout_ms)
      continue
    }
    const element = select(action.selector)
    if (action.kind === 'click') {
      if (!(element instanceof HTMLElement))
        throw new Error('provider action target was invalid')
      element.click()
      continue
    }
    if (action.kind === 'submit') {
      if (!(element instanceof HTMLFormElement))
        throw new Error('provider action submit target was invalid')
      element.requestSubmit()
      continue
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.value = action.text
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = action.text
    } else {
      throw new Error('provider action input target was invalid')
    }
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: action.text,
      }),
    )
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
}
