import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// Apply the remembered theme before the first paint so a dark room does not flash cream (the setting itself lives in
// SQLite and is re-read by App; localStorage is only the per-machine memory of the last choice).
try {
  const t = localStorage.getItem('ui.theme')
  if (t === 'dark' || t === 'light') document.documentElement.dataset['theme'] = t
} catch {
  /* private mode etc. */
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
