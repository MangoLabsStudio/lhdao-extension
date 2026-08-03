import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('source hygiene', () => {
  it('keeps guide-state as plain text source', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../src/lib/guide-state.ts'),
      'utf8',
    )
    expect(source).not.toContain('\0')
  })
})
