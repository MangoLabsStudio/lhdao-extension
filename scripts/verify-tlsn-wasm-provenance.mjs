import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PATCH_SHA = 'cc49bf7165c2b2094aa0f5834aec15e99aa870f8'

const EXPECTED = Object.freeze({
  upstreamTag: 'v0.1.0-alpha.15',
  upstreamCommit: '47aee45b53e06648c1b2ad3689b367b8c923fdec',
  patchRepository: 'https://github.com/MangoLabsStudio/lighthouse-tlsn',
  patchCommit: PATCH_SHA,
  buildCommand: 'cd crates/wasm && ./build.sh',
})

const FIELDS = [
  'buildCommand',
  'patchCommit',
  'patchRepository',
  'rustcVersion',
  'upstreamCommit',
  'upstreamTag',
  'wasmPackVersion',
  'wasmSha256',
]

export async function verifyTlsnWasmProvenance(directory) {
  const provenance = JSON.parse(
    await readFile(join(directory, 'PROVENANCE.json'), 'utf8'),
  )
  const fields = Object.keys(provenance).sort()
  if (JSON.stringify(fields) !== JSON.stringify(FIELDS)) {
    throw new Error('TLSNotary WASM provenance fields are invalid')
  }
  for (const [field, value] of Object.entries(EXPECTED)) {
    if (provenance[field] !== value) {
      throw new Error(`TLSNotary WASM ${field} is invalid`)
    }
  }
  for (const field of ['rustcVersion', 'wasmPackVersion']) {
    if (typeof provenance[field] !== 'string' || !provenance[field].trim()) {
      throw new Error(`TLSNotary WASM ${field} is invalid`)
    }
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.wasmSha256)) {
    throw new Error('TLSNotary WASM SHA-256 is invalid')
  }
  const wasm = await readFile(join(directory, 'tlsn_wasm_bg.wasm'))
  const actualSha256 = createHash('sha256').update(wasm).digest('hex')
  if (actualSha256 !== provenance.wasmSha256) {
    throw new Error('TLSNotary WASM SHA-256 does not match provenance')
  }
  return Object.freeze(provenance)
}
