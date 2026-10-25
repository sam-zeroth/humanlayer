import type { WorkOS } from '@workos-inc/node'
import { Config, Context, Effect, Layer, Redacted } from 'effect'

import { localAuthConfig } from '../../../../../local-factory/config'
import { EnvironmentVariable } from '../../lib/effect/environment'

/**
 * Define the Workos Config Services used for creating other services that depend on workos stuf
 */
export class WorkosConfig extends Context.Service<
	WorkosConfig,
	{
		workosClientId: string
		workosRedirectUri: string
		workos?: WorkOS
		jwksUrl: string
	}
>()('WorkosConfig') {}

/**
 * This is the workos layer which implements the service definition WorkosConfig
 * distinct e.g. from WorkosConfigTest  - this is the correct effect idiom
 */
export const WorkosConfigLive = Layer.effect(
	WorkosConfig,
	Effect.gen(function* () {
		const localEnvironment = yield* Config.all({
			LOCAL_SURFACE: Config.String('LOCAL_SURFACE').pipe(Config.withDefault('0')),
			LOCAL_IDENTITY_ORIGIN: Config.String('LOCAL_IDENTITY_ORIGIN').pipe(
				Config.withDefault('http://127.0.0.1:55801'),
			),
			LOCAL_BROWSER_ORIGIN: Config.String('LOCAL_BROWSER_ORIGIN').pipe(
				Config.withDefault('https://127.0.0.1:55813'),
			),
		}).pipe(Effect.orDie)
		const localConfig = localEnvironment.LOCAL_SURFACE === '1' ? localAuthConfig(localEnvironment) : undefined

		if (localConfig !== undefined) {
			const config = localConfig
			return {
				workosClientId: 'local-disabled',
				workosRedirectUri: config.browserOrigin,
				jwksUrl: config.issuer + '/jwks',
			}
		}
		// do effectful things to build it
		const workosClientId = yield* EnvironmentVariable('WORKOS_CLIENT_ID')
		const workosRedirectUri = yield* EnvironmentVariable('WORKOS_REDIRECT_URI')
		const workosApiKey = yield* EnvironmentVariable('WORKOS_API_KEY').pipe(Effect.map(Redacted.make))

		const { WorkOS } = yield* Effect.promise(() => import('@workos-inc/node'))
		const workos = new WorkOS(Redacted.value(workosApiKey))

		return {
			workosClientId,
			workosRedirectUri,
			workos,
			jwksUrl: workos.userManagement.getJwksUrl(workosClientId),
		}
	}),
)
