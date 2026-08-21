import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'

let verifier = {}
try {
  verifier = await import('./verify-product-manifests.mjs')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

const {
  DEFAULT_OUTPUT_DIRECTORIES,
  resolveEndpointPolicy,
  resolveRequestedDirectories,
  verifyManifestDirectory,
  verifyPackageScripts,
} = verifier

const PRODUCTION_HOSTS = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://www.binance.com/*',
  'https://service.lhdao.top/*',
  'https://app.lhdao.top/*',
]

const BETA_HOSTS = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://www.binance.com/*',
  'https://service.lhdaobeta.top/*',
  'https://app.lhdaobeta.top/*',
]

function validManifest(overrides = {}) {
  return {
    manifest_version: 3,
    name: 'Lighthouse',
    version: '0.2.2',
    permissions: [
      'storage',
      'alarms',
      'activeTab',
      'scripting',
      'offscreen',
      'webRequest',
    ],
    host_permissions: PRODUCTION_HOSTS,
    optional_host_permissions: ['https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    content_scripts: [
      {
        matches: ['https://x.com/*', 'https://twitter.com/*'],
        js: ['content-scripts/content.js'],
      },
      {
        matches: ['https://app.lhdao.top/*'],
        js: ['content-scripts/web-presence.js'],
      },
      {
        matches: [
          'https://www.binance.com/*/square/*',
          'https://www.binance.com/square/*',
        ],
        js: ['content-scripts/binance-square-probe.js'],
      },
    ],
    ...overrides,
  }
}

async function manifestDirectory(manifest = validManifest(), withRuntime = true) {
  const directory = await mkdtemp(join(tmpdir(), 'lhdao-manifest-'))
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  if (withRuntime) {
    const contentScripts = join(directory, 'content-scripts')
    await mkdir(contentScripts, { recursive: true })
    await writeFile(
      join(contentScripts, 'product-experience.js'),
      '/* runtime evaluator */\n',
    )
    await writeFile(join(directory, 'tlsn_wasm.js'), '/* wasm loader */\n')
    await writeFile(join(directory, 'tlsn_wasm_bg.wasm'), 'wasm')
    await writeFile(join(directory, 'spawn.js'), '/* spawn */\n')
    const snippet = join(directory, 'snippets', 'web-spawn-05868593a72e2d44', 'js')
    await mkdir(snippet, { recursive: true })
    await writeFile(join(snippet, 'spawn.js'), '/* spawn */\n')
  }
  return directory
}

function requireFunction(value, name) {
  assert.equal(typeof value, 'function', `${name} must be exported`)
  return value
}

function productionManifestVerifier() {
  return requireFunction(verifyManifestDirectory, 'verifyManifestDirectory')
}

test('uses the three MV3 browser output directories by default', () => {
  assert.deepEqual(DEFAULT_OUTPUT_DIRECTORIES, [
    '.output/chrome-mv3',
    '.output/edge-mv3',
    '.output/firefox-mv3',
  ])
  const resolve = requireFunction(
    resolveRequestedDirectories,
    'resolveRequestedDirectories',
  )
  assert.deepEqual(resolve([]), DEFAULT_OUTPUT_DIRECTORIES)
  assert.deepEqual(
    resolve([
      '--chrome-dir',
      'custom/chrome',
      '--edge-dir',
      'custom/edge',
      '--firefox-dir',
      'custom/firefox',
    ]),
    [
      'custom/chrome',
      'custom/edge',
      'custom/firefox',
    ],
  )
  assert.throws(
    () => resolve(['--chrome-dir', 'custom/chrome']),
    /chrome.*edge.*firefox/i,
  )
})

test('accepts an exact production MV3 manifest with a runtime evaluator', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory()

  await assert.doesNotReject(verify(directory))
})

test('accepts the exact beta endpoint pair and manifest surfaces', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory(
    validManifest({
      host_permissions: BETA_HOSTS,
      content_scripts: [
        {
          matches: ['https://app.lhdaobeta.top/*'],
          js: ['content-scripts/web-presence.js'],
        },
      ],
    }),
  )

  await assert.doesNotReject(
    verify(directory, {
      environment: {
        WXT_API_ENDPOINT: 'https://service.lhdaobeta.top/graphql',
        WXT_WEB_ENDPOINT: 'https://app.lhdaobeta.top',
      },
    }),
  )
})

test.each([
  [
    'unknown endpoints',
    'https://service.unknown.example/graphql',
    'https://app.unknown.example',
  ],
  [
    'mixed production and beta endpoints',
    'https://service.lhdaobeta.top/graphql',
    'https://app.lhdao.top',
  ],
])('rejects %s as a release profile', async (_name, api, web) => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory()

  await assert.rejects(
    verify(directory, {
      environment: {
        WXT_API_ENDPOINT: api,
        WXT_WEB_ENDPOINT: web,
      },
    }),
    /release endpoint profile is unsupported/i,
  )
})

describe('requires exact version, permissions, and host permissions', () => {
  const verify = productionManifestVerifier()
  const cases = [
    ['manifest version', { manifest_version: 2 }, /manifest_version.*3/i],
    ['extension version', { version: '0.1.6' }, /version.*0\.2\.2/i],
    [
      'permissions',
      { permissions: ['storage', 'alarms', 'activeTab', 'scripting'] },
      /permissions.*offscreen/i,
    ],
    [
      'host permissions',
      { host_permissions: [...PRODUCTION_HOSTS, 'https://extra.example/*'] },
      /host_permissions.*extra\.example/i,
    ],
    [
      'optional permissions',
      { optional_permissions: ['tabs'] },
      /optional_permissions.*tabs/i,
    ],
    [
      'optional host permissions',
      { optional_host_permissions: ['https://customer.example/*'] },
      /optional_host_permissions.*customer\.example/i,
    ],
  ]

  for (const [name, overrides, expected] of cases) {
    test(name, async () => {
      const directory = await manifestDirectory(validManifest(overrides))
      await assert.rejects(verify(directory), expected)
    })
  }
})

describe('rejects broad wildcard and loopback match patterns', () => {
  const verify = productionManifestVerifier()

  test('wildcard', async () => {
    const directory = await manifestDirectory(
      validManifest({
        host_permissions: [
          ...PRODUCTION_HOSTS.slice(0, -1),
          'https://*/*',
        ],
      }),
    )
    await assert.rejects(verify(directory), /wildcard/i)
  })

  const loopbackCases = [
    [
      'localhost in host permissions',
      { host_permissions: PRODUCTION_HOSTS },
      { optional_host_permissions: ['http://localhost:3000/*'] },
    ],
    [
      'IPv4 in content scripts',
      {},
      {
        content_scripts: [
          {
            matches: ['http://127.0.0.1:3000/*'],
            js: ['content-scripts/content.js'],
          },
        ],
      },
    ],
    [
      'IPv6 in web-accessible resources',
      {},
      {
        web_accessible_resources: [
          {
            resources: ['icon/*.png'],
            matches: ['http://[::1]:3000/*'],
          },
        ],
      },
    ],
  ]

  for (const [name, baseOverrides, surfaceOverrides] of loopbackCases) {
    test(name, async () => {
      const directory = await manifestDirectory(
        validManifest({ ...baseOverrides, ...surfaceOverrides }),
      )
      await assert.rejects(verify(directory), /loopback/i)
    })
  }
})

test('allows scheme wildcards only for the fixed X and Twitter surfaces', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory(
    validManifest({
      content_scripts: [
        {
          matches: ['*://x.com/*', '*://twitter.com/*'],
          js: ['content-scripts/content.js'],
        },
        {
          matches: ['https://app.lhdao.top/*'],
          js: ['content-scripts/web-presence.js'],
        },
      ],
    }),
  )

  await assert.doesNotReject(verify(directory))
})

describe('rejects fixed customer domains outside the release allowlist', () => {
  const verify = productionManifestVerifier()
  const cases = [
    [
      'content scripts',
      {
        content_scripts: [
          {
            matches: ['https://customer.example/*'],
            js: ['content-scripts/content.js'],
          },
        ],
      },
      /content_scripts.*customer\.example/i,
    ],
    [
      'web-accessible resources',
      {
        web_accessible_resources: [
          {
            resources: ['icon/*.png'],
            matches: ['https://customer.example/*'],
          },
        ],
      },
      /web_accessible_resources.*customer\.example/i,
    ],
    [
      'externally connectable pages',
      {
        externally_connectable: {
          matches: ['https://customer.example/*'],
        },
      },
      /externally_connectable.*customer\.example/i,
    ],
  ]

  for (const [name, overrides, expected] of cases) {
    test(name, async () => {
      const directory = await manifestDirectory(validManifest(overrides))
      await assert.rejects(verify(directory), expected)
    })
  }
})

test('keeps the product evaluator out of static content scripts', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory(
    validManifest({
      content_scripts: [
        {
          matches: ['https://app.lhdao.top/*'],
          js: ['content-scripts/product-experience.js'],
        },
      ],
    }),
  )

  await assert.rejects(verify(directory), /runtime.*static|static.*runtime/i)
})

test('requires the runtime evaluator artifact in every output', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory(validManifest(), false)

  await assert.rejects(
    verify(directory),
    /content-scripts\/product-experience\.js/i,
  )
})

test('never lets an unknown endpoint environment expand the release allowlist', async () => {
  const verify = productionManifestVerifier()
  const directory = await manifestDirectory(
    validManifest({
      host_permissions: [
        'https://x.com/*',
        'https://twitter.com/*',
        'https://www.binance.com/*',
        'https://evil.example/*',
        'https://also-evil.example/*',
      ],
    }),
  )

  await assert.rejects(
    verify(directory, {
      environment: {
        WXT_API_ENDPOINT: 'https://evil.example/graphql',
        WXT_WEB_ENDPOINT: 'https://also-evil.example',
      },
    }),
    /release endpoint profile is unsupported/i,
  )
})

test('enforces HTTPS unless an explicit all-loopback local build is enabled', () => {
  const resolve = requireFunction(resolveEndpointPolicy, 'resolveEndpointPolicy')

  assert.deepEqual(resolve({}), {
    apiEndpoint: 'https://service.lhdao.top/graphql',
    webEndpoint: 'https://app.lhdao.top',
    apiHostPattern: 'https://service.lhdao.top/*',
    webHostPattern: 'https://app.lhdao.top/*',
    localBuild: false,
  })

  assert.throws(
    () =>
      resolve({
        WXT_API_ENDPOINT: 'http://127.0.0.1:4000/graphql',
        WXT_WEB_ENDPOINT: 'http://127.0.0.1:3000',
      }),
    /WXT_LOCAL_BUILD=true/i,
  )
  assert.throws(
    () =>
      resolve({
        WXT_API_ENDPOINT: 'http://localhost:4000/graphql',
        WXT_WEB_ENDPOINT: 'http://localhost:3000',
      }),
    /WXT_LOCAL_BUILD=true/i,
  )
  assert.throws(
    () =>
      resolve({
        WXT_API_ENDPOINT: 'http://[::1]:4000/graphql',
        WXT_WEB_ENDPOINT: 'http://[::1]:3000',
      }),
    /WXT_LOCAL_BUILD=true/i,
  )
  assert.throws(
    () =>
      resolve({
        WXT_LOCAL_BUILD: 'true',
        WXT_API_ENDPOINT: 'http://127.0.0.1:4000/graphql',
        WXT_WEB_ENDPOINT: 'https://app.lhdao.top',
      }),
    /both.*loopback|loopback.*both/i,
  )
  assert.deepEqual(
    resolve({
      WXT_LOCAL_BUILD: 'true',
      WXT_API_ENDPOINT: 'http://localhost:4000/graphql',
      WXT_WEB_ENDPOINT: 'http://localhost:3000',
    }),
    {
      apiEndpoint: 'http://localhost:4000/graphql',
      webEndpoint: 'http://localhost:3000',
      apiHostPattern: 'http://localhost:4000/*',
      webHostPattern: 'http://localhost:3000/*',
      localBuild: true,
    },
  )

  assert.deepEqual(
    resolve({
      WXT_LOCAL_BUILD: 'true',
      WXT_API_ENDPOINT: 'http://127.0.0.1:4000/graphql',
      WXT_WEB_ENDPOINT: 'http://[::1]:3000',
    }),
    {
      apiEndpoint: 'http://127.0.0.1:4000/graphql',
      webEndpoint: 'http://[::1]:3000',
      apiHostPattern: 'http://127.0.0.1:4000/*',
      webHostPattern: 'http://[::1]:3000/*',
      localBuild: true,
    },
  )
})

test('requires every Firefox script to opt into MV3', async () => {
  const verify = requireFunction(verifyPackageScripts, 'verifyPackageScripts')
  const directory = await mkdtemp(join(tmpdir(), 'lhdao-package-'))
  const packagePath = join(directory, 'package.json')
  await writeFile(
    packagePath,
    JSON.stringify({
      scripts: {
        'dev:firefox': 'wxt -b firefox --mv3',
        'build:firefox': 'wxt build -b firefox --mv3',
        'zip:firefox': 'wxt zip -b firefox --mv3',
      },
    }),
  )
  await assert.doesNotReject(verify(packagePath))

  await writeFile(
    packagePath,
    JSON.stringify({
      scripts: {
        'dev:firefox': 'wxt -b firefox',
        'build:firefox': 'wxt build -b firefox --mv3',
        'zip:firefox': 'wxt zip -b firefox --mv3',
      },
    }),
  )
  await assert.rejects(verify(packagePath), /firefox.*--mv3/i)
})
