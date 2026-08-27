import { join } from 'node:path'
import { addPublicAssets, defineWxtModule } from 'wxt/modules'
import { verifyTlsnWasmProvenance } from '../scripts/verify-tlsn-wasm-provenance.mjs'

export default defineWxtModule({
  name: 'lighthouse-tlsn-wasm',
  async setup(wxt) {
    if (wxt.config.browser !== 'firefox') {
      await verifyTlsnWasmProvenance(
        join(process.cwd(), 'vendor/tlsn-wasm'),
      )
      addPublicAssets(wxt, 'node_modules/tlsn-wasm')
      return
    }
    wxt.hooks.hook('entrypoints:resolved', (_, entrypoints) => {
      for (const entrypoint of entrypoints) {
        if (entrypoint.name.startsWith('zktls-')) entrypoint.skipped = true
      }
    })
  },
})
