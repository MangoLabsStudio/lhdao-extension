#!/usr/bin/env node
/**
 * Generate Chrome extension icon set from a single source image.
 *
 * Reads:   assets/logo-source.png  (high-res square,推荐 512x512+)
 * Writes:  public/icon/16.png
 *          public/icon/32.png
 *          public/icon/48.png
 *          public/icon/96.png
 *          public/icon/128.png
 *
 * WXT auto-detects this directory and injects the right `icons` entry
 * into manifest.json on every build.
 *
 * Usage: pnpm run icons
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const sourcePath = resolve(repoRoot, 'assets/logo-source.png')
const outDir = resolve(repoRoot, 'public/icon')

const SIZES = [16, 32, 48, 96, 128]

if (!existsSync(sourcePath)) {
  console.error(`
❌ 找不到源图: ${sourcePath}

请先把 logo 文件保存为 assets/logo-source.png(推荐 512x512 或更大的方图)
然后重跑这个脚本。
`)
  process.exit(1)
}

// Lazy-import sharp so missing-dep error is friendlier
let sharp
try {
  sharp = (await import('sharp')).default
} catch {
  console.error(`
❌ 缺少依赖 sharp。安装它:
   pnpm add -D sharp
`)
  process.exit(1)
}

for (const size of SIZES) {
  const out = resolve(outDir, `${size}.png`)
  await sharp(sourcePath).resize(size, size, { fit: 'cover' }).png().toFile(out)
  console.log(`✓ ${size}x${size} → public/icon/${size}.png`)
}

console.log(`
🎉 全部 ${SIZES.length} 个尺寸生成完毕。
下次 pnpm run build 时 WXT 会自动塞进 manifest.json 的 icons 字段。
`)
