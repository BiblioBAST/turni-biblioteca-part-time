// Push client for the static GitHub Pages app.
// Include this file in index.html immediately before </body>:
// <script src="./push-client.js"></script>
// Replace the public key below with VAPID_PUBLIC_KEY generated for this app.
(() => {
  'use strict';
  const SUPABASE_URL = 'https://qinkysjtxborkwvaiqoo.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_UCVePtbIxdklv14pWqp7Ww_2DDRMxq0';
  const VAPID_PUBLIC_KEY = 'PASTE_VAPID_PUBLIC_KEY_HERE';
  const TOKEN_KEY = 'turni_token';
  let adding = false;

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  async function rpc(name, body) {
    const tok = token();
    if (!tok) throw new Error('Accedi di nuovo per gestire le notifiche.');
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ p_token: tok, ...body }),
    });
    let data = null;
    try { data = await response.json(); } catch { /* risposta vuota */ }
    if (!response.ok || (data && data.error)) throw new Error((data && (data.message || data.error)) || 'Richiesta non riuscita.');
    return data;
  }
  async function isStudent() {
    try {
      const me = await rpc('app_me', {});
      return me?.user?.role === 'student' && !me.user.mustChange;
    } catch { return false; }
  }
  function showError(error) {
    const message = error && error.message ? error.message : 'Non è stato possibile aggiornare le notifiche.';
    alert(message);
  }
  async function toggle(button) {
    if (adding) return;
    adding = true;
    button.disabled = true;
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        throw new Error('Questo browser non supporta le notifiche push.');
      }
      if (VAPID_PUBLIC_KEY === 'PASTE_VAPID_PUBLIC_KEY_HERE') {
        throw new Error('L’amministratore deve inserire prima la chiave pubblica VAPID in push-client.js.');
      }
      const registration = await navigator.serviceWorker.register('./sw.js');
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await rpc('app_push_unsubscribe', { p_endpoint: existing.endpoint });
        await existing.unsubscribe();
        button.textContent = 'Attiva avviso in coda';
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Permesso notifiche non concesso. Puoi abilitarlo dalle impostazioni del browser.');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      try {
        await rpc('app_push_subscribe', { p_subscription: subscription.toJSON() });
      } catch (error) {
        await subscription.unsubscribe();
        throw error;
      }
      button.textContent = 'Disattiva avviso in coda';
    } catch (error) {
      showError(error);
    } finally {
      adding = false;
      button.disabled = false;
    }
  }

  async function installButton() {
    const who = document.querySelector('header .who');
    if (!who || who.querySelector('[data-push-toggle]')) return;
    if (!(await isStudent()) || !document.querySelector('header .who')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.dataset.pushToggle = 'true';
    button.textContent = 'Attiva avviso in coda';
    button.setAttribute('aria-label', 'Attiva o disattiva le notifiche push per il turno in coda');
    button.addEventListener('click', () => toggle(button));
    who.insertBefore(button, who.querySelector('button') || null);
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      if (await registration.pushManager.getSubscription()) button.textContent = 'Disattiva avviso in coda';
    } catch { /* la pagina può essere in un browser senza supporto push */ }
  }

  const observer = new MutationObserver(() => { installButton(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  installButton();
})();
