#!/usr/bin/env node
/**
 * Generate Chrome extension icon set from a single source image.
 *
 * Source (priority order — picks first found):
 *   1. assets/logo-source.svg   (preferred — vector, scales crisply to any size)
 *   2. assets/logo-source.png   (fallback — high-res square 512x512+)
 *
 * Writes:  public/icon/16.png / 32.png / 48.png / 96.png / 128.png
 *
 * WXT auto-detects public/icon/* and injects the right `icons` entry
 * into manifest.json on every build.
 *
 * Usage: pnpm run icons
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const svgPath = resolve(repoRoot, 'assets/logo-source.svg')
const pngPath = resolve(repoRoot, 'assets/logo-source.png')
const outDir = resolve(repoRoot, 'public/icon')

const SIZES = [16, 32, 48, 96, 128]

// 优先 SVG(矢量,缩到任意尺寸都清晰),fallback PNG。sharp 原生支持 SVG
// input,无需额外依赖。
let sourcePath
if (existsSync(svgPath)) {
  sourcePath = svgPath
  console.log(`📐 using SVG source: ${svgPath}`)
} else if (existsSync(pngPath)) {
  sourcePath = pngPath
  console.log(`🖼  using PNG source: ${pngPath}`)
} else {
  console.error(`
❌ 找不到 logo 源图。
请把矢量 logo 保存为 assets/logo-source.svg(推荐),或者高分辨率
方形位图保存为 assets/logo-source.png,然后重跑此脚本。
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

// SVG input:density 决定光栅化分辨率,默认 72dpi 偏低,加大到 384 让
// SVG 先按 4x 渲染再缩到 target,小尺寸 (16/32) 锐利度肉眼可见提升。
// PNG input:density 选项被忽略,行为不变。
for (const size of SIZES) {
  const out = resolve(outDir, `${size}.png`)
  await sharp(sourcePath, { density: 384 })
    .resize(size, size, { fit: 'cover' })
    .png()
    .toFile(out)
  console.log(`✓ ${size}x${size} → public/icon/${size}.png`)
}

console.log(`
🎉 全部 ${SIZES.length} 个尺寸生成完毕。
下次 pnpm run build 时 WXT 会自动塞进 manifest.json 的 icons 字段。
`)
