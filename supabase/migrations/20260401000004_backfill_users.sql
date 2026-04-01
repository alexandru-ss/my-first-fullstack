-- Backfill any auth.users rows missing from public.users.
-- Covers users who signed up before the on_auth_user_created trigger existed.
insert into public.users (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Make the new-user trigger idempotent so re-runs never fail.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
