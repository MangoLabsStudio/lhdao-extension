import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Lighthouse',
    description:
      'Highlight Lighthouse engagement tasks on X timeline + 1-click claim',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://service.lhdao.top/*',
      'https://service.lhdaobeta.top/*',
    ],
    action: {
      default_title: 'Lighthouse',
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      // Compile-time API endpoint. Override via WXT_API_ENDPOINT for staging.
      __API_ENDPOINT__: JSON.stringify(
        process.env.WXT_API_ENDPOINT ?? 'https://service.lhdao.top/graphql',
      ),
    },
  }),
})
