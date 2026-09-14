CREATE TABLE "workflow_assignments" (
	"run_id" text,
	"sequence" integer,
	"data" jsonb NOT NULL,
	CONSTRAINT "workflow_assignments_pkey" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY,
	"issue_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"resume_requested" boolean DEFAULT false NOT NULL,
	"resume_answer" text
);
--> statement-breakpoint
CREATE TABLE "workflow_worker_owners" (
	"worker_group" text PRIMARY KEY,
	"worker_id" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_active_issue" ON "workflow_runs" ("issue_id") WHERE "data"->>'status' <> 'approved';--> statement-breakpoint
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_run_id_workflow_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id");