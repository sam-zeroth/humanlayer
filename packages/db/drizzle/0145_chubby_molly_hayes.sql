ALTER TABLE "factory_requests" ADD COLUMN "hp_response" jsonb;--> statement-breakpoint
ALTER TABLE "factory_requests" ADD COLUMN "hp_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "factory_requests" ADD COLUMN "delivery_error" text;