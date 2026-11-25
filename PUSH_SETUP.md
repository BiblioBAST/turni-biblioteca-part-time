# Attivare le notifiche push della fila (Supabase + GitHub Pages)

Questa procedura aggiunge una push quando mancano circa 10 secondi al termine del turno attivo. Funziona anche se la pagina è chiusa o il telefono è bloccato, purché il browser/dispositivo consenta Web Push e l’utente abbia attivato le notifiche.

## Prima di cominciare

- Fai prima una copia/backup del repository e del progetto Supabase.
- Il database deve già avere il sistema turni aggiornato, inclusi `04_blocca_giorni_passati.sql` e `05_sovrapposizione_turni.sql`.
- La logica di attesa dell’Edge Function è pensata per la durata standard di 60 secondi; per avere un margine affidabile imposta la durata del turno a **130 secondi o meno**. Il pannello permette valori maggiori, ma questa implementazione restituisce errore per turni più lunghi.
- Le push Web richiedono HTTPS. GitHub Pages lo fornisce. Su iPhone/iPad l’utente deve aggiungere il sito alla schermata Home e concedere il permesso quando richiesto da iOS.

## 1. Generare le chiavi VAPID

Sul computer installa Node.js, poi esegui:

```bash
npx web-push generate-vapid-keys
```

Conserva entrambe le chiavi in un password manager:

- `Public Key`: va nella pagina pubblica e nelle variabili della Function.
- `Private Key`: **solo** nelle Secrets dell’Edge Function; non inserirla mai nel repository o in SQL.

Genera inoltre un segreto condiviso casuale lungo almeno 32 byte (esempio su macOS/Linux):

```bash
openssl rand -hex 32
```

Non riutilizzare password o chiavi di Supabase per questo segreto.

## 2. Eseguire la migrazione SQL

1. Apri Supabase → **SQL Editor** → **New query**.
2. Copia ed esegui tutto il file `supabase/migrations/202611250001_web_push.sql` presente nel branch.
3. Se `pg_net` non è disponibile o non può essere installata, fermati e abilitala da **Database → Extensions** prima di rieseguire la migrazione.
4. La migrazione crea solo tabelle private, due RPC protette e un trigger; non elimina dati esistenti.

## 3. Distribuire l’Edge Function

Installa Supabase CLI (istruzioni ufficiali: https://supabase.com/docs/guides/cli), accedi e collega il progetto:

```bash
supabase login
supabase link --project-ref qinkysjtxborkwvaiqoo
```

Dalla cartella locale del repository, configura le secrets. Sostituisci i valori con le chiavi generate. `VAPID_SUBJECT` può essere un indirizzo email raggiungibile:

```bash
supabase secrets set PUSH_TRIGGER_SECRET="IL_SEGRETO_CASUALE" VAPID_PUBLIC_KEY="LA_CHIAVE_PUBBLICA" VAPID_PRIVATE_KEY="LA_CHIAVE_PRIVATA" VAPID_SUBJECT="mailto:tuo-indirizzo@example.org"
```

Distribuisci la funzione:

```bash
supabase functions deploy queue-push --no-verify-jwt
```

`--no-verify-jwt` è necessario perché la invoca il trigger PostgreSQL; la funzione verifica invece l’header segreto `x-push-trigger-secret`. Non pubblicare né condividere tale segreto.

## 4. Collegare il trigger alla Function

Nel SQL Editor esegui questo comando sostituendo `IL_SEGRETO_CASUALE` con lo stesso valore impostato in `PUSH_TRIGGER_SECRET` (senza aggiungere il valore al repository):

```sql
insert into turni.push_config(id, function_url, trigger_secret)
values (1, 'https://qinkysjtxborkwvaiqoo.supabase.co/functions/v1/queue-push', 'IL_SEGRETO_CASUALE')
on conflict (id) do update
set function_url = excluded.function_url, trigger_secret = excluded.trigger_secret;
```

Il segreto va inserito solo nel pannello Supabase e nella configurazione locale/CLI, non in un commit.

## 5. Mettere i file sul sito GitHub Pages

Carica/committa sul branch o sul repository pubblicato:

- `sw.js` (sovrascrive il service worker esistente);
- `push-client.js`;
- `index.html` aggiornato con la riga indicata sotto.

Apri `push-client.js` e sostituisci `PASTE_VAPID_PUBLIC_KEY_HERE` con la sola chiave **pubblica** VAPID. È sicuro pubblicare questa chiave.

Nel file `index.html`, aggiungi immediatamente prima di `</body>`:

```html
<script src="./push-client.js"></script>
```

Il branch contiene `push-client.js` e il nuovo `sw.js`; per non sovrascrivere accidentalmente la pagina esistente, la riga di inclusione va aggiunta al `index.html` corrente nel repository. Dopo il commit attendi il deploy GitHub Pages e ricarica la pagina.

## 6. Attivazione da parte di ogni studente

1. Lo studente accede al sito e, dopo aver cambiato la password provvisoria, preme **Attiva avviso in coda** nella barra superiore.
2. Accetta il permesso notifiche del browser.
3. Il browser memorizza la sottoscrizione per quel dispositivo e la associa all’account. Ogni dispositivo/browser va attivato separatamente.
4. Per disattivarla, lo studente preme **Disattiva avviso in coda**.

Il pulsante si vede solo agli studenti autenticati; un account admin non può registrare una sottoscrizione push per la coda.

## 7. Verifica

Per una prova controllata, imposta temporaneamente una durata turno breve ma non inferiore a 20 secondi, attiva le notifiche su un account studente in attesa, avvia un turno con un altro account e verifica la push circa 10 secondi prima della scadenza. La push dice di riattivare il cellulare o riaprire la pagina.

La funzione ricontrolla lo stato al momento dell’invio: se il turno attivo è stato terminato/saltato o la persona non è più la prossima, non invia l’avviso. Se il servizio push segnala una sottoscrizione scaduta, questa viene rimossa automaticamente.

## Limiti da conoscere

- L’invio è programmato dal server, ma la consegna effettiva dipende dal servizio push del browser e dalla rete; non si può garantire una puntualità al secondo.
- Turni configurati oltre 130 secondi non ricevono questo avviso differito; riduci la durata nel pannello **Impostazioni**.
- Se l’utente ha negato le notifiche, disattivato le notifiche del sito o attivato modalità di risparmio, il dispositivo può ritardare/non mostrare la push.
- Per mettere offline l’app o eliminare un account, le sottoscrizioni vengono cancellate tramite cascata quando l’account è eliminato; gli utenti disattivati possono riattivarsi dopo aver riabilitato il proprio account.
