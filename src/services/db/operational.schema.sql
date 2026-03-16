-- operational.schema.sql
-- Core SSA operational PostgreSQL backend. PostgreSQL is the authoritative system of record.

create extension if not exists pgcrypto;

create or replace function ssa_set_audit_fields()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.record_version = coalesce(old.record_version, 1) + 1;
  return new;
end
$$;

create or replace function ssa_set_search_vector()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'saved_recipes' then
    new.search_vector = to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' || coalesce(new.notes, '') || ' ' || coalesce(array_to_string(new.tags, ' '), '')
    );
  elsif tg_table_name = 'task_sessions' then
    new.search_vector = to_tsvector(
      'english',
      coalesce(new.title, '') || ' ' || coalesce(new.notes, '')
    );
  elsif tg_table_name = 'storehouse_lots' then
    new.search_vector = to_tsvector(
      'english',
      coalesce(new.item_name, '') || ' ' || coalesce(new.sku, '') || ' ' || coalesce(new.metadata->>'notes', '')
    );
  end if;
  return new;
end
$$;

create table if not exists ssa_users (
  id uuid primary key default gen_random_uuid(),
  external_ref text,
  email text,
  display_name text,
  profile jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create unique index if not exists ux_ssa_users_email_active
  on ssa_users (lower(email))
  where email is not null and is_active = true;

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  household_key text unique,
  name text not null,
  timezone text not null default 'UTC',
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create table if not exists household_memberships (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references ssa_users(id) on delete cascade,
  role text not null default 'member',
  preferences jsonb not null default '{}'::jsonb,
  joined_at timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1,
  unique (household_id, user_id)
);

create index if not exists idx_household_memberships_household_active
  on household_memberships (household_id, is_active)
  where is_active = true;

create table if not exists saved_recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  saved_by_user_id uuid references ssa_users(id) on delete set null,
  recipe_ref text not null,
  title text not null,
  source text,
  tags text[] not null default '{}',
  notes text,
  recipe_payload jsonb not null default '{}'::jsonb,
  search_vector tsvector,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1,
  unique (household_id, recipe_ref)
);

create index if not exists idx_saved_recipes_household_active
  on saved_recipes (household_id, updated_at desc)
  where archived = false;

create index if not exists idx_saved_recipes_fts
  on saved_recipes
  using gin (search_vector);

create table if not exists garden_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  season_key text not null,
  plan jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '[]'::jsonb,
  status text not null default 'draft',
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create index if not exists idx_garden_plans_household_season
  on garden_plans (household_id, season_key, updated_at desc);

create table if not exists animal_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  animal_key text,
  species text not null,
  stage text,
  qty numeric(12,2) not null default 0,
  production jsonb not null default '{}'::jsonb,
  health jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1,
  unique (household_id, animal_key)
);

create index if not exists idx_animal_records_household_active
  on animal_records (household_id, species, updated_at desc)
  where is_active = true;

create table if not exists task_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  assigned_user_id uuid references ssa_users(id) on delete set null,
  task_type text not null,
  status text not null default 'queued',
  title text not null,
  notes text,
  context jsonb not null default '{}'::jsonb,
  search_vector tsvector,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create index if not exists idx_task_sessions_household_open
  on task_sessions (household_id, status, updated_at desc)
  where status in ('queued', 'in_progress', 'blocked');

create index if not exists idx_task_sessions_fts
  on task_sessions
  using gin (search_vector);

create table if not exists task_session_events (
  id uuid primary key default gen_random_uuid(),
  task_session_id uuid not null references task_sessions(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create index if not exists idx_task_session_events_session_created
  on task_session_events (task_session_id, created_at desc);

create table if not exists planner_outputs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  planner text not null,
  planner_run_key text,
  output jsonb not null default '{}'::jsonb,
  score jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create index if not exists idx_planner_outputs_household_planner_recent
  on planner_outputs (household_id, planner, updated_at desc)
  where status = 'active';

create table if not exists operational_change_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  table_name text not null,
  record_id text not null,
  operation text not null,
  before_state jsonb,
  after_state jsonb,
  changed_by text,
  change_reason text,
  changed_at timestamptz not null default now()
);

create index if not exists idx_operational_change_history_household_time
  on operational_change_history (household_id, changed_at desc);

create index if not exists idx_operational_change_history_table_record_time
  on operational_change_history (table_name, record_id, changed_at desc);

create table if not exists operational_outbox_events (
  id uuid primary key default gen_random_uuid(),
  household_id text,
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  event_meta jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  change_reason text,
  record_version bigint not null default 1
);

create index if not exists idx_operational_outbox_status_available
  on operational_outbox_events (status, available_at, created_at)
  where status in ('pending', 'retry');

create index if not exists idx_operational_outbox_household_created
  on operational_outbox_events (household_id, created_at desc);

-- Backfill audit fields on existing transactional planner tables.
alter table meal_plans
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table meal_plan_items
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table storehouse_lots
  add column if not exists search_vector tsvector,
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table preservation_batches
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table preservation_inventory
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table planner_audit_history
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table homestead_plans
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table homestead_outputs
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

alter table planner_projection_jobs
  add column if not exists updated_by text,
  add column if not exists change_reason text,
  add column if not exists record_version bigint not null default 1;

create index if not exists idx_storehouse_lots_qty_positive
  on storehouse_lots (household_id, qty desc, updated_at desc)
  where qty > 0;

create index if not exists idx_storehouse_lots_fts
  on storehouse_lots
  using gin (search_vector);

update saved_recipes
set search_vector = to_tsvector(
  'english',
  coalesce(title, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(array_to_string(tags, ' '), '')
)
where search_vector is null;

update task_sessions
set search_vector = to_tsvector(
  'english',
  coalesce(title, '') || ' ' || coalesce(notes, '')
)
where search_vector is null;

update storehouse_lots
set search_vector = to_tsvector(
  'english',
  coalesce(item_name, '') || ' ' || coalesce(sku, '') || ' ' || coalesce(metadata->>'notes', '')
)
where search_vector is null;

-- Trigger wiring for update-time and row-version bump.
drop trigger if exists trg_audit_ssa_users on ssa_users;
create trigger trg_audit_ssa_users before update on ssa_users
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_households on households;
create trigger trg_audit_households before update on households
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_household_memberships on household_memberships;
create trigger trg_audit_household_memberships before update on household_memberships
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_saved_recipes on saved_recipes;
create trigger trg_audit_saved_recipes before update on saved_recipes
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_search_saved_recipes on saved_recipes;
create trigger trg_search_saved_recipes before insert or update on saved_recipes
for each row execute function ssa_set_search_vector();

drop trigger if exists trg_audit_garden_plans on garden_plans;
create trigger trg_audit_garden_plans before update on garden_plans
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_animal_records on animal_records;
create trigger trg_audit_animal_records before update on animal_records
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_task_sessions on task_sessions;
create trigger trg_audit_task_sessions before update on task_sessions
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_search_task_sessions on task_sessions;
create trigger trg_search_task_sessions before insert or update on task_sessions
for each row execute function ssa_set_search_vector();

drop trigger if exists trg_audit_task_session_events on task_session_events;
create trigger trg_audit_task_session_events before update on task_session_events
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_planner_outputs on planner_outputs;
create trigger trg_audit_planner_outputs before update on planner_outputs
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_operational_outbox_events on operational_outbox_events;
create trigger trg_audit_operational_outbox_events before update on operational_outbox_events
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_meal_plans on meal_plans;
create trigger trg_audit_meal_plans before update on meal_plans
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_meal_plan_items on meal_plan_items;
create trigger trg_audit_meal_plan_items before update on meal_plan_items
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_storehouse_lots on storehouse_lots;
create trigger trg_audit_storehouse_lots before update on storehouse_lots
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_search_storehouse_lots on storehouse_lots;
create trigger trg_search_storehouse_lots before insert or update on storehouse_lots
for each row execute function ssa_set_search_vector();

drop trigger if exists trg_audit_preservation_batches on preservation_batches;
create trigger trg_audit_preservation_batches before update on preservation_batches
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_preservation_inventory on preservation_inventory;
create trigger trg_audit_preservation_inventory before update on preservation_inventory
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_planner_audit_history on planner_audit_history;
create trigger trg_audit_planner_audit_history before update on planner_audit_history
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_homestead_plans on homestead_plans;
create trigger trg_audit_homestead_plans before update on homestead_plans
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_homestead_outputs on homestead_outputs;
create trigger trg_audit_homestead_outputs before update on homestead_outputs
for each row execute function ssa_set_audit_fields();

drop trigger if exists trg_audit_planner_projection_jobs on planner_projection_jobs;
create trigger trg_audit_planner_projection_jobs before update on planner_projection_jobs
for each row execute function ssa_set_audit_fields();

-- Query pattern views for household readiness.
create or replace view household_meal_readiness_v1 as
select
  h.id as household_id,
  coalesce(mp.latest_plan_at, null) as latest_meal_plan_at,
  coalesce(mp.total_plans_30d, 0) as total_meal_plans_30d,
  coalesce(sr.saved_recipe_count, 0) as saved_recipe_count,
  coalesce(inv.ready_lots, 0) as ready_lots,
  coalesce(inv.reserved_lots, 0) as reserved_lots
from households h
left join (
  select
    case
      when household_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then household_id::uuid
      else null
    end as household_id,
    max(updated_at) as latest_plan_at,
    count(*) filter (where created_at >= now() - interval '30 days') as total_plans_30d
  from meal_plans
  group by 1
) mp on mp.household_id = h.id
left join (
  select household_id, count(*) as saved_recipe_count
  from saved_recipes
  where archived = false
  group by household_id
) sr on sr.household_id = h.id
left join (
  select
         case
           when household_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then household_id::uuid
           else null
         end as household_id,
         count(*) filter (where qty > 0) as ready_lots,
         count(*) filter (where reserved_qty > 0) as reserved_lots
  from storehouse_lots
  group by 1
) inv on inv.household_id = h.id;

create or replace view household_storehouse_readiness_v1 as
select
  case
    when household_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then household_id::uuid
    else null
  end as household_id,
  count(*) filter (where qty > 0) as in_stock_lots,
  count(*) filter (where qty > 0 and expires_at is not null and expires_at <= now() + interval '7 days') as expiring_7d,
  count(*) filter (where state = 'preserved' and qty > 0) as preserved_lots,
  sum(qty) filter (where qty > 0) as total_qty_in_stock
from storehouse_lots
group by 1;

create or replace view household_homestead_schedule_readiness_v1 as
select
  h.id as household_id,
  coalesce(gp.active_garden_plans, 0) as active_garden_plans,
  coalesce(ar.active_animals, 0) as active_animals,
  coalesce(ho.upcoming_outputs_14d, 0) as upcoming_outputs_14d,
  coalesce(ts.open_task_sessions, 0) as open_task_sessions
from households h
left join (
  select household_id, count(*) as active_garden_plans
  from garden_plans
  where status in ('draft', 'active')
  group by household_id
) gp on gp.household_id = h.id
left join (
  select household_id, count(*) as active_animals
  from animal_records
  where is_active = true
  group by household_id
) ar on ar.household_id = h.id
left join (
  select
    case
      when hp.household_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then hp.household_id::uuid
      else null
    end as household_id,
    count(*) as upcoming_outputs_14d
  from homestead_outputs ho
  join homestead_plans hp on hp.id = ho.homestead_plan_id
  where ho.expected_harvest_at is not null
    and ho.expected_harvest_at <= now() + interval '14 days'
  group by 1
) ho on ho.household_id = h.id
left join (
  select household_id, count(*) as open_task_sessions
  from task_sessions
  where status in ('queued', 'in_progress', 'blocked')
  group by household_id
) ts on ts.household_id = h.id;