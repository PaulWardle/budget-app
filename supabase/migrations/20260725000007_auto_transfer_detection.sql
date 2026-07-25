-- Transfers between the user's OWN accounts are not income or spending, so
-- they must never skew stats. Payments to/from other people stay counted.
-- Three automatic mechanisms, at the database level so every write path
-- (imports, bulk edits, AI chat) is covered:
--   1. Categorising a transaction as "Transfers" sets is_transfer.
--   2. A transaction naming the account holder (profiles.display_name) is a
--      movement of their own money — e.g. to a savings account that isn't
--      imported into the app.
--   3. An equal-and-opposite amount in a different owned account within
--      ±2 days is paired and both rows are flagged (skipping income rows).

create or replace function public.sync_transfer_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cat record;
  own_name text;
begin
  if new.category_id is not null then
    select c.name, p.name as parent_name into cat
    from categories c left join categories p on p.id = c.parent_id
    where c.id = new.category_id;
    if lower(coalesce(cat.parent_name, cat.name)) = 'transfers' then
      new.is_transfer := true;
    end if;
  end if;
  if not new.is_transfer then
    select display_name into own_name from profiles where id = new.user_id;
    if own_name is not null and length(trim(own_name)) >= 5
       and upper(coalesce(new.merchant_name, '') || ' ' || new.description) like '%' || upper(trim(own_name)) || '%' then
      new.is_transfer := true;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists sync_transfer_flag on public.transactions;
create trigger sync_transfer_flag
  before insert or update of category_id on public.transactions
  for each row execute function public.sync_transfer_flag();

create or replace function public.pair_transfers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare cand uuid;
begin
  if new.is_transfer or new.transfer_pair_id is not null or new.amount_minor = 0 then
    return null;
  end if;
  if new.category_id is not null and exists (
    select 1 from categories c left join categories p on p.id = c.parent_id
    where c.id = new.category_id and lower(coalesce(p.name, c.name)) = 'income'
  ) then
    return null;
  end if;
  select t.id into cand
  from transactions t
  where t.user_id = new.user_id
    and t.account_id <> new.account_id
    and t.amount_minor = -new.amount_minor
    and t.id <> new.id
    and t.is_transfer = false
    and t.transfer_pair_id is null
    and t.date between new.date - 2 and new.date + 2
    and not exists (
      select 1 from categories c2 left join categories p2 on p2.id = c2.parent_id
      where c2.id = t.category_id and lower(coalesce(p2.name, c2.name)) = 'income'
    )
  order by abs(t.date - new.date), t.id
  limit 1;
  if cand is not null then
    update transactions set is_transfer = true, transfer_pair_id = new.id where id = cand;
    update transactions set is_transfer = true, transfer_pair_id = cand where id = new.id;
  end if;
  return null;
end $$;

drop trigger if exists pair_transfers on public.transactions;
create trigger pair_transfers
  after insert on public.transactions
  for each row execute function public.pair_transfers();
