-- storehouse.schema.sql
-- PostgreSQL inventory and lot tracking, including processed and preserved foods.

create table if not exists storehouse_lots (
  id uuid primary key,
  household_id text not null,
  sku text not null,
  item_name text not null,
  qty numeric(12,2) not null default 0,
  unit text not null,
  state text not null default 'raw',
  method text,
  reserved_qty numeric(12,2) not null default 0,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_storehouse_lots_household_sku
  on storehouse_lots (household_id, sku);

create index if not exists idx_storehouse_lots_household_updated_at
  on storehouse_lots (household_id, updated_at desc);

create index if not exists idx_storehouse_lots_household_state_expires
  on storehouse_lots (household_id, state, expires_at);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_storehouse_lots_qty_nonnegative') then
    alter table storehouse_lots
      add constraint chk_storehouse_lots_qty_nonnegative check (qty >= 0 and reserved_qty >= 0);
  end if;
end
$$;
