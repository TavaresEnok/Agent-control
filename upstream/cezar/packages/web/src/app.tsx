import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { BrowserRouter, useLocation } from 'react-router'
import {getApiBaseUrl} from '@open-mercato/cezar-api-client'
import type {ReactNode} from 'react'
import {pathnameProjectId} from './lib/project-router'

import { GlobalEventsProvider } from './api/global-events'
import { HostUsageProvider } from './api/host-usage'
import { createQueryClient } from './api/query-client'
import { AppShellContainer } from './components/app-shell-container'
import { AppearanceProvider } from './components/appearance-provider'
import { LastLocationController } from './components/last-location-controller'
import { ReferenceStatusRegistry } from './components/reference-status'
import { RunNotifications } from './components/run-notifications'
import { StarPromo } from './components/star-promo'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/toaster'
import { Telemetry } from './lib/telemetry'
import { AppRoutes } from './routes'
import {AgentControlAuthGate} from './components/auth/agent-control-auth-gate'

export function ScopedEvents({children}:{children:ReactNode}){
  const {pathname}=useLocation()
  const project=pathnameProjectId(pathname)
  const url=import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'
    ? project&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project)
      ? `${getApiBaseUrl()}/api/v1/p/${encodeURIComponent(project)}/workspace/events?slim=1` : null
    : undefined
  return <GlobalEventsProvider key={import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'?(project??'unscoped'):'native'} url={url}>{children}</GlobalEventsProvider>
}

/** Real URLs, no basename: the cockpit is always mounted at the origin root, and the server
 *  serves index.html for every non-/api GET (src/server/static-ui.ts), so a deep link like
 *  `/tasks/:id/changes` cold-loads and survives a refresh.
 *
 *  The shell is inside BrowserRouter because its nav reads the current location, and inside
 *  QueryClientProvider because its chips read `/api/health` and `/api/todos`. Each chip renders
 *  nothing until its query answers — no placeholder that would read as real data.
 *
 *  The events provider is above the routes and publishes the live usage map to its descendants.
 *  Managed mode reconnects it when the project in the URL changes.
 */
export function App() {
  // Lazy initial state rather than a module-level constant: one client per App instance, so a
  // test (or a remount) never inherits another's cache, and StrictMode's double-invoke of the
  // component body still yields exactly one client.
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <AgentControlAuthGate>
      <BrowserRouter>
      <ScopedEvents>
        {/* The machine-telemetry store, one per app: the sidebar widget and the Settings card are
            two readers of the same sample and the same 60 s ring, and exactly one writer (root,
            card or route) is live per viewport. Muted here at the root because the widget lives in
            the shell for the session, above every route. */}
        <HostUsageProvider>
          {/* Beside the stream on purpose: it watches the run-list cache the stream patches
              (and reconciliation refetches), turning attention transitions into browser
              notifications when the tab is hidden (R6 1.7). Renders nothing. */}
          <RunNotifications />
          {/* And beside it for the same reason: the star ask's one-time toast watches the same
              run-list cache for the user's first successful run. Once per browser, ever, and
              silent when promos are off (`CEZ_NO_BANNER=1`). Renders nothing. */}
          <StarPromo />
          <ThemeProvider>
            {/* Beside ThemeProvider on purpose: appearance (accent/density) is the ui-state.json
                half of the same boot contract — mirror pre-paints, server truth reconciles. */}
            <AppearanceProvider>
                <LastLocationController />
                {/* Page views + error hooks; the server forwards them only after the user opted in
                    (docs/telemetry.md). Renders nothing. */}
                <Telemetry />
                {/* At the root for the same reason the event stream is: the sidebar, the task table
                    and an open run header all paint PR/issue chips, often the SAME ones, and each
                    asking for itself was several round trips and a staggered wave of colour. They
                    register what they are painting here instead, and it goes out as one request per
                    project. */}
                <ReferenceStatusRegistry>
                  <AppShellContainer>
                    <AppRoutes />
                  </AppShellContainer>
                </ReferenceStatusRegistry>
                {/* One toast outlet for the whole app — `toast()` is a module-level call. */}
                <Toaster />
            </AppearanceProvider>
          </ThemeProvider>
        </HostUsageProvider>
      </ScopedEvents>
      </BrowserRouter>
      </AgentControlAuthGate>
    </QueryClientProvider>
  )
}
