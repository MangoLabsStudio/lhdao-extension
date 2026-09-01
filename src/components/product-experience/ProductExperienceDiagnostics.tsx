import * as React from 'react'
import type {
  ProductZkTlsDiagnostic,
  ProductZkTlsDiagnosticEvent,
} from '@/types/product-experience'

interface ProductExperienceDiagnosticsProps {
  diagnostic: ProductZkTlsDiagnostic
}

const STATUS_COPY = {
  running: '进行中',
  passed: '完成',
  failed: '失败',
} as const

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function eventPayload(event: ProductZkTlsDiagnosticEvent): unknown {
  return event.error === undefined ? event.details : event.error
}

export function ProductExperienceDiagnostics({
  diagnostic,
}: ProductExperienceDiagnosticsProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'done' | 'failed'>(
    'idle',
  )
  const hasFailure = diagnostic.events.some(
    (event) => event.status === 'failed',
  )
  const latest = diagnostic.events.at(-1)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json(diagnostic))
      setCopyState('done')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <details
      data-testid="zktls-diagnostics"
      open={hasFailure ? true : undefined}
      className="group mt-3 overflow-hidden rounded-lg border border-cyan-300/15 bg-slate-950/80"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] marker:hidden">
        <span className="font-black uppercase tracking-[0.13em] text-cyan-200">
          诊断记录
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-slate-400">
          {latest?.stage ?? '尚无事件'}
        </span>
        <span
          aria-hidden="true"
          className="text-[9px] text-slate-500 transition-transform group-open:rotate-90"
        >
          ▶
        </span>
      </summary>

      <div className="border-t border-white/8 px-3 pt-2 pb-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <code className="truncate text-[8px] text-slate-500">
            {diagnostic.correlationId}
          </code>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded border border-cyan-300/20 bg-cyan-300/8 px-2 py-1 text-[9px] font-bold text-cyan-200 hover:bg-cyan-300/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
          >
            {copyState === 'done'
              ? '已复制'
              : copyState === 'failed'
                ? '复制失败'
                : '复制诊断'}
          </button>
        </div>

        <ol className="space-y-2">
          {diagnostic.events.map((event) => {
            const payload = eventPayload(event)
            return (
              <li
                key={`${event.at}-${event.stage}-${event.status}`}
                className="border-l border-slate-700 pl-2.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      event.status === 'failed'
                        ? 'bg-rose-300'
                        : event.status === 'passed'
                          ? 'bg-teal-300'
                          : 'animate-pulse bg-amber-300'
                    }`}
                  />
                  <code className="min-w-0 flex-1 break-all text-[9px] font-bold text-slate-200">
                    {event.stage}
                  </code>
                  <span className="shrink-0 text-[8px] text-slate-500">
                    {STATUS_COPY[event.status]}
                  </span>
                </div>
                {payload !== undefined && (
                  <pre
                    className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border px-2 py-1.5 font-mono text-[8px] leading-relaxed ${
                      event.status === 'failed'
                        ? 'border-rose-300/15 bg-rose-950/30 text-rose-100'
                        : 'border-white/5 bg-black/25 text-slate-300'
                    }`}
                  >
                    {json(payload)}
                  </pre>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </details>
  )
}
