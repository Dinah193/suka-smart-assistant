-- operational.outbox.hardening.sql
-- Lease/heartbeat/dead-letter hardening for operational outbox delivery.

alter table operational_outbox_events
  add column if not exists processor_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists dead_letter_reason text,
  add column if not exists dead_lettered_at timestamptz;

create index if not exists idx_operational_outbox_processing_lease
  on operational_outbox_events (status, lease_expires_at, updated_at)
  where status = 'processing';

create index if not exists idx_operational_outbox_dead_letter
  on operational_outbox_events (status, dead_lettered_at, event_type)
  where status = 'dead_letter';

create table if not exists operational_outbox_observability_config (
  config_key text primary key,
  threshold_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_operational_outbox_status_allowed'
  ) then
    alter table operational_outbox_events
      add constraint chk_operational_outbox_status_allowed check (
        status in ('pending', 'retry', 'processing', 'processed', 'dead_letter')
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_operational_outbox_attempts_nonnegative'
  ) then
    alter table operational_outbox_events
      add constraint chk_operational_outbox_attempts_nonnegative check (attempts >= 0);
  end if;
end
$$;