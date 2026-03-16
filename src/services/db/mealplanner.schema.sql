-- mealplanner.schema.sql
-- PostgreSQL system-of-record tables for meal planner outputs.

create table if not exists meal_plans (
  id uuid primary key,
  household_id text not null,
  user_id text not null,
  title text not null,
  start_date date not null,
  end_date date not null,
  planner_output jsonb not null default '{}'::jsonb,
  recommendation_score jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meal_plan_items (
  id uuid primary key,
  meal_plan_id uuid not null references meal_plans(id) on delete cascade,
  recipe_id text,
  meal_type text not null,
  planned_at timestamptz,
  prep_minutes int not null default 0,
  cook_minutes int not null default 0,
  prep_reduction_minutes int not null default 0,
  cook_reduction_minutes int not null default 0,
  preserved_inputs jsonb not null default '[]'::jsonb
);

create index if not exists idx_meal_plans_household_updated_at
  on meal_plans (household_id, updated_at desc);

create index if not exists idx_meal_plan_items_meal_plan_planned_at
  on meal_plan_items (meal_plan_id, planned_at);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_meal_plans_date_range') then
    alter table meal_plans
      add constraint chk_meal_plans_date_range check (end_date >= start_date);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_meal_plan_items_minutes_nonnegative') then
    alter table meal_plan_items
      add constraint chk_meal_plan_items_minutes_nonnegative check (
        prep_minutes >= 0
        and cook_minutes >= 0
        and prep_reduction_minutes >= 0
        and cook_reduction_minutes >= 0
      );
  end if;
end
$$;
