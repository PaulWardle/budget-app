-- Mark a transaction as unusual so it stops feeding "typical spending".
--
-- Distinct from exclude_from_budget (which removes it from budget actuals
-- entirely) and exclude_from_analytics (which hides it from reporting): a
-- one-off still happened, still counts as money spent, and still belongs in the
-- month's totals — it just shouldn't set the expectation for future months.

alter table transactions
  add column if not exists is_one_off boolean not null default false;

create index if not exists transactions_one_off_idx
  on transactions (user_id, is_one_off) where is_one_off;
