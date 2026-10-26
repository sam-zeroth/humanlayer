import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron'

import { certificateAllowed, externalLink, requestAllowed, spkiPin, stackOrigin, startPath } from './trust'

// Sam Factory: one window over the local factory stack. No daemon, updater, Sentry, deep links or WorkOS.
const NAME = 'Sam Factory'
const POINTER = join(homedir(), 'Library/Application Support/Sam Factory/stack.json')
const BOOTSTRAP_CHANNEL = 'sam-factory:bootstrap'

app.setName(NAME)
// Chromium's own update/metrics/component traffic is off; the request filter below refuses anything else.
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('no-pings')

interface Stack {
	origin: string
	pin: string
	bootstrap: string
	start: string
}

/** Read fresh each time: `stack.ts start` rewrites the pointer, and the leaf or secret may rotate. */
function readStack(): Stack {
	const pointer: unknown = JSON.parse(readFileSync(POINTER, 'utf8'))
	if (!pointer || typeof pointer !== 'object' || !('state' in pointer) || typeof pointer.state !== 'string')
		throw new Error('Stack pointer is invalid')
	const origin = stackOrigin('origin' in pointer ? pointer.origin : undefined)
	const state = pointer.state
	let start: string | null = null
	try {
		start = readFileSync(join(state, 'factory-unit-path'), 'utf8')
	} catch {
		/* No unit projected yet: open the stack root. */
	}
	return {
		origin,
		pin: spkiPin(readFileSync(join(state, 'tls/cert.pem'), 'utf8')),
		bootstrap: readFileSync(join(state, 'bootstrap-secret'), 'utf8').trim(),
		start: startPath(start),
	}
}

let stack: Stack | null = null
// In-memory partition: cookies, storage and the bootstrap never reach disk.
const factorySession = () => session.fromPartition('sam-factory')

function secure() {
	const ses = factorySession()
	ses.setCertificateVerifyProc((request, callback) => {
		callback(stack && certificateAllowed(request.hostname, request.certificate.data, stack.origin, stack.pin) ? 0 : -2)
	})
	ses.webRequest.onBeforeRequest((details, callback) => {
		callback({ cancel: !stack || !requestAllowed(details.url, stack.origin) })
	})
	ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
	ses.setPermissionCheckHandler(() => false)
}

ipcMain.on(BOOTSTRAP_CHANNEL, (event) => {
	// Only the top frame of the stack origin receives the credential.
	const frame = event.senderFrame
	event.returnValue =
		stack && frame && frame.parent === null && frame.origin === stack.origin ? stack.bootstrap : null
})

const failurePage = (message: string) =>
	'data:text/html;charset=utf-8,' +
	encodeURIComponent(
		`<!doctype html><meta charset="utf-8"><title>${NAME}</title><body style="font:15px -apple-system,sans-serif;padding:3rem;color:#222"><p>${message}</p><p>Press ⌘R to retry.</p>`,
	)

function load(window: BrowserWindow) {
	try {
		stack = readStack()
	} catch {
		stack = null
		void window.loadURL(failurePage('Could not find the local stack. Start it with local-factory/stack.ts start, then retry.'))
		return
	}
	window.loadURL(stack.origin + stack.start).catch(() => {
		void window.loadURL(failurePage('Could not reach the local stack. Check that it is running, then retry.'))
	})
}

function open() {
	const window = new BrowserWindow({
		title: NAME,
		width: 1280,
		height: 900,
		webPreferences: {
			partition: 'sam-factory',
			preload: join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: false,
		},
	})
	window.on('page-title-updated', (event) => event.preventDefault())
	window.webContents.setWindowOpenHandler(({ url }) => {
		const external = externalLink(url)
		if (external) void shell.openExternal(external)
		return { action: 'deny' }
	})
	window.webContents.on('will-navigate', (event, url) => {
		if (url.startsWith('data:') || (stack && requestAllowed(url, stack.origin) && url.startsWith('https:'))) return
		event.preventDefault()
		const external = externalLink(url)
		if (external) void shell.openExternal(external)
	})
	window.webContents.on('will-attach-webview', (event) => event.preventDefault())
	load(window)
	return window
}

void app.whenReady().then(() => {
	secure()
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: 'appMenu' },
			{ role: 'editMenu' },
			{
				label: 'View',
				submenu: [
					{
						label: 'Reload',
						accelerator: 'CmdOrCtrl+R',
						click: () => {
							const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
							if (window) load(window)
						},
					},
					{ role: 'toggleDevTools' },
					{ type: 'separator' },
					{ role: 'resetZoom' },
					{ role: 'zoomIn' },
					{ role: 'zoomOut' },
				],
			},
			{ role: 'windowMenu' },
		]),
	)
	open()
})
app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) open()
})
app.on('window-all-closed', () => app.quit())
