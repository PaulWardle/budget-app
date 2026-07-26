-- Presumed bill postings: when a bill falls due, the app posts an expected
-- transaction and reduces the account balance — like an energy estimate.
-- Statement uploads are the meter reading: actuals replace presumptions
-- (see reconcilePresumed in the client), so day-to-day balances stay live
-- between imports and self-correct whenever real data arrives.

alter table public.transactions
  add column is_presumed boolean not null default false;

create index transactions_presumed_idx
  on public.transactions (user_id) where is_presumed;

alter table public.profiles
  add column auto_post_bills boolean not null default true;

-- ------------------------------------------------------------- daily poster
-- Runs as a scheduled job (pg_cron). For every active outgoing bill whose
-- due date has arrived: if the ledger doesn't already show the real payment,
-- insert a presumed transaction and reduce the account balance; either way
-- advance next_due_date so Bills/forecasts always look forward. Income is
-- never presumed — money isn't real until it lands.
create or replace function public.post_due_bills()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  acct uuid;
  d date;
  guard integer;
  posted integer := 0;
begin
  for r in
    select rp.*
    from recurring_payments rp
    join profiles p on p.id = rp.user_id
    where rp.status = 'active'
      and rp.amount_minor < 0
      and p.auto_post_bills
      and rp.next_due_date <= current_date
  loop
    acct := r.account_id;
    if acct is null then
      -- default to the user's freshest current account
      select a.id into acct from accounts a
      where a.user_id = r.user_id and a.account_type = 'current'
        and a.archived_at is null
      order by a.balance_updated_at desc nulls last
      limit 1;
    end if;

    -- Walk each overdue occurrence up to today. Occurrences older than a
    -- fortnight advance silently (never backfill history); recent ones post
    -- unless the ledger already covers them.
    d := r.next_due_date;
    guard := 0;
    while d <= current_date and guard < 120 loop
      if acct is not null
        and d > current_date - 14
        and not exists (
          -- the real payment (or an earlier presumption) already covers this
          select 1 from transactions t
          where t.user_id = r.user_id
            and t.recurring_payment_id = r.id
            and t.date between d - 5 and d + 5
        )
      then
        insert into transactions
          (user_id, account_id, date, description, merchant_name, category_id,
           amount_minor, recurring_payment_id, liability_id, source, is_presumed)
        values
          (r.user_id, acct, d, r.name || ' (expected)', r.name,
           r.category_id, r.amount_minor, r.id, r.liability_id, 'system', true);
        update accounts
          set balance_minor = balance_minor + r.amount_minor,
              balance_source = 'calculated'
          where id = acct;
        posted := posted + 1;
      end if;
      d := case r.frequency
        when 'weekly'      then d + 7
        when 'fortnightly' then d + 14
        when 'four_weekly' then d + 28
        when 'monthly'     then (d + interval '1 month')::date
        when 'quarterly'   then (d + interval '3 months')::date
        when 'six_monthly' then (d + interval '6 months')::date
        when 'annual'      then (d + interval '1 year')::date
        else d + greatest(coalesce(r.interval_days, 30), 1)
      end;
      guard := guard + 1;
    end loop;
    update recurring_payments set next_due_date = d where id = r.id;
  end loop;
  return posted;
end;
$$;

-- cron only — not callable from the API
revoke execute on function public.post_due_bills() from public, anon, authenticated;

create extension if not exists pg_cron;

select cron.schedule(
  'post-due-bills',
  '30 3 * * *',                       -- daily, 03:30 UTC
  $$select public.post_due_bills()$$
);
