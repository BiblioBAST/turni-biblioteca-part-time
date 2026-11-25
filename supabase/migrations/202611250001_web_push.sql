-- =====================================================================
-- 06_web_push.sql — notifiche push per la coda (Supabase)
-- Esegui DOPO aver installato lo schema attuale (01 + aggiornamenti 04 e 05).
-- Non modifica né cancella utenti, prenotazioni o fila.
-- =====================================================================

-- pg_net invia una chiamata asincrona alla Edge Function quando parte un turno.
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

-- Configurazione privata del trigger server -> Edge Function. Il segreto deve
-- essere lo stesso valore impostato come PUSH_TRIGGER_SECRET nella Function.
create table if not exists turni.push_config (
  id int primary key default 1 check (id = 1),
  function_url text not null,
  trigger_secret text not null
);
alter table turni.push_config enable row level security;
revoke all on turni.push_config from public, anon, authenticated;

-- Registrazione/aggiornamento della sottoscrizione del browser autenticato.
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

revoke all on function public.app_push_subscribe(text, jsonb) from public;
revoke all on function public.app_push_unsubscribe(text, text) from public;
grant execute on function public.app_push_subscribe(text, jsonb) to anon, authenticated;
grant execute on function public.app_push_unsubscribe(text, text) to anon, authenticated;

-- Quando il turno passa ad active, una richiesta asincrona avvia il conto
-- alla rovescia sul server. L'Edge Function ricontrolla la fila prima di inviare.
create or replace function turni.schedule_queue_push()
returns trigger language plpgsql security definer set search_path = turni, net, pg_temp as $$
declare
  cfg turni.push_config;
  v_request_id bigint;
begin
  if new.status <> 'active' or new.started_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.started_at is not distinct from new.started_at then
    return new;
  end if;
  select * into cfg from turni.push_config where id = 1;
  if not found or cfg.function_url is null or cfg.trigger_secret is null then return new; end if;
  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-trigger-secret', cfg.trigger_secret),
    body := jsonb_build_object('queue_id', new.id, 'cycle_week', new.cycle_week,
      'user_id', new.user_id, 'started_at', new.started_at),
    timeout_milliseconds := 5000
  ) into v_request_id;
  return new;
end $$;

drop trigger if exists queue_schedule_push on turni.queue;
create trigger queue_schedule_push
after insert or update of status, started_at on turni.queue
for each row execute function turni.schedule_queue_push();

-- Dopo aver distribuito la Function, inserisci qui URL e segreto condiviso.
-- Sostituisci SOLO il valore del segreto con lo stesso PUSH_TRIGGER_SECRET
-- impostato in Supabase Edge Functions; non committare il valore in GitHub.
-- Esegui questo UPSERT separatamente nel SQL Editor:
-- insert into turni.push_config(id, function_url, trigger_secret)
-- values (1, 'https://qinkysjtxborkwvaiqoo.supabase.co/functions/v1/queue-push', 'INSERISCI_QUI_IL_TUO_SEGRETO')
-- on conflict (id) do update set function_url = excluded.function_url, trigger_secret = excluded.trigger_secret;
