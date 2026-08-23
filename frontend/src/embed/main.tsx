import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../App.css'
import './embed.css'
import { LoginGate } from '../auth/LoginGate.tsx'
import { initPrefsPersistence } from '../state/prefsPersistence.ts'
import { setDocumentPort } from '../checking/documentPort'
import { setClientTag } from '../checking/clientTag'
import { createHostDoc } from './hostDoc'
import { startBridge } from './bridge'
import { setEmbedDisconnectHandler } from './disconnectSlot'
import { setEmbedActivateHandler } from './activateSlot'
import { setEmbedOutbound } from './embedRef'
import { EmbedApp } from './EmbedApp'

// Finding 11: default to 'embed' before any hello ever arrives (a host that
// never connects, or one slow to send it) — bridge.ts's route() overrides
// this with the host's own kind once a hello lands, since setClientTag now
// leaves an unrecognized value's tag unchanged rather than always falling
// back to 'web'.
setClientTag('embed')
const bridge = startBridge()
const hostDoc = createHostDoc(bridge.outbound)
bridge.attach(hostDoc)
setDocumentPort(hostDoc)
// Wires auth/session.ts's logout()/expireSession() to reset this shim
// without session.ts importing hostDoc.ts — see disconnectSlot.ts.
setEmbedDisconnectHandler(() => hostDoc.resetSession())
// Wires auth/session.ts's login() to clear this shim's session-scoped state
// (Copilot round 10: without this, a cross-user login would leak the
// previous user's tracked findings/selection into the new session) and then
// re-publish its connected-field state after a resetSessionState() that ran
// before it — see hostDoc.ts's activateSession() and activateSlot.ts's own
// comment.
setEmbedActivateHandler(() => hostDoc.activateSession())
// Deviation from the plan's main.tsx sketch: EmbedApp renders with no props,
// so it needs a way to reach bridge.outbound (to wire the check scheduler's
// onInput into it — see embedRef.ts's own comment) without main.tsx passing
// it down explicitly.
setEmbedOutbound(bridge.outbound)
initPrefsPersistence()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginGate>
      <EmbedApp />
    </LoginGate>
  </StrictMode>,
)
