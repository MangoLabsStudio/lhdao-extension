import type { ProofReviewUiState } from '@/lib/zktls/review-channel'

const RESPONSE_COPY = {
  json: '已读取 JSON 响应',
  empty: '响应没有记录',
  'non-json': '响应不是 JSON',
  oversize: '响应超出预览上限，未使用截断数据计算',
  unavailable: '未读到响应正文',
  invalid: '响应解析失败',
}

export function ProofReviewCard({
  state,
  onConfirm,
  onReread,
}: {
  state: ProofReviewUiState
  onConfirm(id: string): void
  onReread(): void
}) {
  const data = state.snapshot
  const activeStep =
    state.phase === 'proving' ? 2 : state.phase === 'ready' ? 1 : 0
  const title =
    state.phase === 'preparing'
      ? '正在准备读取'
      : state.phase === 'reading'
        ? '监听已就绪'
        : state.phase === 'proving'
          ? '正在生成证明'
          : state.phase === 'failed'
            ? '读取或证明失败'
            : '请确认读到的数据'
  const records =
    data?.response && typeof data.response === 'object'
      ? Array.isArray(data.response)
        ? [['响应记录', data.response] as const]
        : Object.entries(data.response).filter(([, value]) =>
            Array.isArray(value),
          )
      : []
  return (
    <section
      aria-label="本次读取的数据"
      className="mt-3 rounded-lg border border-teal-300/25 bg-slate-900/80 p-3 text-[11px] leading-relaxed text-slate-200"
    >
      <ol
        aria-label="验证步骤"
        className="mb-3 grid grid-cols-3 gap-1 border-b border-white/10 pb-3 text-[10px]"
      >
        {['读取数据', '核对数据', '生成证明'].map((label, index) => (
          <li
            key={label}
            aria-current={
              state.phase !== 'failed' && index === activeStep
                ? 'step'
                : undefined
            }
            className={
              index === activeStep && state.phase !== 'failed'
                ? 'font-bold text-teal-200'
                : 'text-slate-400'
            }
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <h3 role="status" className="font-bold text-teal-200">
        {title}
      </h3>
      {state.phase === 'failed' && (
        <p className="mt-1 text-rose-200">
          技术失败不代表条件不满足。请查看下方原始错误，处理后重新读取。
        </p>
      )}
      {state.phase === 'preparing' && (
        <p className="mt-1">
          请保持已登录的网站打开；如出现权限页，请完成授权。
        </p>
      )}
      {state.phase === 'reading' && (
        <p className="mt-1">
          刷新当前页面，或打开充值／历史记录。插件只监听这个标签页，读到数据后会在这里展示；尚未开始证明。
        </p>
      )}
      {state.phase === 'proving' && (
        <p className="mt-1">
          正在使用你确认的请求生成证明。最终结果以后端验证为准。
        </p>
      )}
      {state.error && (
        <p role="alert" className="mt-2 break-all font-mono text-rose-300">
          {state.error}
        </p>
      )}
      {data && (
        <>
          <p className="mt-1 font-semibold">{data.title}</p>
          <p className="mt-1 text-amber-200">本地预览 · 尚未验证</p>
          <dl className="mt-3 space-y-2 break-all">
            <div>
              <dt className="text-slate-400">来源页面</dt>
              <dd>
                {data.pageOrigin}
                {data.pagePath}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">数据接口</dt>
              <dd>
                {data.method} {data.targetOrigin}
                {data.requestPath}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">读取时间</dt>
              <dd>{new Date(data.capturedAt).toLocaleTimeString('zh-CN')}</dd>
            </div>
            {data.requestAccounts.map((account) => (
              <div key={account.name}>
                <dt className="text-slate-400">请求账号 · {account.name}</dt>
                <dd className="font-mono">{account.value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-slate-400">
                {data.account.source === 'response'
                  ? '响应中的归属钱包'
                  : '归属钱包（来自后端已验证绑定）'}
              </dt>
              <dd className="font-mono">
                {data.account.observed ?? '未读到，不能确认'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">本次应验证的钱包</dt>
              <dd className="font-mono">
                {data.account.expected ?? '后端未提供，不能确认'}
              </dd>
            </div>
          </dl>
          <p
            className={`mt-2 ${data.account.status === 'matched' ? 'text-teal-200' : 'text-rose-300'}`}
          >
            {data.account.status === 'matched'
              ? '钱包信息一致；这不是所有权验证结果。'
              : data.account.status === 'mismatch'
                ? '钱包不一致。请检查网站当前登录账号，再重新读取。'
                : '无法确定归属钱包，不能开始证明。'}
          </p>
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="text-slate-400">
              {RESPONSE_COPY[data.responseState]}
            </p>
            {records.map(([name, value]) => (
              <p key={name}>
                {name}：{Array.isArray(value) ? value.length : 0} 条记录
              </p>
            ))}
            {data.values.map((value) => (
              <div
                key={value.output}
                className="mt-2 rounded-md bg-teal-300/10 p-2"
              >
                <p className="text-slate-400">
                  按保存规则计算 · {value.output}
                </p>
                <p className="break-all text-sm font-bold tabular-nums text-teal-200">
                  {value.value}
                  {value.unit ? ` ${value.unit}` : ''}
                </p>
              </div>
            ))}
            {data.error && (
              <p
                role="alert"
                className="mt-2 break-all font-mono text-rose-300"
              >
                {data.error}
              </p>
            )}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-slate-300">
              查看请求与响应（凭证已隐藏）
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 font-mono text-[10px]">
              {JSON.stringify(
                { request: data.request, response: data.response },
                null,
                2,
              )}
            </pre>
          </details>
          <p className="mt-3 text-[10px] text-slate-400">
            确认只代表同意使用这批数据。证明会重放该请求，响应可能变化。
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              disabled={!data.canConfirm || !!data.error}
              onClick={() => onConfirm(data.id)}
              className="rounded-lg bg-teal-300 px-3 py-2 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认数据并开始证明
            </button>
            <button
              type="button"
              onClick={onReread}
              className="rounded-lg border border-slate-600 px-3 py-2 text-slate-200"
            >
              重新读取
            </button>
          </div>
        </>
      )}
    </section>
  )
}
