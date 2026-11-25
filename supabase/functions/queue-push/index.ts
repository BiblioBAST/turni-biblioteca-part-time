// Edge Function: invia la push 10 secondi prima del termine del turno attivo.
// La richiesta iniziale viene generata dal trigger SQL e resta in attesa sul server.
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TRIGGER_SECRET = Deno.env.get('PUSH_TRIGGER_SECRET')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
const WARNING_SECONDS = 10;
// Supabase limita la durata di una singola invocazione. Il valore predefinito
// (60s) richiede circa 50s di attesa. Il massimo qui supportato lascia margine
// entro il limite runtime comune delle Edge Functions.
const MAX_WAIT_MS = 120_000;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function selectRows(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!response.ok) throw new Error(`Supabase REST ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function deleteSubscription(endpoint: string) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/push_subscriptions`);
  url.searchParams.set('endpoint', `eq.${endpoint}`);
  await fetch(url, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!TRIGGER_SECRET || request.headers.get('x-push-trigger-secret') !== TRIGGER_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const job = await request.json();
    const queueId = String(job.queue_id || '');
    const cycleWeek = String(job.cycle_week || '');
    const activeUserId = String(job.user_id || '');
    const startedAt = String(job.started_at || '');
    if (!/^\d+$/.test(queueId) || !/^\d{4}-\d{2}-\d{2}$/.test(cycleWeek) ||
        !/^[0-9a-f-]{36}$/i.test(activeUserId) || !Number.isFinite(Date.parse(startedAt))) {
      return json({ error: 'Invalid job payload' }, 400);
    }

    const cfgRows = await selectRows('config?select=turn_seconds&id=eq.1&limit=1');
    const turnSeconds = Number(cfgRows?.[0]?.turn_seconds);
    if (!Number.isInteger(turnSeconds) || turnSeconds < 10 || turnSeconds > 600) {
      return json({ error: 'Invalid turn duration' }, 500);
    }
    const deadline = Date.parse(startedAt) + turnSeconds * 1000;
    const sendAt = deadline - WARNING_SECONDS * 1000;
    const waitMs = sendAt - Date.now();
    if (waitMs > MAX_WAIT_MS) {
      // Fail closed rather than send a late/incorrect warning. Keep queue turns
      // at 130 seconds or less for this delayed-notification implementation.
      console.error(`Queue push wait (${waitMs}ms) exceeds Edge Function limit`);
      return json({ error: 'Turn duration too long for delayed push; use 130 seconds or less' }, 422);
    }
    if (waitMs > 0) await sleep(waitMs);

    // Re-check at send time: an early finish, skip, removal, or replaced turn
    // must not alert a user who is no longer next.
    const activeRows = await selectRows(
      `queue?select=id,user_id,status,started_at,cycle_week&id=eq.${encodeURIComponent(queueId)}&limit=1`,
    );
    const active = activeRows?.[0];
    if (!active || active.status !== 'active' || active.user_id !== activeUserId ||
        active.cycle_week !== cycleWeek || Date.parse(active.started_at) !== Date.parse(startedAt)) {
      return json({ ok: true, skipped: 'active turn changed' });
    }
    const waitingRows = await selectRows(
      `queue?select=user_id,status&id=gt.0&cycle_week=eq.${encodeURIComponent(cycleWeek)}&status=eq.waiting&order=id.asc&limit=1`,
    );
    const nextUserId = waitingRows?.[0]?.user_id;
    if (!nextUserId) return json({ ok: true, skipped: 'no one waiting' });

    const subscriptions = await selectRows(
      `push_subscriptions?select=endpoint,p256dh,auth&user_id=eq.${encodeURIComponent(nextUserId)}`,
    );
    const message = JSON.stringify({
      title: 'Tra 10 secondi tocca a te',
      body: 'Riattiva il cellulare o riapri la pagina: il tuo turno sta per iniziare.',
      url: '/',
    });
    let sent = 0;
    let removed = 0;
    for (const row of subscriptions || []) {
      const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(subscription, message, { TTL: 60, urgency: 'high' });
        sent++;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number }).statusCode);
        if (statusCode === 404 || statusCode === 410) {
          await deleteSubscription(row.endpoint);
          removed++;
        } else {
          console.error('Push delivery failed', statusCode, String(error));
        }
      }
    }
    return json({ ok: true, sent, removed });
  } catch (error) {
    console.error('queue-push error', String(error));
    return json({ error: 'Push scheduling failed' }, 500);
  }
});
