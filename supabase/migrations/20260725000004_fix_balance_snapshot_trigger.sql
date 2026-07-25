-- The snapshot trigger ran BEFORE INSERT, inserting a snapshot row that
-- references an accounts row which doesn't exist yet → FK violation on every
-- account creation. Split it: BEFORE UPDATE touches balance_updated_at;
-- AFTER INSERT/UPDATE writes the snapshot once the account row is real.

drop trigger if exists account_balance_snapshot on public.accounts;

create or replace function public.touch_balance_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.balance_minor is distinct from old.balance_minor then
    new.balance_updated_at = now();
  end if;
  return new;
end $$;

create or replace function public.snapshot_account_balance()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.balance_minor is distinct from old.balance_minor then
    insert into public.account_balance_snapshots
      (user_id, account_id, balance_minor, source)
    values (new.user_id, new.id, new.balance_minor, new.balance_source);
  end if;
  return null;
end $$;

create trigger account_balance_touch
  before update on public.accounts
  for each row execute function public.touch_balance_updated_at();

create trigger account_balance_snapshot
  after insert or update on public.accounts
  for each row execute function public.snapshot_account_balance();
