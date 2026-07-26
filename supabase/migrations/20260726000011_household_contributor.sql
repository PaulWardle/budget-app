-- Household contributor classification.
--
-- Money arriving from a named contributor (a partner sharing costs) means two
-- different things depending on size, per the user's actual arrangement:
--   * small payments are repayments for shared spending → transfers, so they
--     never inflate income;
--   * large lumps are genuine household income the user allocates to big
--     expenses → income under "Household contribution", never "Salary".
-- The rule PROPOSES: large lumps arrive with needs_review = true so the
-- classification is one tap to flip, and the threshold is configurable.
-- Database-level so every write path (imports, AI chat, manual) is covered.

alter table profiles
  add column if not exists household_contributor text,
  add column if not exists household_contribution_threshold_minor bigint not null default 50000;

create or replace function public.classify_household_contribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contributor text;
  threshold bigint;
  income_cat uuid;
  transfer_cat uuid;
begin
  if new.amount_minor <= 0 then
    return new;
  end if;
  select household_contributor, household_contribution_threshold_minor
    into contributor, threshold
    from profiles where id = new.user_id;
  if contributor is null or length(trim(contributor)) < 4 then
    return new;
  end if;
  if upper(coalesce(new.merchant_name, '') || ' ' || new.description)
       not like '%' || upper(trim(contributor)) || '%' then
    return new;
  end if;

  if new.amount_minor >= threshold then
    select id into income_cat from categories
      where user_id = new.user_id and name = 'Household contribution' limit 1;
    if income_cat is not null then
      new.category_id := income_cat;
      new.is_transfer := false;
      new.needs_review := true; -- proposed, not decided — one tap to flip
    end if;
  else
    select c.id into transfer_cat from categories c
      join categories p on p.id = c.parent_id
      where c.user_id = new.user_id and lower(p.name) = 'transfers'
        and upper(c.name) like '%' || upper(split_part(trim(contributor), ' ', 1)) || '%'
      limit 1;
    new.is_transfer := true;
    if transfer_cat is not null then
      new.category_id := transfer_cat;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists classify_household_contribution on public.transactions;
create trigger classify_household_contribution
  before insert on public.transactions
  for each row execute function public.classify_household_contribution();
