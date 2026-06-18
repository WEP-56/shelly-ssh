import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

export function mount() {
  if (import.meta.env.DEV || import.meta.env.VITE_STARTUP_LOGS === '1') {
    console.info(`[startup] renderer mount called at ${Math.round(performance.now())}ms`)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
