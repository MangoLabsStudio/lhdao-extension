import md5 from 'md5'

/**
 * Proof-of-Work 求解器 —— 跟后端 backend/src/modules/watermark/pow-validator.ts
 * 完全对齐:`md5(challenge + nonce)` 的十六进制前缀命中 `difficulty` 即解。
 *
 * 后端校验:`createHash('md5').update(challenge + nonce).digest('hex')
 *           .startsWith(difficulty)`。这里必须逐字节一致,否则 reserve 永远
 * 被判 WM_POW_INVALID。
 *
 * 在 background SW 里同步循环跑。difficulty 默认 '0000'(4 个 hex 0)→ 平均
 * ~65536 次 md5,毫秒级,不阻塞用户感知。设上限兜底:万一后端调高难度导致
 * 长时间空转,抛错让上层降级为"无 nonce"(后端记 WM_POW_MISSING),不卡死 SW。
 */
const MAX_ITERATIONS = 5_000_000

export interface PowSolution {
  nonce: string
  /** 求解迭代次数 —— 上报到 x-pow-cost-ms 供后端统计平均成本(后端不据此校验) */
  cost: number
}

export function solvePow(challenge: string, difficulty: string): PowSolution {
  for (let nonce = 0; nonce < MAX_ITERATIONS; nonce++) {
    const hash = md5(challenge + String(nonce))
    if (hash.startsWith(difficulty)) {
      return { nonce: String(nonce), cost: nonce + 1 }
    }
  }
  throw new Error('POW_SOLVE_EXCEEDED_MAX_ITERATIONS')
}

/** 本地自检 —— 跟后端 validatePow 同构,测试用。 */
export function validatePow(
  challenge: string,
  nonce: string,
  difficulty: string,
): boolean {
  if (!nonce) return false
  return md5(challenge + nonce).startsWith(difficulty)
}
