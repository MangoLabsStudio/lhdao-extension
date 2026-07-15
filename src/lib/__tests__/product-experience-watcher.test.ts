import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductExperienceRule } from '@/types/product-experience'
import {
  createProductExperienceWatcherLifecycle,
  startProductExperienceWatcher,
} from '../product-experience-watcher'

const CLIENT_ORIGIN = 'https://client.example'

function setUrl(url: string): void {
  ;(
    window as typeof window & {
      happyDOM: { setURL(nextUrl: string): void }
    }
  ).happyDOM.setURL(url)
}

function rule(
  id: string,
  selector: string,
  urlPattern = `${CLIENT_ORIGIN}/app/*`,
): ProductExperienceRule {
  return {
    id,
    title: id,
    urlPattern,
    selector,
    condition: {
      type: 'ATTRIBUTE_EQUALS',
      attributeName: 'data-state',
      expected: 'done',
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

async function expectMatchedRuleIds(
  onEvidence: ReturnType<typeof vi.fn>,
  expectedRuleIds: string[],
): Promise<void> {
  await vi.waitFor(() => {
    expect(onEvidence).toHaveBeenCalled()
    const matches = onEvidence.mock.calls.at(-1)?.[0]
    expect(matches.map((match: { ruleId: string }) => match.ruleId)).toEqual(
      expectedRuleIds,
    )
  })
}

describe('startProductExperienceWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setUrl(`${CLIENT_ORIGIN}/app/start?private=query#fragment`)
    document.body.replaceChildren()
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
      {
        width: 10,
        height: 10,
      } as DOMRect,
    ] as unknown as DOMRectList)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('evaluates matching rules immediately without waiting for a timer', async () => {
    document.body.innerHTML =
      '<div id="ready" data-state="done" style="opacity: 1"></div>'
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })

    await expectMatchedRuleIds(onEvidence, ['ready'])
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    watcher.stop()
  })

  it('debounces DOM mutations for 300ms and coalesces repeated changes', async () => {
    document.body.innerHTML =
      '<div id="ready" data-state="pending" style="opacity: 1"></div>'
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })
    await flushMicrotasks()

    const element = document.querySelector('#ready')
    element?.setAttribute('data-state', 'almost')
    await flushMicrotasks()
    element?.setAttribute('data-state', 'done')
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(299)
    expect(onEvidence).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expectMatchedRuleIds(onEvidence, ['ready'])
    expect(onEvidence).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('re-evaluates on popstate and hashchange route signals', async () => {
    document.body.innerHTML = [
      '<div id="route" data-state="done" style="opacity: 1"></div>',
      '<div id="hash" data-state="pending" style="opacity: 1"></div>',
    ].join('')
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [
        rule('route', '#route', `${CLIENT_ORIGIN}/app/next`),
        rule('hash', '#hash', `${CLIENT_ORIGIN}/app/*`),
      ],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })
    await flushMicrotasks()

    window.history.replaceState({}, '', '/app/next')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await expectMatchedRuleIds(onEvidence, ['route'])

    document.querySelector('#hash')?.setAttribute('data-state', 'done')
    window.history.replaceState({}, '', '/app/next#finished')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await expectMatchedRuleIds(onEvidence, ['route', 'hash'])
    watcher.stop()
  })

  it('detects same-origin pushState navigation by polling the URL', async () => {
    document.body.innerHTML =
      '<div id="next" data-state="done" style="opacity: 1"></div>'
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('next', '#next', `${CLIENT_ORIGIN}/app/next`)],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })
    await flushMicrotasks()

    window.history.pushState({}, '', '/app/next?secret=1#private')
    await vi.advanceTimersByTimeAsync(1_000)

    await expectMatchedRuleIds(onEvidence, ['next'])
    watcher.stop()
  })

  it('keeps matches monotonic when previously matched DOM stops matching', async () => {
    document.body.innerHTML = [
      '<div id="first" data-state="done" style="opacity: 1"></div>',
      '<div id="second" data-state="pending" style="opacity: 1"></div>',
    ].join('')
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('first', '#first'), rule('second', '#second')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })
    await expectMatchedRuleIds(onEvidence, ['first'])

    document.querySelector('#first')?.setAttribute('data-state', 'pending')
    document.querySelector('#second')?.setAttribute('data-state', 'done')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)

    await expectMatchedRuleIds(onEvidence, ['first', 'second'])
    expect(onEvidence).toHaveBeenCalledTimes(2)

    document.querySelector('#second')?.setAttribute('data-state', 'pending')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    expect(onEvidence).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('disconnects the observer and clears timers and route listeners on stop', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    document.body.innerHTML =
      '<div id="ready" data-state="pending" style="opacity: 1"></div>'
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })
    await flushMicrotasks()
    document.querySelector('#ready')?.setAttribute('data-state', 'done')
    await flushMicrotasks()

    watcher.stop()
    watcher.stop()
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith(
      'popstate',
      expect.any(Function),
    )
    expect(removeEventListener).toHaveBeenCalledWith(
      'hashchange',
      expect.any(Function),
    )
    expect(onEvidence).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops with a non-sensitive status after leaving an allowed origin', async () => {
    document.body.innerHTML =
      '<div id="ready" data-state="pending" style="opacity: 1"></div>'
    const onEvidence = vi.fn()
    const onStatus = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
      onStatus,
    })
    await flushMicrotasks()

    setUrl('https://other.example/app/start?secret=1#private')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(onStatus).toHaveBeenCalledWith('origin-not-allowed')
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    setUrl(`${CLIENT_ORIGIN}/app/start`)
    document.querySelector('#ready')?.setAttribute('data-state', 'done')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushMicrotasks()
    expect(onEvidence).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('allows HTTPS and exact loopback HTTP but rejects ordinary HTTP', async () => {
    document.body.innerHTML =
      '<div id="ready" data-state="done" style="opacity: 1"></div>'
    setUrl('http://localhost:4173/app/start')
    const loopbackEvidence = vi.fn()

    const loopbackWatcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready', 'http://localhost:4173/app/*')],
      allowedOrigins: ['http://localhost:4173'],
      completionMode: 'ALL',
      onEvidence: loopbackEvidence,
    })
    await expectMatchedRuleIds(loopbackEvidence, ['ready'])
    loopbackWatcher.stop()

    setUrl('http://client.example/app/start')
    const onStatus = vi.fn()
    const unsafeWatcher = startProductExperienceWatcher({
      rules: [rule('ready', '#ready', 'http://client.example/app/*')],
      allowedOrigins: ['http://client.example'],
      completionMode: 'ALL',
      onEvidence: vi.fn(),
      onStatus,
    })
    await flushMicrotasks()

    expect(onStatus).toHaveBeenCalledWith('origin-not-allowed')
    unsafeWatcher.stop()
  })

  it('fails closed and stops when a DOM evaluator throws', async () => {
    document.body.innerHTML =
      '<div id="ready" data-state="done" style="opacity: 1"></div>'
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('hostile DOM getter')
    })
    const onEvidence = vi.fn()
    const onStatus = vi.fn()

    startProductExperienceWatcher({
      rules: [rule('ready', '#ready')],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
      onStatus,
    })

    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith('evaluation-error'),
    )
    expect(onEvidence).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('product experience runtime lifecycle', () => {
  function createContext() {
    let invalid = false
    let invalidate: (() => void) | undefined
    return {
      context: {
        get isInvalid() {
          return invalid
        },
        onInvalidated(callback: () => void) {
          invalidate = callback
          return () => {
            if (invalidate === callback) invalidate = undefined
          }
        },
      },
      invalidate() {
        invalid = true
        invalidate?.()
      },
    }
  }

  it('stops the old watcher when a newer runtime injection invalidates its context', () => {
    const first = createContext()
    const firstWatcher = { stop: vi.fn() }
    const firstLifecycle = createProductExperienceWatcherLifecycle(
      first.context,
    )
    firstLifecycle.attach(firstWatcher)

    first.invalidate()
    const second = createContext()
    const secondWatcher = { stop: vi.fn() }
    const secondLifecycle = createProductExperienceWatcherLifecycle(
      second.context,
    )
    secondLifecycle.attach(secondWatcher)

    expect(firstWatcher.stop).toHaveBeenCalledTimes(1)
    expect(firstLifecycle.isStopped()).toBe(true)
    expect(secondWatcher.stop).not.toHaveBeenCalled()
    expect(secondLifecycle.isStopped()).toBe(false)

    secondLifecycle.stop()
  })

  it('stops a watcher attached after its context was already invalidated', () => {
    const runtime = createContext()
    runtime.invalidate()
    const lifecycle = createProductExperienceWatcherLifecycle(runtime.context)
    const watcher = { stop: vi.fn() }

    lifecycle.attach(watcher)

    expect(lifecycle.isStopped()).toBe(true)
    expect(watcher.stop).toHaveBeenCalledTimes(1)
  })
})
