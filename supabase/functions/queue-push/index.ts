// Edge Function: avverte la prossima persona in fila circa 10 secondi prima
// del termine del turno attivo. Il server ricontrolla la coda al momento invio.
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TRIGGER_SECRET = Deno.env.get('PUSH_TRIGGER_SECRET')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
const WARNING_SECONDS = 10;
const MAX_WAIT_MS = 120_000;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepare(queueId: string, startedAt: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_push_prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      p_trigger_secret: TRIGGER_SECRET,
      p_queue_id: queueId,
      p_expected_started_at: startedAt,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Push preparation failed (${response.status})`);
  return result;
}

async function deleteSubscription(endpoint: string) {
  // La rimozione avviene solo tramite RPC dedicata con il service role;
  // l'endpoint proviene dal risultato limitato della RPC protetta.
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_push_delete_expired`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_trigger_secret: TRIGGER_SECRET, p_endpoint: endpoint }),
  });
  if (!response.ok) console.error('Could not remove expired push subscription', response.status);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!TRIGGER_SECRET || request.headers.get('x-push-trigger-secret') !== TRIGGER_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }
  try {
    const job = await request.json();
    const queueId = String(job.queue_id || '');
    const startedAt = String(job.started_at || '');
    const turnSeconds = Number(job.turn_seconds);
    if (!/^\d+$/.test(queueId) || !Number.isFinite(Date.parse(startedAt)) ||
        !Number.isInteger(turnSeconds) || turnSeconds < 10 || turnSeconds > 600) {
      return json({ error: 'Invalid job payload' }, 400);
    }
    const waitMs = Date.parse(startedAt) + (turnSeconds - WARNING_SECONDS) * 1000 - Date.now();
    if (waitMs > MAX_WAIT_MS) {
      // Supabase Edge Functions cannot reliably sleep through long queue turns.
      // Default 60-second turns are supported; long turns fail closed.
      console.error(`Queue push wait ${waitMs}ms exceeds supported delay`);
      return json({ error: 'Turn is longer than the supported delayed-push window' }, 422);
    }
    if (waitMs > 0) await sleep(waitMs);

    const prepared = await prepare(queueId, startedAt);
    if (!prepared?.send) return json({ ok: true, skipped: prepared?.reason || 'not sendable' });
    if (Date.parse(prepared.started_at) !== Date.parse(startedAt)) {
      return json({ ok: true, skipped: 'active turn changed' });
    }
    const payload = JSON.stringify({
      title: 'Tra 10 secondi tocca a te',
      body: 'Riattiva il cellulare o riapri la pagina: il tuo turno sta per iniziare.',
      url: '/',
    });
    let sent = 0;
    let removed = 0;
    for (const row of prepared.subscriptions || []) {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { TTL: 60, urgency: 'high' },
        );
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
