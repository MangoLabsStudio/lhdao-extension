import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

let verifier = {}
try {
  verifier = await import('./verify-tlsn-wasm-provenance.mjs')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

const { PATCH_SHA, verifyTlsnWasmProvenance } = verifier

function requireVerifier() {
  assert.equal(
    typeof verifyTlsnWasmProvenance,
    'function',
    'verifyTlsnWasmProvenance must be exported',
  )
  return verifyTlsnWasmProvenance
}

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lighthouse-tlsn-wasm-'))
  const bytes = Buffer.from('reviewed wasm')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'tlsn_wasm_bg.wasm'), bytes)
  await writeFile(
    join(directory, 'PROVENANCE.json'),
    `${JSON.stringify(
      {
        upstreamTag: 'v0.1.0-alpha.15',
        upstreamCommit: '47aee45b53e06648c1b2ad3689b367b8c923fdec',
        patchRepository: 'https://github.com/MangoLabsStudio/lighthouse-tlsn',
        patchCommit: PATCH_SHA,
        buildCommand: 'cd crates/wasm && ./build.sh',
        rustcVersion: 'rustc test',
        wasmPackVersion: 'wasm-pack test',
        wasmSha256: createHash('sha256').update(bytes).digest('hex'),
        ...overrides,
      },
      null,
      2,
    )}\n`,
  )
  return directory
}

test('accepts only the reviewed Lighthouse TLSNotary WASM provenance', async () => {
  const verify = requireVerifier()
  await assert.doesNotReject(verify(await fixture()))
  await assert.rejects(
    verify(
      await fixture({
        patchRepository: 'https://github.com/tlsnotary/tlsn',
      }),
    ),
    /patchRepository/i,
  )
  await assert.rejects(
    verify(await fixture({ wasmSha256: '0'.repeat(64) })),
    /WASM SHA-256/i,
  )
})

test('accepts the vendored Lighthouse TLSNotary WASM package', async () => {
  const verify = requireVerifier()
  await assert.doesNotReject(
    verify(join(process.cwd(), 'vendor/tlsn-wasm')),
  )
})
