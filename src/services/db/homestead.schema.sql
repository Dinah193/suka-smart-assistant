-- homestead.schema.sql
-- PostgreSQL planning records for garden, orchard/vineyard, herbs/spices, and animals.

create table if not exists homestead_plans (
  id uuid primary key,
  household_id text not null,
  season_key text not null,
  garden_plan jsonb not null default '{}'::jsonb,
  orchard_plan jsonb not null default '{}'::jsonb,
  herb_spice_plan jsonb not null default '{}'::jsonb,
  animal_plan jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists homestead_outputs (
  id uuid primary key,
  homestead_plan_id uuid not null references homestead_plans(id) on delete cascade,
  output_type text not null,
  output_name text not null,
  qty numeric(12,2) not null default 0,
  unit text not null,
  expected_harvest_at timestamptz,
  preservation_ready boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_homestead_plans_household_updated_at
  on homestead_plans (household_id, updated_at desc);

create index if not exists idx_homestead_outputs_plan_harvest_name
  on homestead_outputs (homestead_plan_id, expected_harvest_at, output_name);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_homestead_outputs_qty_nonnegative') then
    alter table homestead_outputs
      add constraint chk_homestead_outputs_qty_nonnegative check (qty >= 0);
  end if;
end
$$;
