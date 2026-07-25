-- Security hardening from Supabase advisor findings:
-- pin function search_path and stop clients calling the signup trigger via RPC.

alter function public.set_updated_at() set search_path = public;
alter function public.snapshot_account_balance() set search_path = public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
