import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LoginGate } from './auth/LoginGate.tsx'
import './editor/editorPort'
import { initPrefsPersistence } from './state/prefsPersistence.ts'

initPrefsPersistence()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>,
)
