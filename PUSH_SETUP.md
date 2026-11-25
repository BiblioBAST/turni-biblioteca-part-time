# Attivare le notifiche push della fila (Supabase + GitHub Pages)

La push avvisa la persona successiva in fila circa 10 secondi prima della fine del turno in corso. L’invio è avviato dal database quando un turno passa ad `active`; l’Edge Function attende fino all’istante previsto, ricontrolla che il turno non sia cambiato e invia la notifica.

## Importante prima di applicare

- Fai un backup del progetto Supabase e del repository.
- Il database deve già avere lo schema applicativo e gli aggiornamenti `04_blocca_giorni_passati.sql` e `05_sovrapposizione_turni.sql`.
- L’Edge Function resta attiva mentre attende. Il turno standard da 60 secondi rientra nel limite supportato; durate lunghe possono non inviare la notifica. Per questo caso, mantieni **Durata del turno ≤ 130 secondi**.
- Le notifiche sono best effort: non è possibile garantire la consegna precisa al secondo. iOS richiede che il sito sia aggiunto alla schermata Home e che l’utente autorizzi le notifiche.

## 1. Generare chiavi VAPID e un segreto

Installa Node.js sul computer e lancia:

```bash
npx web-push generate-vapid-keys
```

Conserva la chiave pubblica e privata. La privata non deve mai essere pubblicata o inserita in SQL/GitHub. Genera anche un segreto trigger distinto:

```bash
openssl rand -hex 32
```

## 2. Caricare i file nel repository

Il branch di lavoro è `copilot/queue-web-push`. Contiene `push-client.js`, `sw.js`, `supabase/functions/queue-push/index.ts`, `supabase/config.toml` e questa guida.

1. Apri una Pull Request dal branch `copilot/queue-web-push` a `main` e uniscila dopo aver verificato i file.
2. Il nuovo `sw.js` carica automaticamente `push-client.js` nelle navigazioni successive. Non devi editare manualmente il grande `index.html`.
3. Prima di unire, apri `push-client.js` e sostituisci `PASTE_VAPID_PUBLIC_KEY_HERE` con la tua chiave pubblica VAPID.
4. Attendi che GitHub Pages aggiorni il sito. Il service worker si aggiorna quando gli utenti riaprono il sito; può essere necessario chiudere e riaprire la pagina una volta dopo l’aggiornamento.

Non unire o distribuire il codice finché il placeholder VAPID resta nel file: il pulsante avviserà che la chiave non è configurata.

## 3. Eseguire la migrazione SQL in Supabase

1. Apri Supabase → **SQL Editor** → **New query**.
2. Copia tutto `supabase/migrations/202611250001_web_push.sql` dal branch e premi **Run**.
3. Se compare un errore per `pg_net`, abilita l’estensione `pg_net` in **Database → Extensions** e riesegui la migrazione.
4. La migrazione aggiunge tabelle private, RPC e un trigger; non modifica le prenotazioni o gli account.

## 4. Distribuire l’Edge Function

Installa Supabase CLI, apri un terminale nella copia locale del repository e lancia:

```bash
supabase login
supabase link --project-ref qinkysjtxborkwvaiqoo
supabase secrets set PUSH_TRIGGER_SECRET="IL_TUO_SEGRETO_CASUALE" VAPID_PUBLIC_KEY="LA_TUA_CHIAVE_PUBBLICA" VAPID_PRIVATE_KEY="LA_TUA_CHIAVE_PRIVATA" VAPID_SUBJECT="mailto:tuo-indirizzo@example.org"
supabase functions deploy queue-push --no-verify-jwt
```

`PUSH_TRIGGER_SECRET` deve essere esattamente il segreto casuale creato al punto 1. La chiave privata rimane nelle secrets Supabase. Il comando usa `--no-verify-jwt` perché PostgreSQL non invia un JWT utente; la Function verifica invece il segreto dedicato.

## 5. Collegare il database alla Function

In Supabase → **SQL Editor** esegui il comando seguente, sostituendo il valore placeholder con lo stesso segreto `PUSH_TRIGGER_SECRET`:

```sql
insert into turni.push_config(id, function_url, trigger_secret)
values (1, 'https://qinkysjtxborkwvaiqoo.supabase.co/functions/v1/queue-push', 'IL_TUO_SEGRETO_CASUALE')
on conflict (id) do update
set function_url = excluded.function_url, trigger_secret = excluded.trigger_secret;
```

Non salvare il segreto nel repository e non condividerlo. La RPC che legge la coda è concessa soltanto al ruolo `service_role`; le tabelle private non sono accessibili dal browser.

## 6. Attivare le notifiche per gli studenti

Dopo il deploy, ogni studente deve accedere e premere **Attiva avviso in coda** nella barra in alto, quindi consentire le notifiche. La sottoscrizione è specifica di browser e dispositivo: va ripetuta su ogni telefono/computer utilizzato. Per revocarla si preme **Disattiva avviso in coda**.

Su iPhone/iPad: aggiungere il sito alla schermata Home, aprirlo dall’icona e accettare la richiesta notifiche. Le impostazioni di sistema, risparmio energetico e rete possono ritardare o bloccare le push.

## 7. Test controllato

1. Attiva le push su un account studente e mettilo in attesa.
2. Avvia un turno con un altro studente.
3. Verifica che la persona in attesa riceva l’avviso quando mancano circa 10 secondi.
4. Termina anticipatamente il turno attivo: in quel caso non deve arrivare un avviso ormai non pertinente.
5. Controlla log della Function da Supabase → **Edge Functions → queue-push → Logs**.

## Limiti tecnici

- La consegna può subire ritardi del servizio push o del dispositivo. L’avviso è best effort.
- Il conto alla rovescia è tenuto dall’Edge Function; turni lunghi oltre la finestra supportata (circa 130 secondi) non sono supportati da questa implementazione. Mantieni la durata entro quel valore.
- Una sottoscrizione revocata/scaduta dal browser può richiedere che lo studente disattivi e riattivi gli avvisi.
