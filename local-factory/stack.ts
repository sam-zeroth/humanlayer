import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, lstat, readFile, writeFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { chromeWrapper } from './browser'
import { localAuthConfig, loopbackOrigin } from './config'
import { loadIdentity } from './identity'

const root = resolve(import.meta.dir, '..')
const state = resolve(process.env.LOCAL_FACTORY_STATE ?? join(root, '.local-factory'))
const portOffset = Number(process.env.LOCAL_FACTORY_PORT_OFFSET ?? '0')
if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 1000)
	throw new Error('LOCAL_FACTORY_PORT_OFFSET must be an integer from 0 to 1000')
// One offset moves every port, so a second worktree runs beside another stack without stopping it.
const ports = {
	api: 55800 + portOffset,
	identity: 55801 + portOffset,
	proxy: 55802 + portOffset,
	ui: 55803 + portOffset,
	postgres: 62348 + portOffset,
	electric: 55310 + portOffset,
	redis: 55389 + portOffset,
}
const browserOrigin = loopbackOrigin(process.env.LOCAL_BROWSER_ORIGIN ?? `https://127.0.0.1:${55813 + portOffset}`)
// The live HP root and the coordinator's release binary; both overridable, both passed explicitly via --root.
const hpDefaults = {
	LOCAL_HP_BINARY: join(homedir(), 'Desktop/Zeroth-Agents/herdr-projects/target/release/herdr-projects'),
	LOCAL_HP_ROOT: join(homedir(), '.herdr-projects'),
}
/** Where Sam Factory.app looks for the running stack. Holds paths only, never secrets. */
const appPointer = join(homedir(), 'Library/Application Support/Sam Factory/stack.json')
const project = 'humanlayer-factory-' + randomStableName(root)

function randomStableName(path: string) {
	let hash = 0
	for (const c of path) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
	return hash.toString(16)
}
async function run(argv: string[], env?: Record<string, string>) {
	const command = argv[0] === 'bun' ? ['bun', '--no-env-file', ...argv.slice(1)] : argv
	const child = Bun.spawn(command, { cwd: root, env, stdout: 'inherit', stderr: 'inherit' })
	if ((await child.exited) !== 0) throw new Error(`Command failed: ${argv[0]}`)
}
async function prepare() {
	await mkdir(state, { recursive: true, mode: 0o700 })
	const identity = await loadIdentity(state)
	const { createPublicKey } = await import('node:crypto')
	await writeFile(
		join(state, 'public.pem'),
		createPublicKey(identity.privateKey).export({ type: 'spki', format: 'pem' }),
		{ mode: 0o600 },
	)
	const secretsFile = join(state, 'services.json')
	if (!(await Bun.file(secretsFile).exists()))
		await writeFile(
			secretsFile,
			JSON.stringify({
				database: randomBytes(24).toString('hex'),
				electric: randomBytes(24).toString('hex'),
				redis: randomBytes(24).toString('hex'),
			}),
			{ flag: 'wx', mode: 0o600 },
		)
	if (!(await Bun.file(join(state, 'bridge-secret')).exists()))
		await writeFile(join(state, 'bridge-secret'), randomBytes(32).toString('base64url'), {
			flag: 'wx',
			mode: 0o600,
		})
	const secrets: { database: string; electric: string; redis: string } = JSON.parse(
		await readFile(secretsFile, 'utf8'),
	)
	const native: Record<string, string> = {}
	for (const name of ['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL'])
		if (process.env[name]) native[name] = process.env[name]
	const env: Record<string, string> = {
		...native,
		LOCAL_SURFACE: '1',
		VITE_LOCAL_SURFACE: '1',
		LOCAL_FACTORY_STATE: state,
		XDG_DATA_HOME: join(state, 'caddy-data'),
		XDG_CONFIG_HOME: join(state, 'caddy-config'),
		LOCAL_BROWSER_ORIGIN: browserOrigin,
		LOCAL_IDENTITY_ORIGIN: `http://127.0.0.1:${ports.identity}`,
		DATABASE_URL: `postgresql://postgres:${secrets.database}@127.0.0.1:${ports.postgres}/electric`,
		READ_REPLICA_DATABASE_URL: `postgresql://postgres:${secrets.database}@127.0.0.1:${ports.postgres}/electric`,
		REDIS_URL: `redis://:${secrets.redis}@127.0.0.1:${ports.redis}`,
		KV_URL: `redis://:${secrets.redis}@127.0.0.1:${ports.redis}`,
		ELECTRIC_SHAPE_URL: `http://127.0.0.1:${ports.electric}/v1/shape`,
		ELECTRIC_SECRET: secrets.electric,
		RIPTIDE_API_PORT: String(ports.api),
		RIPTIDE_ELECTRIC_PROXY_PORT: String(ports.proxy),
		RIPTIDE_UI_PORT: String(ports.ui),
		RIPTIDE_API_ORIGIN: browserOrigin,
		APP_ORIGIN: browserOrigin,
		CLOUD_ORIGIN: browserOrigin,
		VITE_PUBLIC_RIPTIDE_API_ORIGIN: browserOrigin,
		VITE_PUBLIC_SYNC_ORIGIN: browserOrigin + '/sync',
		S3_ARTIFACTS_BUCKET: 'disabled-local',
		S3_ARTIFACTS_REGION: 'us-east-1',
		S3_ARTIFACTS_ENDPOINT: 'http://127.0.0.1:9',
		S3_ACCESS_KEY_ID: 'disabled-local',
		S3_SECRET_ACCESS_KEY: 'disabled-local',
		DURABLE_STREAMS_ORIGIN: 'http://127.0.0.1:9',
		IS_BILLING_ENFORCEMENT_ENABLED: 'false',
		NODE_ENV: 'development',
		STAGE: 'local',
		LOCAL_FACTORY_BRIDGE_SECRET: await readFile(join(state, 'bridge-secret'), 'utf8'),
		GITHUB_APP_PRIVATE_KEY: identity.privateKey,
		RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY: join(state, 'public.pem'),
		RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY: join(state, 'identity.pem'),
		WORKOS_API_KEY: '',
		WORKOS_CLIENT_ID: '',
		WORKOS_REDIRECT_URI: '',
		WORKOS_WEBHOOK_SECRET: '',
		SENTRY_DSN: '',
		VITE_PUBLIC_SENTRY_DSN: '',
		POSTHOG_API_KEY: '',
	}
	for (const key of [
		'SLACK_CLIENT_ID',
		'SLACK_CLIENT_SECRET',
		'SLACK_APP_ID',
		'SLACK_SIGNING_SECRET',
		'GITHUB_APP_ID',
		'GITHUB_APP_CLIENT_ID',
		'GITHUB_APP_SLUG',
		'GITHUB_APP_WEBHOOK_SECRET',
		'STRIPE_SECRET_KEY',
		'STRIPE_WEBHOOK_SECRET',
		'RESEND_API_KEY',
		'RESEND_WEBHOOK_SECRET',
		'RESEND_PRODUCT_USERS_SEGMENT_ID',
		'JIRA_CLIENT_ID',
		'JIRA_CLIENT_SECRET',
		'LINEAR_CLIENT_ID',
		'LINEAR_CLIENT_SECRET',
	])
		env[key] = 'local-disabled'
	for (const key of ['STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO']) env[key] = 'price_local_disabled'
	for (const key of ['STRIPE_API_BASE_URL', 'RESEND_API_BASE_URL', 'SLACK_API_BASE_URL', 'GITHUB_API_BASE_URL'])
		env[key] = 'http://127.0.0.1:9'
	env.RESEND_FROM_EMAIL = 'sam@localhost.invalid'
	env.ONBOARDING_CAMPAIGN_ENABLED = 'false'
	for (const key of ['LOCAL_HP_BINARY', 'LOCAL_HP_ROOT', 'LOCAL_HP_PROJECT', 'LOCAL_HP_THREAD', 'LOCAL_HP_READ_ONLY'])
		if (process.env[key]) env[key] = process.env[key]
	// A named unit selects HP; the binary and root then default to the live coordinator's.
	if (env.LOCAL_HP_THREAD) for (const [key, value] of Object.entries(hpDefaults)) env[key] ??= value
	env.LOCAL_API_ORIGIN = `http://127.0.0.1:${ports.api}`
	await writeFile(
		join(state, 'compose.json'),
		JSON.stringify({
			name: project,
			services: {
				postgres: {
					image: 'postgres:18',
					environment: {
						POSTGRES_DB: 'electric',
						POSTGRES_USER: 'postgres',
						POSTGRES_PASSWORD: secrets.database,
					},
					ports: [`127.0.0.1:${ports.postgres}:5432`],
					command: ['postgres', '-c', 'wal_level=logical'],
					healthcheck: {
						test: ['CMD-SHELL', 'pg_isready -U postgres -d electric'],
						interval: '2s',
						timeout: '5s',
						retries: 30,
					},
					volumes: ['postgres:/var/lib/postgresql'],
				},
				electric: {
					image: 'electricsql/electric:1.7.12',
					environment: {
						DATABASE_URL: `postgresql://postgres:${secrets.database}@postgres:5432/electric?sslmode=disable`,
						ELECTRIC_SECRET: secrets.electric,
						ELECTRIC_TELEMETRY: 'disabled',
					},
					ports: [`127.0.0.1:${ports.electric}:3000`],
					depends_on: { postgres: { condition: 'service_healthy' } },
				},
				redis: {
					image: 'redis:7-alpine',
					command: ['redis-server', '--requirepass', secrets.redis],
					ports: [`127.0.0.1:${ports.redis}:6379`],
					volumes: ['redis:/data'],
				},
			},
			volumes: { postgres: {}, redis: {} },
		}),
		{ mode: 0o600 },
	)
	return env
}
async function checkPorts() {
	for (const port of [...Object.values(ports), Number(new URL(browserOrigin).port)])
		await new Promise<void>((ok, fail) => {
			const server = createServer()
			server.once('error', () =>
				fail(new Error(`Port ${port} is occupied; leave its owner running and choose another stack`)),
			)
			server.listen(port, '127.0.0.1', () => server.close(() => ok()))
		})
}
async function tls(env: Record<string, string>) {
	const dir = join(state, 'tls')
	await mkdir(dir, { recursive: true, mode: 0o700 })
	if (!(await Bun.file(join(dir, 'cert.pem')).exists()))
		await run(
			['mkcert', '-cert-file', join(dir, 'cert.pem'), '-key-file', join(dir, 'key.pem'), '127.0.0.1', '::1'],
			{ ...env, CAROOT: join(dir, 'ca') },
		)
	const quote = (path: string) => JSON.stringify(path)
	await writeFile(
		join(state, 'Caddyfile'),
		`{
 admin off
 auto_https off
 skip_install_trust
 servers {
  protocols h1 h2
 }
}
${browserOrigin} {
 bind 127.0.0.1
 tls ${quote(join(dir, 'cert.pem'))} ${quote(join(dir, 'key.pem'))}
 handle /factory/* {
  reverse_proxy 127.0.0.1:${ports.api}
 }
 handle /rpc/* {
  reverse_proxy 127.0.0.1:${ports.api}
 }
 handle_path /sync/* {
  reverse_proxy 127.0.0.1:${ports.proxy}
 }
 handle_path /identity/* {
  reverse_proxy 127.0.0.1:${ports.identity} {
   header_up Host 127.0.0.1:${ports.identity}
  }
 }
 handle {
  reverse_proxy 127.0.0.1:${ports.ui}
 }
}
`,
		{ mode: 0o600 },
	)
}

if (import.meta.main) {
	const command = process.argv[2]
	if (!['prepare', 'services', 'start', 'stop', 'seed', 'migrate', 'browser'].includes(command ?? ''))
		throw new Error('Use prepare, services, start, stop, seed, migrate, or browser')
	const env = await prepare()
	localAuthConfig(env)
	const compose = ['docker', 'compose', '--env-file', '/dev/null', '-p', project, '-f', join(state, 'compose.json')]
	if (command === 'prepare') {
		await tls(env)
		console.log('Prepared isolated local state and scoped TLS; no system trust installed')
	}
	if (command === 'services') {
		await checkPorts()
		await run([...compose, 'up', '-d', '--wait'], env)
	}
	if (command === 'stop') await run([...compose, 'stop'], env)
	if (command === 'migrate') {
		if (!process.argv.includes('--disposable'))
			throw new Error('Retained data requires the apply gate; --disposable is only for a new test volume')
		await run(['bun', '--cwd', 'packages/db', 'drizzle-kit', 'migrate'], env)
	}
	if (command === 'seed') await run(['bun', 'local-factory/seed.ts'], env)
	if (command === 'browser') {
		const pem = await Bun.file(join(state, 'tls/cert.pem')).text()
		const { createHash, createPublicKey } = await import('node:crypto')
		const pin = createHash('sha256')
			.update(createPublicKey(pem).export({ type: 'spki', format: 'der' }))
			.digest('base64')
		// Pass URL via private argv only; never print its bootstrap fragment to logs.
		const bootstrap = await readFile(join(state, 'bootstrap-secret'), 'utf8')
		const candidates = [
			process.env.LOCAL_CHROME_BINARY,
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		]
		const browserCache = join(homedir(), '.agent-browser/browsers')
		try {
			for (const name of (await readdir(browserCache)).sort().reverse())
				candidates.push(
					join(browserCache, name, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
				)
		} catch {
			/* An explicit/system Chrome may still be available. */
		}
		let chrome: string | undefined
		for (const path of candidates)
			if (path && (await Bun.file(path).exists())) {
				chrome = path
				break
			}
		if (!chrome) throw new Error('Set LOCAL_CHROME_BINARY to an installed Chrome executable')
		const wrapper = join(state, 'chrome-loopback')
		await writeFile(wrapper, chromeWrapper(chrome, pin, process.platform === 'darwin'), { mode: 0o700 })

		const socketRecord = join(state, 'browser-socket-dir')
		const sockets = (await Bun.file(socketRecord).exists())
			? (await readFile(socketRecord, 'utf8')).trim()
			: await mkdtemp('/private/tmp/hl-factory-')
		if (!/^\/private\/tmp\/hl-factory-[a-zA-Z0-9]+$/.test(sockets))
			throw new Error('Invalid private browser socket path')
		await mkdir(sockets, { recursive: true, mode: 0o700 })
		const socketStat = await lstat(sockets)
		if (
			!socketStat.isDirectory() ||
			socketStat.isSymbolicLink() ||
			socketStat.uid !== process.getuid?.() ||
			(socketStat.mode & 0o077) !== 0
		)
			throw new Error('Browser socket directory must be private and owned')
		await writeFile(socketRecord, sockets, { mode: 0o600 })
		const child = Bun.spawn(
			['agent-browser', '--headed', 'open', browserOrigin + '/#local-bootstrap=' + bootstrap],
			{
				env: {
					...env,
					AGENT_BROWSER_EXECUTABLE_PATH: wrapper,
					AGENT_BROWSER_SESSION: project,
					AGENT_BROWSER_PROFILE: join(state, 'browser-profile'),
					AGENT_BROWSER_SOCKET_DIR: sockets,
				},
				stdout: 'ignore',
				stderr: 'inherit',
			},
		)
		if (await child.exited) throw new Error('Local browser did not start')
	}
	if (command === 'start') {
		await tls(env)
		await mkdir(dirname(appPointer), { recursive: true, mode: 0o700 })
		await writeFile(appPointer, JSON.stringify({ origin: browserOrigin, state }), { mode: 0o600 })
		const commands = [
			['bun', '--no-env-file', 'local-factory/identity.ts'],
			['bun', '--no-env-file', '--preload', './local-factory/preload.ts', 'apps/riptide-api/src/index.ts'],
			[
				'bun',
				'--no-env-file',
				'--preload',
				'./local-factory/preload.ts',
				'apps/riptide-electric-proxy/src/index.ts',
			],
			['bun', '--no-env-file', '--cwd', 'apps/riptide-ui', 'node_modules/vite/bin/vite.js'],
			['caddy', 'run', '--config', join(state, 'Caddyfile'), '--adapter', 'caddyfile'],
		]
		if (env.LOCAL_HP_BINARY) commands.push(['bun', '--no-env-file', 'local-factory/bridge.ts'])
		const children = commands.map((argv) =>
			Bun.spawn(
				process.platform === 'darwin'
					? [
							'sandbox-exec',
							'-p',
							'(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))',
							...argv,
						]
					: argv,
				{ cwd: root, env, stdout: 'inherit', stderr: 'inherit' },
			),
		)
		const stop = () => {
			for (const child of children) child.kill('SIGTERM')
		}
		process.on('SIGINT', stop)
		process.on('SIGTERM', stop)
		try {
			await Promise.race(children.map((child) => child.exited))
		} finally {
			stop()
			// Electric streams can keep Caddy's graceful shutdown open indefinitely.
			const timeout = setTimeout(() => {
				for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
			}, 5000)
			try {
				await Promise.all(children.map((child) => child.exited))
			} finally {
				clearTimeout(timeout)
			}
		}
	}
}
