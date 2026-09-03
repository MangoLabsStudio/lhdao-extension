import type { RequestBodyDetails, V4CaptureBinding } from '../capture'
import type { V4TemplateValue } from '../interpreter'
import { matchV4Value } from '../v4-template'

export type NearMatchCode =
  | 'NO_REQUEST_OBSERVED'
  | 'NO_NEAR_MATCH'
  | 'REQUEST_TEMPLATE_MISMATCH'
  | 'AMBIGUOUS_REQUEST'
export type NearMatchSummary = {
  code: NearMatchCode
  observed: number
  sameOrigin: number
  sameMethod: number
  samePath: number
  differences: Array<{ category: string; pointer: string }>
}
type Candidate = {
  origin: boolean
  method: boolean
  path: boolean
  differences: NearMatchSummary['differences']
}

function pointerPart(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) &&
    !/token|secret|password|authorization|cookie/i.test(key)
    ? key.replaceAll('~', '~0').replaceAll('/', '~1')
    : '*'
}

/** Diagnostic-only: bounded categories/pointers, never request values or selection. */
export class NearMatchDiagnostics {
  private readonly candidates = new Map<string, Candidate>()
  private ambiguous = false
  constructor(private readonly binding: V4CaptureBinding) {}

  observe(details: RequestBodyDetails): void {
    const binding = this.binding
    if (
      details.tabId !== binding.tabId ||
      details.frameId !== binding.frameId ||
      details.initiator !== binding.pageOrigin ||
      !binding.matcher.resource_types.includes(details.type as never)
    )
      return
    if (
      details.url.length > 8192 ||
      (!this.candidates.has(details.requestId) && this.candidates.size >= 128)
    )
      return
    try {
      const url = new URL(details.url)
      const previous = this.candidates.get(details.requestId)
      const candidate: Candidate = previous ?? {
        origin: url.origin === binding.targetOrigin,
        method: details.method === binding.method,
        path: url.pathname === binding.matcher.path.value,
        differences: [],
      }
      this.candidates.set(details.requestId, candidate)
      if (!candidate.origin) return
      const add = (category: string, pointer: string) => {
        if (
          candidate.differences.length >= 32 ||
          candidate.differences.some(
            (entry) => entry.category === category && entry.pointer === pointer,
          )
        )
          return
        candidate.differences.push({ category, pointer })
      }
      if (!candidate.method) add('METHOD', '/method')
      if (!candidate.path) {
        add('PATH', '/path')
        return
      }
      const diff = (
        actual: unknown,
        template: V4TemplateValue,
        pointer: string,
        depth = 0,
        query = false,
      ): void => {
        if (depth > 16 || candidate.differences.length >= 32) return
        if (
          template &&
          typeof template === 'object' &&
          !Array.isArray(template) &&
          !('$var' in template) &&
          !('$concat' in template)
        ) {
          if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
            add('SHAPE', pointer)
            return
          }
          const record = actual as Record<string, unknown>
          for (const key of Object.keys(template).slice(0, 128)) {
            const child = `${pointer}/${pointerPart(key)}`
            if (!Object.hasOwn(record, key)) add('MISSING_FIELD', child)
            else
              diff(
                record[key],
                (template as Record<string, V4TemplateValue>)[key],
                child,
                depth + 1,
                query,
              )
          }
          for (const key of Object.keys(record).slice(0, 128))
            if (!Object.hasOwn(template, key))
              add('EXTRA_FIELD', `${pointer}/${pointerPart(key)}`)
          return
        }
        try {
          if (
            matchV4Value(
              actual as Parameters<typeof matchV4Value>[0],
              template,
              binding.resolvedVariables,
              binding.variables,
              query,
            ) === null
          )
            add('VALUE_OR_TYPE', pointer)
        } catch {
          add('VALUE_OR_TYPE', pointer)
        }
      }
      const query = Object.fromEntries(url.searchParams)
      if ([...url.searchParams].length !== Object.keys(query).length)
        add('DUPLICATE_FIELD', '/query')
      diff(query, binding.matcher.query.required, '/query', 0, true)
      if (details.requestBody && binding.template !== undefined) {
        const chunks = details.requestBody.raw ?? []
        const size = chunks.reduce(
          (sum, chunk) => sum + (chunk.bytes?.byteLength ?? 8193),
          0,
        )
        if (!chunks.length || size > 8192) add('BODY_UNREADABLE', '/body')
        else {
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(new Uint8Array(chunk.bytes!), offset)
            offset += chunk.bytes!.byteLength
          }
          try {
            diff(
              JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              ),
              binding.template,
              '/body',
            )
          } catch {
            add('BODY_UNREADABLE', '/body')
          }
        }
      }
      if (details.requestHeaders) {
        for (const [name, expected] of Object.entries(
          binding.publicHeaders ?? {},
        )) {
          const values = details.requestHeaders.filter(
            (header) => header.name.toLowerCase() === name,
          )
          if (values.length !== 1)
            add(
              values.length ? 'DUPLICATE_HEADER' : 'MISSING_HEADER',
              `/headers/${pointerPart(name)}`,
            )
          else if (values[0].value !== expected)
            add('HEADER_VALUE', `/headers/${pointerPart(name)}`)
        }
        if (
          binding.contentType &&
          details.requestHeaders.filter(
            (header) =>
              header.name.toLowerCase() === 'content-type' &&
              header.value === binding.contentType,
          ).length !== 1
        )
          add('CONTENT_TYPE', '/headers/content-type')
      }
    } catch {
      /* Diagnostics never affect exact signed capture. */
    }
  }

  markAmbiguous(): void {
    this.ambiguous = true
  }

  summary(): NearMatchSummary {
    const entries = [...this.candidates.values()]
    const sameOrigin = entries.filter((entry) => entry.origin)
    const near = sameOrigin.filter((entry) => entry.path)
    const best = near.sort(
      (a, b) =>
        Number(b.method) - Number(a.method) ||
        a.differences.length - b.differences.length,
    )[0]
    return {
      code: this.ambiguous
        ? 'AMBIGUOUS_REQUEST'
        : !entries.length
          ? 'NO_REQUEST_OBSERVED'
          : !near.length
            ? 'NO_NEAR_MATCH'
            : 'REQUEST_TEMPLATE_MISMATCH',
      observed: entries.length,
      sameOrigin: sameOrigin.length,
      sameMethod: sameOrigin.filter((entry) => entry.method).length,
      samePath: near.length,
      differences: best?.differences.map((entry) => ({ ...entry })) ?? [],
    }
  }
}
