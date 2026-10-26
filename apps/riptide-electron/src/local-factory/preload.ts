import { ipcRenderer } from 'electron'

// Hand the local bootstrap to the page's sessionStorage before its scripts run, so it never
// appears in a URL, the window's history or a log. Main answers only the stack's top frame.
const bootstrap: unknown = ipcRenderer.sendSync('sam-factory:bootstrap')
if (typeof bootstrap === 'string' && bootstrap) window.sessionStorage.setItem('local-bootstrap', bootstrap)
