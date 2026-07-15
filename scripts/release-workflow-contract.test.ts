import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

async function releaseInputs() {
  const [workflow, packageSource] = await Promise.all([
    readFile(resolve(root, '.github/workflows/release.yml'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8'),
  ])
  return {
    workflow,
    packageJson: JSON.parse(packageSource) as {
      version: string
      scripts: Record<string, string>
    },
  }
}

function commandIndex(workflow: string, command: string): number {
  const index = workflow.indexOf(command)
  expect(index, `missing release command: ${command}`).toBeGreaterThan(-1)
  return index
}

describe('release workflow contract', () => {
  it('pins all three store artifacts to MV3 production builds', async () => {
    const { packageJson, workflow } = await releaseInputs()

    expect(packageJson.version).toBe('0.2.0')
    expect(packageJson.scripts.zip).toBe('wxt zip')
    expect(packageJson.scripts['zip:edge']).toBe('wxt zip -b edge')
    expect(packageJson.scripts['zip:firefox']).toMatch(
      /^wxt zip -b firefox .*--mv3|^wxt zip .*--mv3.*-b firefox/,
    )
    expect(packageJson.scripts['dev:firefox']).toContain('--mv3')
    expect(packageJson.scripts['build:firefox']).toContain('--mv3')

    expect(workflow).toContain('WXT_API_ENDPOINT: https://service.lhdao.top/graphql')
    expect(workflow).toContain('WXT_WEB_ENDPOINT: https://app.lhdao.top')
    expect(workflow).toContain('pnpm run zip')
    expect(workflow).toContain('pnpm run zip:edge')
    expect(workflow).toContain('pnpm run zip:firefox')
    expect(workflow).not.toContain('continue-on-error')
  })

  it('rejects a tag that does not exactly match the package version', async () => {
    const { workflow } = await releaseInputs()

    expect(workflow).toMatch(/GITHUB_REF_NAME/)
    expect(workflow).toMatch(/package\.json/)
    expect(workflow).toMatch(/v\$\{?PACKAGE_VERSION\}?/)
    expect(workflow).toMatch(/exit 1|test "\$GITHUB_REF_NAME"/)
  })

  it('fetches tag objects and rejects lightweight release tags', async () => {
    const { workflow } = await releaseInputs()

    expect(workflow).toMatch(/fetch-depth:\s*0/)
    expect(workflow).toContain('git cat-file -t "$GITHUB_REF_NAME"')
    expect(workflow).toMatch(/TAG_TYPE[^\n]*tag|"\$TAG_TYPE"[^\n]*"tag"/)
  })

  it('runs compile, tests, typecheck, and lint before packaging', async () => {
    const { workflow } = await releaseInputs()
    const install = commandIndex(workflow, 'pnpm install --frozen-lockfile')
    const compile = commandIndex(workflow, 'pnpm run compile')
    const test = commandIndex(workflow, 'pnpm run test')
    const typecheck = commandIndex(workflow, 'pnpm run typecheck')
    const lint = commandIndex(workflow, 'pnpm run lint')
    const zip = commandIndex(workflow, 'pnpm run zip')

    expect([install, compile, test, typecheck, lint, zip]).toEqual(
      [...[install, compile, test, typecheck, lint, zip]].sort((a, b) => a - b),
    )
  })

  it('extracts every final zip and verifies the extracted directories', async () => {
    const { workflow } = await releaseInputs()

    for (const browser of ['chrome', 'edge', 'firefox']) {
      expect(workflow).toMatch(
        new RegExp(`unzip[^\\n]*\\$\\{?[^\\n]*${browser}[^\\n]*\\}?`, 'i'),
      )
    }
    expect(workflow).toContain('node scripts/verify-product-manifests.mjs')
    expect(workflow).toMatch(/--chrome-dir[^\n]+/)
    expect(workflow).toMatch(/--edge-dir[^\n]+/)
    expect(workflow).toMatch(/--firefox-dir[^\n]+/)
  })

  it('uploads only the same three verified store zips', async () => {
    const { workflow } = await releaseInputs()
    const filesBlock = workflow.match(/files:\s*\|([\s\S]*?)\n\s*(?:[A-Za-z_-]+:|$)/)?.[1]
    const uploadedFiles = filesBlock
      ?.trim()
      .split('\n')
      .map((line) => line.trim())

    expect(filesBlock).toBeDefined()
    expect(workflow).toContain('id: package')
    expect(workflow).toContain('version=$PACKAGE_VERSION')
    expect(uploadedFiles).toEqual(
      ['chrome', 'edge', 'firefox'].map(
        (browser) =>
          `.output/lhdao-extension-\${{ steps.package.outputs.version }}-${browser}.zip`,
      ),
    )
    expect(filesBlock).not.toContain('sources')
    expect(filesBlock).not.toContain('*')
  })
})
