-- =====================================================================
-- 06_web_push.sql — notifiche push per la coda (Supabase)
-- Esegui DOPO lo schema attuale e dopo gli aggiornamenti 04 e 05.
-- Non modifica né cancella utenti, prenotazioni o fila.
-- =====================================================================

-- pg_net invia la richiesta iniziale all'Edge Function senza bloccare la fila.
create extension if not exists pg_net;

create table if not exists turni.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references turni.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on turni.push_subscriptions(user_id);
alter table turni.push_subscriptions enable row level security;
revoke all on turni.push_subscriptions from public, anon, authenticated;

-- Impostazioni private: endpoint e segreto condiviso per il trigger SQL.
create table if not exists turni.push_config (
  id int primary key default 1 check (id = 1),
  function_url text not null,
  trigger_secret text not null
);
alter table turni.push_config enable row level security;
revoke all on turni.push_config from public, anon, authenticated;

create or replace function public.app_push_subscribe(p_token text, p_subscription jsonb)
returns jsonb language plpgsql security definer set search_path = turni, extensions, pg_temp as $$
declare
  u turni.users;
  v_endpoint text;
  v_p256dh text;
  v_auth text;
begin
  u := turni.auth(p_token);
  if u.role <> 'student' then perform turni.fail('Le notifiche di coda sono disponibili solo per gli studenti', 403); end if;
  if jsonb_typeof(p_subscription) <> 'object' then perform turni.fail('Sottoscrizione non valida', 400); end if;
  v_endpoint := p_subscription->>'endpoint';
  v_p256dh := p_subscription#>>'{keys,p256dh}';
  v_auth := p_subscription#>>'{keys,auth}';
  if v_endpoint is null or length(v_endpoint) > 2048 or v_endpoint !~ '^https://' or
     v_p256dh is null or length(v_p256dh) > 200 or v_p256dh !~ '^[A-Za-z0-9_-]+$' or
     v_auth is null or length(v_auth) > 100 or v_auth !~ '^[A-Za-z0-9_-]+$' then
    perform turni.fail('Dati della sottoscrizione push non validi', 400);
  end if;
  insert into turni.push_subscriptions(endpoint, user_id, p256dh, auth, updated_at)
    values (v_endpoint, u.id, v_p256dh, v_auth, now())
    on conflict (endpoint) do update set user_id = excluded.user_id,
      p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.app_push_unsubscribe(p_token text, p_endpoint text)
returns jsonb language plpgsql security definer set search_path = turni, extensions, pg_temp as $$
declare u turni.users;
begin
  u := turni.auth(p_token, true);
  if p_endpoint is not null then
    delete from turni.push_subscriptions where endpoint = p_endpoint and user_id = u.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- RPC privata per l'Edge Function: convalida il segreto lato DB e restituisce
-- solo l'utente ancora in attesa e le sue sottoscrizioni push.
create or replace function public.app_push_prepare(
  p_trigger_secret text, p_queue_id bigint, p_expected_started_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = turni, extensions, pg_temp as $$
declare
  cfg turni.push_config;
  q turni.queue;
  next_user uuid;
  subs jsonb;
  v_turn_seconds int;
begin
  select * into cfg from turni.push_config where id = 1;
  if not found or p_trigger_secret is null or cfg.trigger_secret <> p_trigger_secret then
    perform turni.fail('Non autorizzato', 401);
  end if;
  select * into q from turni.queue
   where id = p_queue_id and status = 'active'
     and started_at = p_expected_started_at;
  if not found then return jsonb_build_object('send', false, 'reason', 'turn_changed'); end if;
  select turn_seconds into v_turn_seconds from turni.config where id = 1;
  select user_id into next_user from turni.queue
   where cycle_week = q.cycle_week and status = 'waiting' order by id limit 1;
  if next_user is null then return jsonb_build_object('send', false, 'reason', 'no_waiting_user'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth)), '[]'::jsonb)
    into subs from turni.push_subscriptions where user_id = next_user;
  return jsonb_build_object('send', true, 'turn_seconds', v_turn_seconds,
    'started_at', q.started_at, 'subscriptions', subs);
end $$;

revoke all on function public.app_push_subscribe(text, jsonb) from public;
revoke all on function public.app_push_unsubscribe(text, text) from public;
revoke all on function public.app_push_prepare(text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.app_push_subscribe(text, jsonb) to anon, authenticated;
grant execute on function public.app_push_unsubscribe(text, text) to anon, authenticated;
grant execute on function public.app_push_prepare(text, bigint, timestamptz) to service_role;

create or replace function turni.schedule_queue_push()
returns trigger language plpgsql security definer set search_path = turni, net, pg_temp as $$
declare
  cfg turni.push_config;
  v_turn_seconds int;
  v_request_id bigint;
begin
  if new.status <> 'active' or new.started_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.started_at is not distinct from new.started_at then
    return new;
  end if;
  select * into cfg from turni.push_config where id = 1;
  if not found then return new; end if;
  select turn_seconds into v_turn_seconds from turni.config where id = 1;
  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-trigger-secret', cfg.trigger_secret),
    body := jsonb_build_object('queue_id', new.id, 'started_at', new.started_at,
      'turn_seconds', v_turn_seconds),
    timeout_milliseconds := 5000
  ) into v_request_id;
  return new;
end $$;

drop trigger if exists queue_schedule_push on turni.queue;
create trigger queue_schedule_push
after insert or update of status, started_at on turni.queue
for each row execute function turni.schedule_queue_push();

-- Dopo aver distribuito la Function, configura URL e segreto con l'UPSERT
-- descritto in PUSH_SETUP.md. Non inserire mai il segreto in GitHub.
