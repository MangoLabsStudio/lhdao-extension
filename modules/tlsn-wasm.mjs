import { addPublicAssets, defineWxtModule } from 'wxt/modules'

export default defineWxtModule({
  name: 'lighthouse-tlsn-wasm',
  setup(wxt) {
    if (wxt.config.browser !== 'firefox') {
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
