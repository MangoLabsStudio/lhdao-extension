import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('ships no product automation runtime, protocol, or proof build dependencies', () => {
  const root = resolve(import.meta.dirname, '..')
  const files = readdirSync(resolve(root, 'src'), { recursive: true })
    .map(String)
    .filter((file) => /\.(ts|tsx|graphql)$/.test(file) && !file.includes('__tests__'))
  const forbidden = /product-experience|productExperience|ProductExperience|ProductZkTls|zktls|tlsn-wasm|product-discovery/i
  expect(files.filter((file) => forbidden.test(file) || forbidden.test(readFileSync(resolve(root, 'src', file), 'utf8')))).toEqual([])
  const config = readFileSync(resolve(root, 'wxt.config.ts'), 'utf8')
  expect(config).not.toMatch(/offscreen|webRequest|debugger|wasm-unsafe-eval|https:\/\/\*\/\*/)
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  expect(pkg.dependencies).not.toHaveProperty('tlsn-wasm')
  expect(pkg.dependencies).not.toHaveProperty('decimal.js')
})
