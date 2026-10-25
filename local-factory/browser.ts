/** Quote literal argv into a generated POSIX launcher; do not use JSON as shell escaping. */
export function shellQuote(value: string) {
	return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function chromeWrapper(executable: string, pin: string, contain: boolean) {
	const args = [
		executable,
		'--ignore-certificate-errors-spki-list=' + pin,
		'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
	]
	if (contain) {
		// Chrome cannot initialize its own macOS sandbox inside sandbox-exec.
		// All browser children still inherit the outer loopback-only sandbox.
		args.push('--no-sandbox')
		args.unshift(
			'/usr/bin/sandbox-exec',
			'-p',
			'(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))',
		)
	}
	return '#!/bin/sh\nexec ' + args.map(shellQuote).join(' ') + ' "$@"\n'
}
