-- GodHealth app: Stripe subscriptions ($20/month) gate access to the app.
-- Rows are written only by the stripe-webhook edge function (service role).
-- The app reads access through gh_subscription_status(); clients cannot read or write the table directly.

create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  stripe_customer_id text,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);
create index if not exists subscriptions_email_idx on public.subscriptions (lower(email));
create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated;

-- Access check for the signed-in user.
-- Matches on user id (set via client_reference_id at checkout) or on a confirmed email address,
-- so people who paid before creating their account also get access.
create or replace function public.gh_subscription_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  em text;
  s public.subscriptions%rowtype;
  legacy boolean := false;
begin
  if uid is null then
    return jsonb_build_object('active', false, 'status', 'signed_out');
  end if;

  select lower(u.email) into em
  from auth.users u
  where u.id = uid and u.email_confirmed_at is not null;

  select * into s
  from public.subscriptions
  where user_id = uid or (em is not null and lower(email) = em)
  order by (status in ('active', 'trialing')) desc, current_period_end desc nulls last
  limit 1;

  if found
     and s.status in ('active', 'trialing')
     and (s.current_period_end is null or s.current_period_end > now() - interval '2 days') then
    return jsonb_build_object(
      'active', true,
      'status', s.status,
      'current_period_end', s.current_period_end,
      'cancel_at_period_end', s.cancel_at_period_end
    );
  end if;

  -- Members from the old token system keep access until their end date
  if to_regclass('public.tokens') is not null then
    execute 'select exists (select 1 from public.tokens where user_id = $1 and active and end_date > now())'
      into legacy using uid;
    if legacy then
      return jsonb_build_object('active', true, 'status', 'legacy');
    end if;
  end if;

  return jsonb_build_object('active', false, 'status', coalesce(s.status, 'none'));
end;
$$;

revoke all on function public.gh_subscription_status() from public, anon;
grant execute on function public.gh_subscription_status() to authenticated;

-- Link a subscription that was matched by email to the account, so it keeps working if the email changes later.
create or replace function public.gh_link_subscription_to_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null and new.email is not null then
    select u.id into new.user_id
    from auth.users u
    where lower(u.email) = lower(new.email) and u.email_confirmed_at is not null
    limit 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists subscriptions_link_user on public.subscriptions;
create trigger subscriptions_link_user
  before insert or update on public.subscriptions
  for each row execute function public.gh_link_subscription_to_user();

-- Cloud sync for app data (one JSON document per user per key)
create table if not exists public.user_app_data (
  user_id uuid not null references auth.users(id) on delete cascade,
  data_key text not null,
  data jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, data_key)
);

alter table public.user_app_data enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_app_data' and policyname = 'user_app_data_own_rows') then
    create policy user_app_data_own_rows on public.user_app_data
      for all to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

grant select, insert, update, delete on public.user_app_data to authenticated;
