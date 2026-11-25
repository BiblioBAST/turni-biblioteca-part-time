(() => {
  'use strict';
  const SUPABASE_URL = 'https://qinkysjtxborkwvaiqoo.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_UCVePtbIxdklv14pWqp7Ww_2DDRMxq0';
  const VAPID_PUBLIC_KEY = 'PASTE_VAPID_PUBLIC_KEY_HERE';
  const TOKEN_KEY = 'turni_token';
  let adding = false;
  let checking = false;

  function base64ToBytes(value) {
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
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) throw new Error(data?.message || data?.error || 'Richiesta non riuscita.');
    return data;
  }
  async function studentLoggedIn() {
    try {
      const result = await rpc('app_me', {});
      return result?.user?.role === 'student' && !result.user.mustChange;
    } catch { return false; }
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
        throw new Error('L’amministratore deve configurare prima la chiave pubblica VAPID.');
      }
      const registration = await navigator.serviceWorker.register('./sw.js');
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await rpc('app_push_unsubscribe', { p_endpoint: current.endpoint });
        await current.unsubscribe();
        button.textContent = 'Attiva avviso in coda';
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Permesso notifiche non concesso. Abilitalo nelle impostazioni del browser.');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(VAPID_PUBLIC_KEY),
      });
      try {
        await rpc('app_push_subscribe', { p_subscription: subscription.toJSON() });
      } catch (error) {
        await subscription.unsubscribe();
        throw error;
      }
      button.textContent = 'Disattiva avviso in coda';
    } catch (error) {
      alert(error?.message || 'Non è stato possibile aggiornare le notifiche.');
    } finally {
      adding = false;
      button.disabled = false;
    }
  }
  async function addButton() {
    if (checking) return;
    const who = document.querySelector('header .who');
    if (!who || who.querySelector('[data-push-toggle]')) return;
    checking = true;
    try {
      if (!(await studentLoggedIn())) return;
      const currentWho = document.querySelector('header .who');
      if (!currentWho || currentWho.querySelector('[data-push-toggle]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.pushToggle = 'true';
      button.textContent = 'Attiva avviso in coda';
      button.setAttribute('aria-label', 'Attiva o disattiva le notifiche push per il turno in coda');
      button.addEventListener('click', () => toggle(button));
      currentWho.insertBefore(button, currentWho.querySelector('button') || null);
      const registration = await navigator.serviceWorker.register('./sw.js');
      if (await registration.pushManager.getSubscription()) button.textContent = 'Disattiva avviso in coda';
    } catch { /* browser senza supporto push */ }
    finally { checking = false; }
  }
  const observer = new MutationObserver(addButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addButton();
})();
