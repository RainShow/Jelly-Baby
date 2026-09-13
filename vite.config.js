// vite.config.js
import { defineConfig } from 'vite'

const runtimeSourceSuffix='/src/app/runtime.ts'

function runtimeModulePreload() {
  let base='/'

  return {
    name:'jelly-runtime-module-preload',
    configResolved(config) {
      base=config.base
    },
    transformIndexHtml: {
      order:'post',
      handler(_html,context) {
        let href=`${base}src/app/runtime.ts`

        if(context.bundle) {
          const runtimeChunk=Object.values(context.bundle).find(output =>
            output.type==='chunk'&&output.facadeModuleId?.endsWith(runtimeSourceSuffix)
          )

          if(!runtimeChunk)throw new Error('Unable to find the emitted runtime chunk for modulepreload')
          href=`${base}${runtimeChunk.fileName}`
        }

        return [{
          tag:'link',
          attrs:{rel:'modulepreload',href},
          injectTo:'head'
        }]
      }
    }
  }
}

export default defineConfig({
  plugins:[runtimeModulePreload()],
  server: {
    allowedHosts: true
  }
})
