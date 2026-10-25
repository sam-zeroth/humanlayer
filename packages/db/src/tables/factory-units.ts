import { bigint, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'

import type { HpGateResponse } from '../factory-gate'
import type { FactoryRequest, FactorySnapshot } from '../factory-unit'
import { artifacts } from './artifacts'
import { organizations } from './organizations'
import { tasks } from './tasks'

/** A replaceable projection. HP remains authoritative for all unit and approval state. */
export const factoryUnits = pgTable(
	'factory_units',
	{
		task_id: uuid('task_id')
			.primaryKey()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		organization_id: uuid('organization_id')
			.notNull()
			.references(() => organizations.id),
		unit: text('unit').notNull(),
		artifact_id: uuid('artifact_id')
			.notNull()
			.references(() => artifacts.id),
		artifact_version_id: uuid('artifact_version_id').notNull(),
		snapshot_hash: text('snapshot_hash').notNull(),
		source_generation: bigint('source_generation', { mode: 'number' }).notNull(),
		snapshot: jsonb('snapshot').$type<FactorySnapshot>().notNull(),
		synced_at: bigint('synced_at', { mode: 'number' }).notNull(),
	},
	(t) => [unique('factory_units_org_unit_unique').on(t.organization_id, t.unit)],
)

/** Immutable browser intent plus a bridge-only cache of HP authority; never a local decision. */
export const factoryRequests = pgTable('factory_requests', {
	id: uuid('id').primaryKey(),
	task_id: uuid('task_id')
		.notNull()
		.references(() => factoryUnits.task_id, { onDelete: 'cascade' }),
	organization_id: uuid('organization_id')
		.notNull()
		.references(() => organizations.id),
	created_by_user_id: text('created_by_user_id').notNull(),
	payload: jsonb('payload').$type<FactoryRequest>().notNull(),
	hp_response: jsonb('hp_response').$type<HpGateResponse>(),
	hp_checked_at: bigint('hp_checked_at', { mode: 'number' }),
	delivery_error: text('delivery_error'),
	created_at: bigint('created_at', { mode: 'number' }).notNull(),
})
