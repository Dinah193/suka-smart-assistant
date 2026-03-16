-- preservation.schema.sql
-- PostgreSQL records for processed/preserved inventory and batch-cooking logs.

create table if not exists preservation_batches (
  id uuid primary key,
  household_id text not null,
  source_type text not null,
  source_ref_id text,
  method text not null,
  started_at timestamptz,
  completed_at timestamptz,
  prep_time_minutes int not null default 0,
  cook_time_minutes int not null default 0,
  prep_time_reduction_pct numeric(5,4) not null default 0,
  notes text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists preservation_inventory (
  id uuid primary key,
  household_id text not null,
  batch_id uuid references preservation_batches(id) on delete set null,
  item_name text not null,
  qty numeric(12,2) not null default 0,
  unit text not null,
  method text not null,
  shelf_life_days int,
  available_from timestamptz,
  expires_at timestamptz,
  collaboration_ready boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists planner_audit_history (
  id uuid primary key,
  household_id text not null,
  planner text not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists planner_projection_jobs (
  id uuid primary key,
  household_id text not null,
  planner text not null,
  update_type text not null,
  status text not null default 'queued',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  projection_result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_projection_jobs_status_next_attempt
  on planner_projection_jobs (status, next_attempt_at, created_at);

create index if not exists idx_preservation_inventory_household_created_at
  on preservation_inventory (household_id, created_at desc);

create index if not exists idx_preservation_inventory_household_expires_at
  on preservation_inventory (household_id, expires_at);

create index if not exists idx_planner_audit_history_household_created_at
  on planner_audit_history (household_id, planner, created_at desc);

create index if not exists idx_projection_jobs_household_planner_status_updated_at
  on planner_projection_jobs (household_id, planner, status, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_preservation_batches_minutes_nonnegative') then
    alter table preservation_batches
      add constraint chk_preservation_batches_minutes_nonnegative check (
        prep_time_minutes >= 0
        and cook_time_minutes >= 0
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_preservation_batches_reduction_pct_range') then
    alter table preservation_batches
      add constraint chk_preservation_batches_reduction_pct_range check (
        prep_time_reduction_pct >= 0
        and prep_time_reduction_pct <= 1
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_preservation_inventory_qty_nonnegative') then
    alter table preservation_inventory
      add constraint chk_preservation_inventory_qty_nonnegative check (
        qty >= 0
        and (shelf_life_days is null or shelf_life_days >= 0)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_projection_jobs_attempts_nonnegative') then
    alter table planner_projection_jobs
      add constraint chk_projection_jobs_attempts_nonnegative check (attempts >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_projection_jobs_status_allowed') then
    alter table planner_projection_jobs
      add constraint chk_projection_jobs_status_allowed check (
        status in ('queued', 'retry', 'processing', 'processed', 'dead_letter')
      );
  end if;
end
$$;
