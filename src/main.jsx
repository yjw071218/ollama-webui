import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './extras.css'
import { RefreshCcw } from 'lucide-react'
import App from './App.jsx'
import { SessionProvider, useSession } from './session.jsx'
import { deriveScope } from './profileScope.js'
import { setActiveScope } from './settingsStore.js'
import { trackViewport } from './viewport.js'
import { SharedChat } from './SharedChat.jsx'
import { shareTokenFromPath } from './shareLink.js'
import { I18nProvider } from './i18n.jsx'

// Started before React, and never stopped: the app is one screenful with a
// composer pinned to its bottom edge, and where that edge is depends on
// whether a keyboard is covering it. See src/viewport.js.
trackViewport()

/**
 * The splash shown while the server is being asked who is signed in.
 *
 * It exists so that there is somewhere honest to be during that moment.
 * Previously the app rendered immediately against a guess — the browser-local
 * profile — and corrected itself a round trip later, which meant every load had
 * a window in which chats and settings were read from, and written to, the
 * wrong account's storage. A spinner for one request is the price of that
 * window not existing.
 */
const Splash = () => (
  <div className="auth-screen">
    <div className="auth-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
      <RefreshCcw size={22} className="spin" />
    </div>
  </div>
)

/**
 * Point the settings store at the signed-in account, then mount the app.
 *
 * Two things here are load-bearing.
 *
 * `setActiveScope` runs during render, before `<App/>` is created, because App
 * reads dozens of settings in `useState` initialisers and those run as it
 * mounts. Setting the scope in an effect would be one render too late — and one
 * render of the wrong account's settings is what people saw as their setup
 * briefly flickering into somebody else's.
 *
 * The `key` is how an identity change is handled. Not by reconciling: a
 * different person is not a state update, and React would keep every piece of
 * state that happened to sit in the same position — one account's open chat,
 * draft and scroll position carried into another's. Changing the key throws the
 * whole tree away and builds a new one against the new account's storage.
 */
const ScopedApp = () => {
  const { user } = useSession()
  const scope = deriveScope(user, 'ready')
  setActiveScope(scope)
  return <App key={scope || 'guest'} />
}

/**
 * A shared conversation is a different page, not a mode of this one.
 *
 * Mounted outside `SessionProvider` on purpose. That provider's first act is to
 * ask the server who is signed in — and, for a tab with no session, to be given
 * one. Somebody following a link to read a transcript should not have a session
 * created for them, should not be told to sign in, and should not have the page
 * they opened reported to an account they do not have. So the branch happens
 * before any of that starts.
 *
 * The i18n provider stays, because the page still has words in it.
 */
const sharedToken = shareTokenFromPath()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {sharedToken ? (
      <I18nProvider>
        <SharedChat token={sharedToken} />
      </I18nProvider>
    ) : (
      <SessionProvider fallback={<Splash />}>
        <ScopedApp />
      </SessionProvider>
    )}
  </StrictMode>,
)
