export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new WeakSet<object>(), false)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function serializeCanonical(
  value: unknown,
  ancestors: WeakSet<object>,
  objectField: boolean,
): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw nonJsonError()
      return JSON.stringify(value)
    case 'undefined':
      if (objectField) return ''
      throw nonJsonError()
    case 'bigint':
    case 'function':
    case 'symbol':
      throw nonJsonError()
  }

  if (typeof value !== 'object') throw nonJsonError()
  if (ancestors.has(value)) throw nonJsonError()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) =>
        serializeCanonical(item, ancestors, false),
      ).join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw nonJsonError()
    }

    const fields: string[] = []
    for (const key of Object.keys(value).sort()) {
      const fieldValue = (value as Record<string, unknown>)[key]
      if (fieldValue === undefined) continue
      fields.push(
        `${JSON.stringify(key)}:${serializeCanonical(fieldValue, ancestors, true)}`,
      )
    }
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function nonJsonError(): TypeError {
  return new TypeError('Cannot canonicalize non-JSON value')
}
