const startupLogs = import.meta.env.DEV || import.meta.env.VITE_STARTUP_LOGS === '1'

if (startupLogs) {
  console.info(`[startup] bootstrap entry loaded at ${Math.round(performance.now())}ms`)
}

const iconStyles = document.createElement('link')
iconStyles.rel = 'stylesheet'
iconStyles.href = '/vendor/tabler/tabler-icons.min.css'
document.head.appendChild(iconStyles)

const started = performance.now()
import('./renderer')
  .then(module => {
    if (startupLogs) {
      console.info(`[startup] renderer module loaded in ${Math.round(performance.now() - started)}ms`)
    }
    module.mount()
  })
  .catch(err => {
    console.error('[startup] renderer module failed to load', err)
  })
