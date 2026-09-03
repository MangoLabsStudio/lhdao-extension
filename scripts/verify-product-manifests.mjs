#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_EXTENSION_VERSION = '0.2.2'
const BASE_PERMISSIONS = ['storage', 'alarms', 'activeTab', 'scripting']
const FIXED_HOST_PERMISSIONS = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://www.binance.com/*',
]
const DEFAULT_API_ENDPOINT = 'https://service.lhdao.top/graphql'
const DEFAULT_WEB_ENDPOINT = 'https://app.lhdao.top'
const RELEASE_ENDPOINT_PROFILES = [
  [DEFAULT_API_ENDPOINT, DEFAULT_WEB_ENDPOINT],
  [
    'https://service.lhdaobeta.top/graphql',
    'https://app.lhdaobeta.top',
  ],
]
const FIXED_PAGE_MATCHES = [
  'https://x.com/*',
  'https://twitter.com/*',
  '*://x.com/*',
  '*://twitter.com/*',
  'https://www.binance.com/*/square/*',
  'https://www.binance.com/square/*',
]
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const RUNTIME_EVALUATOR_PATH = 'content-scripts/product-experience.js'

export const DEFAULT_OUTPUT_DIRECTORIES = [
  '.output/chrome-mv3',
  '.output/edge-mv3',
  '.output/firefox-mv3',
]

function parseEndpoint(name, value) {
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS: ${value}`)
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`${name} must not contain credentials`)
  }
  return endpoint
}

export function resolveEndpointPolicy(environment = process.env) {
  const localBuildValue = environment.WXT_LOCAL_BUILD
  if (
    localBuildValue !== undefined &&
    localBuildValue !== '' &&
    localBuildValue !== 'true'
  ) {
    throw new Error('WXT_LOCAL_BUILD must be exactly true when enabled')
  }

  const localBuild = localBuildValue === 'true'
  const apiEndpoint = environment.WXT_API_ENDPOINT ?? DEFAULT_API_ENDPOINT
  const webEndpoint = environment.WXT_WEB_ENDPOINT ?? DEFAULT_WEB_ENDPOINT
  const apiUrl = parseEndpoint('WXT_API_ENDPOINT', apiEndpoint)
  const webUrl = parseEndpoint('WXT_WEB_ENDPOINT', webEndpoint)
  const apiIsLoopback = LOOPBACK_HOSTNAMES.has(apiUrl.hostname)
  const webIsLoopback = LOOPBACK_HOSTNAMES.has(webUrl.hostname)

  if (localBuild) {
    if (!apiIsLoopback || !webIsLoopback) {
      throw new Error(
        'WXT_LOCAL_BUILD=true requires both API and Web endpoints to use exact loopback hosts',
      )
    }
  } else {
    if (apiIsLoopback || webIsLoopback) {
      throw new Error(
        'Loopback endpoints require WXT_LOCAL_BUILD=true for both API and Web',
      )
    }
    if (apiUrl.protocol !== 'https:' || webUrl.protocol !== 'https:') {
      throw new Error(
        'HTTP endpoints require WXT_LOCAL_BUILD=true with both endpoints on exact loopback hosts',
      )
    }
  }

  return {
    apiEndpoint,
    webEndpoint,
    apiHostPattern: `${apiUrl.origin}/*`,
    webHostPattern: `${webUrl.origin}/*`,
    localBuild,
  }
}

function resolveReleaseEndpointPolicy(environment) {
  const policy = resolveEndpointPolicy(environment)
  const supported = RELEASE_ENDPOINT_PROFILES.some(
    ([apiEndpoint, webEndpoint]) =>
      policy.apiEndpoint === apiEndpoint && policy.webEndpoint === webEndpoint,
  )
  if (!supported) throw new Error('Release endpoint profile is unsupported.')
  return policy
}

export function resolveRequestedDirectories(argumentsList) {
  if (argumentsList.length === 0) return [...DEFAULT_OUTPUT_DIRECTORIES]

  const names = ['chrome', 'edge', 'firefox']
  const directories = new Map()
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = String(argumentsList[index])
    const [rawFlag, inlineValue] = argument.split('=', 2)
    const match = /^--(chrome|edge|firefox)-dir$/.exec(rawFlag)
    if (!match) throw new Error(`Unknown verifier argument: ${argument}`)
    const browser = match[1]
    if (directories.has(browser)) {
      throw new Error(`Duplicate --${browser}-dir argument`)
    }
    const value = inlineValue ?? argumentsList[(index += 1)]
    if (!value || String(value).startsWith('--')) {
      throw new Error(`--${browser}-dir requires a directory`)
    }
    directories.set(browser, String(value))
  }
  if (names.some((name) => !directories.has(name))) {
    throw new Error(
      'Explicit verification requires --chrome-dir, --edge-dir, and --firefox-dir',
    )
  }
  return names.map((name) => directories.get(name))
}

function assertExactStringSet(label, actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${label} must be an array of strings`)
  }
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter((value) => !actualSet.has(value))
  const unexpected = [...actualSet].filter((value) => !expectedSet.has(value))
  const duplicates = actual.filter(
    (value, index) => actual.indexOf(value) !== index,
  )
  if (missing.length || unexpected.length || duplicates.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : null,
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : null,
      duplicates.length
        ? `duplicates: ${[...new Set(duplicates)].join(', ')}`
        : null,
    ].filter(Boolean)
    throw new Error(`${label} must match exactly (${details.join('; ')})`)
  }
}

function manifestMatchPatterns(manifest) {
  const patterns = []
  for (const key of ['host_permissions', 'optional_host_permissions']) {
    if (Array.isArray(manifest[key])) patterns.push(...manifest[key])
  }
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const key of ['matches', 'exclude_matches']) {
      if (Array.isArray(contentScript?.[key])) {
        patterns.push(...contentScript[key])
      }
    }
  }
  for (const resource of manifest.web_accessible_resources ?? []) {
    if (Array.isArray(resource?.matches)) patterns.push(...resource.matches)
  }
  if (Array.isArray(manifest.externally_connectable?.matches)) {
    patterns.push(...manifest.externally_connectable.matches)
  }
  return patterns.filter((pattern) => typeof pattern === 'string')
}

function assertSafeMatchPatterns(manifest) {
  if (manifest.host_permissions?.includes('https://*/*')) {
    throw new Error('Wildcard resident host permissions are forbidden.')
  }
  for (const pattern of manifestMatchPatterns(manifest)) {
    const schemeWildcardMatch = /^\*:\/\/([^/]+)\//.exec(pattern)
    const allowedFixedSchemeWildcard =
      schemeWildcardMatch &&
      ['x.com', 'twitter.com'].includes(schemeWildcardMatch[1])
    const wildcardOrigin =
      pattern === '<all_urls>' ||
      (schemeWildcardMatch && !allowedFixedSchemeWildcard) ||
      /^[a-z][a-z\d+.-]*:\/\/[^/]*\*/i.test(pattern)
    if (wildcardOrigin && pattern !== 'https://*/*') {
      throw new Error(
        `Wildcard origins are forbidden in manifest matches: ${pattern}`,
      )
    }

    let parsed
    try {
      parsed = new URL(pattern)
    } catch {
      continue
    }
    if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
      throw new Error(
        `Loopback origins are forbidden in manifest matches: ${pattern}`,
      )
    }
  }
}

function assertRuntimeOnlyEvaluator(manifest) {
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const script of contentScript?.js ?? []) {
      if (
        typeof script === 'string' &&
        script.replaceAll('\\', '/').endsWith(RUNTIME_EVALUATOR_PATH)
      ) {
        throw new Error(
          'The runtime product evaluator must not be registered as a static content script',
        )
      }
    }
  }
}

function assertApprovedPageMatches(label, matches, approvedPageMatches) {
  if (!Array.isArray(matches)) {
    throw new Error(`${label} must be an array of approved match patterns`)
  }
  for (const pattern of matches) {
    if (typeof pattern !== 'string' || !approvedPageMatches.has(pattern)) {
      throw new Error(`${label} contains an unapproved match: ${String(pattern)}`)
    }
  }
}

function assertApprovedPageSurfaces(manifest, approvedPageMatches) {
  for (const contentScript of manifest.content_scripts ?? []) {
    assertApprovedPageMatches(
      'content_scripts.matches',
      contentScript?.matches,
      approvedPageMatches,
    )
  }
  for (const resource of manifest.web_accessible_resources ?? []) {
    assertApprovedPageMatches(
      'web_accessible_resources.matches',
      resource?.matches,
      approvedPageMatches,
    )
  }
  for (const [key, value] of Object.entries(
    manifest.externally_connectable ?? {},
  )) {
    const populated = Array.isArray(value)
      ? value
      : value === undefined || value === null || value === false
        ? []
        : [value]
    if (populated.length > 0) {
      throw new Error(
        `externally_connectable.${key} must be empty, received: ${populated.join(', ')}`,
      )
    }
  }
}

async function assertRuntimeEvaluatorArtifact(directory) {
  const artifactPath = resolve(directory, RUNTIME_EVALUATOR_PATH)
  let artifact
  try {
    artifact = await stat(artifactPath)
  } catch {
    throw new Error(`Missing runtime evaluator artifact: ${artifactPath}`)
  }
  if (!artifact.isFile() || artifact.size === 0) {
    throw new Error(`Invalid runtime evaluator artifact: ${artifactPath}`)
  }
}

async function assertTlsnAssets(directory) {
  for (const name of ['tlsn_wasm.js', 'tlsn_wasm_bg.wasm', 'spawn.js', 'snippets/web-spawn-05868593a72e2d44/js/spawn.js']) {
    const asset = await stat(resolve(directory, name))
    if (!asset.isFile() || asset.size === 0) throw new Error(`Missing TLSNotary asset: ${name}`)
  }
}

export async function verifyManifestDirectory(directory, options = {}) {
  const browser = typeof options === 'string' ? options : options.browser ?? 'chrome'
  const environment =
    typeof options === 'object' && options.environment
      ? options.environment
      : process.env
  const endpointPolicy = resolveReleaseEndpointPolicy(environment)
  const expectedHostPermissions = [
    ...FIXED_HOST_PERMISSIONS,
    endpointPolicy.apiHostPattern,
    endpointPolicy.webHostPattern,
  ]
  const approvedPageMatches = new Set([
    ...FIXED_PAGE_MATCHES,
    endpointPolicy.webHostPattern,
  ])
  const absoluteDirectory = resolve(directory)
  const manifestPath = resolve(absoluteDirectory, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${manifestPath}: ${error.message}`)
  }

  assertSafeMatchPatterns(manifest)
  assertRuntimeOnlyEvaluator(manifest)

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `manifest_version must be 3, received ${String(manifest.manifest_version)}`,
    )
  }
  if (manifest.version !== EXPECTED_EXTENSION_VERSION) {
    throw new Error(
      `Extension version must be ${EXPECTED_EXTENSION_VERSION}, received ${String(manifest.version)}`,
    )
  }

  const chromium = browser === 'chrome' || browser === 'edge'
  assertExactStringSet('permissions', manifest.permissions, [
    ...BASE_PERMISSIONS,
    ...(chromium ? ['offscreen', 'webRequest', 'debugger'] : []),
  ])
  if (chromium && (
    typeof manifest.minimum_chrome_version !== 'string' ||
    !/^\d+(?:\.\d+){0,3}$/.test(manifest.minimum_chrome_version) ||
    Number(manifest.minimum_chrome_version.split('.')[0]) < 118
  )) {
    throw new Error('minimum_chrome_version must be at least 118 for native discovery.')
  }
  assertExactStringSet('optional_permissions', manifest.optional_permissions ?? [], [])
  assertExactStringSet(
    'host_permissions',
    manifest.host_permissions,
    expectedHostPermissions,
  )
  assertExactStringSet(
    'optional_host_permissions',
    manifest.optional_host_permissions ?? [],
    chromium ? ['https://*/*'] : [],
  )
  await assertRuntimeEvaluatorArtifact(absoluteDirectory)
  if (chromium) {
    if (manifest.content_security_policy?.extension_pages !== "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';") {
      throw new Error('Chromium manifest must include the TLSNotary WASM CSP.')
    }
    await assertTlsnAssets(absoluteDirectory)
  } else if (manifest.content_security_policy) {
    throw new Error('Firefox must not receive Chromium zkTLS CSP.')
  } else {
    for (const name of ['tlsn_wasm.js', 'tlsn_wasm_bg.wasm', 'spawn.js', 'zktls-offscreen.html', 'zktls-permission.html']) {
      try {
        await stat(resolve(absoluteDirectory, name))
        throw new Error(`Firefox must not package Chromium zkTLS asset: ${name}`)
      } catch (error) {
        if (String(error).includes('Firefox must not')) throw error
      }
    }
  }
  assertApprovedPageSurfaces(manifest, approvedPageMatches)
  return { directory: absoluteDirectory, manifestPath }
}

export async function verifyProductManifests(
  directories = DEFAULT_OUTPUT_DIRECTORIES,
) {
  const results = []
  for (const [index, directory] of directories.entries()) {
    results.push(await verifyManifestDirectory(directory, ['chrome', 'edge', 'firefox'][index]))
  }
  return results
}

export async function verifyPackageScripts(
  packagePath = resolve('package.json'),
) {
  let packageJson
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${packagePath}: ${error.message}`)
  }
  const expected = {
    'dev:firefox': 'wxt -b firefox --mv3',
    'build:firefox': 'wxt build -b firefox --mv3',
    'zip:firefox': 'wxt zip -b firefox --mv3',
  }
  for (const [name, command] of Object.entries(expected)) {
    if (packageJson.scripts?.[name] !== command) {
      throw new Error(
        `Firefox ${name} script must be exactly "${command}" (including --mv3)`,
      )
    }
  }
}

async function main() {
  const directories = resolveRequestedDirectories(process.argv.slice(2))
  await verifyPackageScripts()
  await verifyProductManifests(directories)
}

const invokedPath = process.argv[1]
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
