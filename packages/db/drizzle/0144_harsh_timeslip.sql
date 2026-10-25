CREATE TABLE "factory_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_units" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"source_generation" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "factory_units_org_unit_unique" UNIQUE("organization_id","unit")
);
--> statement-breakpoint
ALTER TABLE "artifact_comments" ADD COLUMN "viewed_version_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "factory_requests" ADD CONSTRAINT "factory_requests_task_id_factory_units_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."factory_units"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_requests" ADD CONSTRAINT "factory_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_units" ADD CONSTRAINT "factory_units_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_units" ADD CONSTRAINT "factory_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_units" ADD CONSTRAINT "factory_units_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;