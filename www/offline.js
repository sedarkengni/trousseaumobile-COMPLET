/* ============================================================
   Uplinks Apps — coquille locale hors-ligne
   ------------------------------------------------------------
   Ce fichier tourne dans l'app mobile (Capacitor), sur une origine LOCALE
   (pas https://uplinksafrica.com). Son rôle :
     1. S'il y a du réseau : synchroniser les actions en attente, rafraîchir
        le cache local, puis rediriger vers le vrai site (comportement
        identique à avant pour l'usage courant).
     2. S'il n'y en a pas : afficher tout ce qui a déjà été synchronisé
        (tâches — y compris l'historique des tâches terminées —, clients et
        équipements Trousseau, catalogue Facturation, droits) et permettre :
          - de clôturer une tâche (actions, signature, note) ;
          - de CRÉER une nouvelle tâche ;
          - de CRÉER ou MODIFIER un client Trousseau ;
          - de CRÉER ou MODIFIER un équipement Trousseau ;
        chaque action étant mise de côté pour envoi automatique dès le
        retour du réseau.
   Toutes les données restent stockées uniquement sur ce téléphone
   (IndexedDB) jusqu'à leur envoi réussi au serveur.

   Hors périmètre volontairement (voir LISEZ-MOI-OFFLINE-COMPLET.txt) :
   l'envoi d'emails, la création/modification de factures, la création de
   comptes utilisateur, la récurrence de tâches, l'ajout d'équipement à la
   volée pendant la création d'une tâche, et la gestion de plusieurs réseaux
   Wifi par équipement — toutes ces actions restent réservées à la connexion
   internet pour l'instant.
   ============================================================ */

(function(){
  'use strict';

  // window.__OFFLINE_TEST_API_ORIGIN__ permet de rediriger les appels vers un
  // serveur de test lors de la vérification de ce fichier ; jamais défini en
  // usage réel (l'app pointe alors vers uplinksafrica.com).
  var API_ORIGIN = window.__OFFLINE_TEST_API_ORIGIN__ || 'https://uplinksafrica.com';
  var LIVE_APP_URL = API_ORIGIN + '/apps/';
  var API_MOBILE_AUTH = API_ORIGIN + '/trousseau/api-mobile.php';
  var API_TASKS = API_ORIGIN + '/task/tasks-api.php';
  // Ces routes existaient déjà pour le site web (authentification par
  // cookie) ; elles acceptent AUSSI le jeton mobile (X-Api-Token) sans aucune
  // modification côté serveur, seuls des en-têtes CORS ont été ajoutés pour
  // que cette coquille (origine différente) puisse les appeler. Chacune
  // applique déjà elle-même les droits du compte (mots de passe masqués si
  // le compte n'a pas le droit de les voir, 403 si l'app ne lui est pas
  // ouverte, etc.) — la mise en cache ne voit donc jamais plus que ce que
  // l'utilisateur verrait normalement en ligne.
  var API_TROUSSEAU_STORE = API_ORIGIN + '/trousseau/api.php?resource=store';
  var API_FACTURATION = API_ORIGIN + '/facturation/catalog-api.php';
  var API_RIGHTS = API_ORIGIN + '/apps/rights-api.php';
  var PING_TIMEOUT_MS = 6000;
  // Onglet actif dans l'écran hors-ligne ('tasks' | 'trousseau' | 'facturation' | 'rights').
  var CURRENT_TAB = 'tasks';

  // Identifiants générés côté appareil, EXACTEMENT comme le fait déjà le
  // site web (trousseau/index.php, fonction uid()) pour ses propres créations
  // de client/équipement : le serveur accepte tel quel l'identifiant fourni
  // par le client (voir trousseau/api.php, resource=store) — il n'y a donc
  // JAMAIS besoin de "faire correspondre" un identifiant provisoire à un
  // identifiant définitif après l'envoi. Une tâche créée hors-ligne qui
  // référence un client/équipement lui-même créé hors-ligne reste donc
  // valide avant ET après la synchronisation, sans aucune correction.
  // Pour les tâches, tasks-api.php a été mis à jour pour accepter de la
  // même façon un identifiant fourni (au lieu d'toujours en générer un),
  // uniquement quand ce champ est présent — voir "op: create" côté serveur.
  function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  /* ---------------- petit magasin IndexedDB ---------------- */

  var DB_NAME = 'trousseau_offline';
  var DB_VERSION = 1;
  var dbPromise = null;

  function openDb(){
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function(resolve, reject){
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(){
        var db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pendingActions')) db.createObjectStore('pendingActions', { keyPath: 'localId', autoIncrement: true });
      };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ reject(req.error); };
    });
    return dbPromise;
  }

  function idbTx(storeName, mode){
    return openDb().then(function(db){ return db.transaction(storeName, mode).objectStore(storeName); });
  }

  function metaGet(key){
    return idbTx('meta', 'readonly').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.get(key);
        r.onsuccess = function(){ resolve(r.result ? r.result.value : null); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function metaSet(key, value){
    return idbTx('meta', 'readwrite').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.put({ key: key, value: value });
        r.onsuccess = function(){ resolve(); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function tasksGetAll(){
    return idbTx('tasks', 'readonly').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.getAll();
        r.onsuccess = function(){ resolve(r.result || []); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function tasksReplaceAll(list){
    return idbTx('tasks', 'readwrite').then(function(store){
      return new Promise(function(resolve, reject){
        var clearReq = store.clear();
        clearReq.onerror = function(){ reject(clearReq.error); };
        clearReq.onsuccess = function(){
          list.forEach(function(t){ store.put(t); });
          resolve();
        };
      });
    });
  }

  function tasksUpsert(task){
    return idbTx('tasks', 'readwrite').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.put(task);
        r.onsuccess = function(){ resolve(); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function pendingAdd(action){
    return idbTx('pendingActions', 'readwrite').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.add(action);
        r.onsuccess = function(){ resolve(r.result); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function pendingGetAll(){
    return idbTx('pendingActions', 'readonly').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.getAll();
        r.onsuccess = function(){ resolve(r.result || []); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function pendingDelete(localId){
    return idbTx('pendingActions', 'readwrite').then(function(store){
      return new Promise(function(resolve, reject){
        var r = store.delete(localId);
        r.onsuccess = function(){ resolve(); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  // Fusionne un client/équipement dans le trousseauStore mis en cache, pour
  // que l'écran hors-ligne reflète IMMÉDIATEMENT une création/modification,
  // sans attendre le prochain retour en ligne. Purement local (n'envoie
  // rien) — voir queueClientChange()/queueEquipmentChange() pour l'envoi.
  function upserted(list, record){
    var out = (list || []).slice();
    var idx = out.findIndex(function(x){ return x.id === record.id; });
    if (idx >= 0) out[idx] = record; else out.push(record);
    return out;
  }

  function trousseauStoreUpsertLocal(kind, record){
    return metaGet('trousseauStore').then(function(store){
      store = store || { clients: [], equipment: [] };
      if (kind === 'client') store.clients = upserted(store.clients, record);
      else store.equipment = upserted(store.equipment, record);
      return metaSet('trousseauStore', store);
    });
  }

  /* ---------------- appels réseau ---------------- */

  function withTimeout(promise, ms){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ reject(new Error('timeout')); }, ms);
      promise.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
    });
  }

  function apiFetch(url, options, token){
    options = options || {};
    var headers = options.headers || {};
    if (token) headers['X-Api-Token'] = token;
    options.headers = headers;
    return withTimeout(fetch(url, options), PING_TIMEOUT_MS);
  }

  // Vérifie qu'il y a vraiment du réseau (navigator.onLine seul ne suffit
  // pas : il peut être vrai même sans accès internet réel, par ex. Wi-Fi
  // sans connexion).
  function reallyOnline(token){
    if (!navigator.onLine) return Promise.resolve(false);
    return apiFetch(API_TASKS + '?since=0&ping=1', { method: 'GET' }, token)
      .then(function(r){ return r.status === 200 || r.status === 401; })
      .catch(function(){ return false; });
  }

  /* ---------------- notifications push (Android) ---------------- */
  // N'a AUCUN effet tant que : (a) l'app ne tourne pas réellement dans la
  // coquille Capacitor (donc jamais dans un navigateur normal), ou (b) le
  // plugin PushNotifications n'a pas encore été inclus dans la build (avant
  // que "npm install" + la synchronisation Capacitor ne l'ajoutent). Ne
  // bloque jamais la connexion/synchronisation même en cas d'échec —
  // l'usage normal de l'app ne dépend jamais des notifications.
  function setupPushNotifications(token){
    try {
      if (!window.Capacitor || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return;
      var Push = Capacitor.Plugins && Capacitor.Plugins.PushNotifications;
      if (!Push) return;

      Push.checkPermissions().then(function(perm){
        if (perm && perm.receive === 'granted') return perm;
        return Push.requestPermissions();
      }).then(function(perm){
        if (!perm || perm.receive !== 'granted') return;
        Push.addListener('registration', function(tokenData){
          if (!tokenData || !tokenData.value) return;
          apiFetch(API_TASKS, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'registerPushToken', token: tokenData.value, platform: 'android' })
          }, token).catch(function(){ /* réessaiera au prochain démarrage/connexion */ });
        });
        Push.addListener('registrationError', function(err){
          console.log('Notifications push : erreur d\'enregistrement', err);
        });
        Push.register();
      }).catch(function(){ /* silencieux : jamais bloquant pour le reste de l'app */ });
    } catch (e) { /* jamais bloquant */ }
  }

  /* ---------------- écrans ---------------- */

  var $ = function(id){ return document.getElementById(id); };
  var bootMsg = $('boot-msg');
  var toastEl = $('toast');
  var toastTimer = null;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.hidden = true; }, 3200);
  }

  function showOnly(id){
    ['boot', 'login', 'offline-app'].forEach(function(s){ $(s).hidden = (s !== id); });
  }

  /* ---------------- connexion ---------------- */

  function doLogin(username, password){
    return fetch(API_MOBILE_AUTH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'apiLogin', username: username, password: password, deviceLabel: guessDeviceLabel() })
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, json: j }; }); });
  }

  function guessDeviceLabel(){
    var ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Téléphone Android';
    return 'Appareil mobile';
  }

  /* ---------------- synchronisation ---------------- */

  // File d'actions en attente : chaque entrée a un "type" —
  //   'task'      : { type:'task', taskId, payload }            -> POST task/tasks-api.php
  //   'client'    : { type:'client', record }                   -> fusionné dans trousseau/api.php?resource=store
  //   'equipment' : { type:'equipment', record }                -> idem
  // Traitées dans l'ORDRE où elles ont été créées (important : une tâche
  // créée hors-ligne juste après un nouveau client référence ce client par
  // son identifiant, déjà valide immédiatement — voir uid() plus haut —,
  // donc l'ordre d'envoi n'a en réalité pas d'incidence sur la validité,
  // mais le respecter reste plus proche de ce que l'utilisateur a vécu).
  //
  // Pour client/équipement : le "store" Trousseau se synchronise par
  // ENVOI DE LA LISTE COMPLÈTE avec un numéro de version (contrôle de
  // concurrence optimiste, voir trousseau/api.php) — pas d'opération unitaire
  // "créer ce client". On récupère donc UNE fois la liste + version au
  // début de l'envoi ("working"), on y fusionne chaque fiche en attente une
  // par une (chacune dans son propre envoi, pour isoler les échecs), et on
  // avance la version au fur et à mesure des succès. En cas de conflit
  // (409 — quelqu'un d'autre a modifié entre-temps), on relit une fois la
  // version fraîche et on réessaie cette fiche-là avant d'abandonner pour ce
  // passage (elle reste alors en attente, sans rien perdre).
  function flushPendingActions(token){
    return pendingGetAll().then(function(actions){
      if (!actions.length) return { sent: 0, failed: 0, authExpired: false };
      var sent = 0, failed = 0, authExpired = false;
      var working = null; // { version, clients, equipment } — chargé à la demande

      function fetchTrousseauStore(){
        return apiFetch(API_TROUSSEAU_STORE, { method: 'GET' }, token).then(function(r){
          if (r.status === 401) { var e = new Error('auth_expired'); e.authExpired = true; throw e; }
          if (r.status !== 200) throw new Error('store_fetch_failed');
          return r.json();
        }).then(function(json){
          working = { version: json.version, clients: json.clients || [], equipment: json.equipment || [] };
          return working;
        });
      }

      function ensureWorking(){
        return working ? Promise.resolve(working) : fetchTrousseauStore();
      }

      function sendTrousseauRecord(type, record){
        return ensureWorking().then(function(w){
          var attemptClients = (type === 'client') ? upserted(w.clients, record) : w.clients;
          var attemptEquipment = (type === 'equipment') ? upserted(w.equipment, record) : w.equipment;
          return apiFetch(API_TROUSSEAU_STORE, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: w.version, clients: attemptClients, equipment: attemptEquipment })
          }, token).then(function(r){
            if (r.status === 200) {
              return r.json().then(function(j){
                working = { version: j.version, clients: attemptClients, equipment: attemptEquipment };
                return { ok: true };
              });
            }
            if (r.status === 401) { var e = new Error('auth_expired'); e.authExpired = true; throw e; }
            if (r.status === 409) {
              // Conflit de version : on relit le store frais et on retente CETTE fiche une seule fois.
              working = null;
              return fetchTrousseauStore().then(function(w2){
                var c2 = (type === 'client') ? upserted(w2.clients, record) : w2.clients;
                var e2 = (type === 'equipment') ? upserted(w2.equipment, record) : w2.equipment;
                return apiFetch(API_TROUSSEAU_STORE, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ version: w2.version, clients: c2, equipment: e2 })
                }, token).then(function(r2){
                  if (r2.status === 200) {
                    return r2.json().then(function(j2){
                      working = { version: j2.version, clients: c2, equipment: e2 };
                      return { ok: true };
                    });
                  }
                  if (r2.status === 401) { var e3 = new Error('auth_expired'); e3.authExpired = true; throw e3; }
                  return { ok: false };
                });
              });
            }
            // 400 (validation) / 403 (droits) : cette fiche reste en attente,
            // on n'avance pas "working" (qui reste valide pour les suivantes).
            return { ok: false };
          });
        });
      }

      var chain = Promise.resolve();
      actions.forEach(function(action){
        chain = chain.then(function(){
          if (authExpired) return;
          var type = action.type || 'task';
          if (type === 'task') {
            return apiFetch(API_TASKS, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(action.payload)
            }, token).then(function(r){
              if (r.status === 200) { sent++; return pendingDelete(action.localId); }
              if (r.status === 401) { authExpired = true; return; }
              // Erreur définitive du serveur (ex. tâche déjà modifiée
              // entre-temps, données rejetées) : on retire de la file pour ne
              // pas bloquer les suivantes indéfiniment, mais on prévient.
              failed++;
              return pendingDelete(action.localId);
            }).catch(function(err){
              if (err && err.authExpired) { authExpired = true; return; }
              // Pas de réseau / échec réseau : on la laisse en file, on
              // réessaiera à la prochaine synchronisation.
              failed++;
            });
          }
          // client / equipment
          return sendTrousseauRecord(type, action.record).then(function(res){
            if (res.ok) { sent++; return pendingDelete(action.localId); }
            failed++; // laissée en file : ni perdue, ni bloquante pour la suite
          }).catch(function(err){
            if (err && err.authExpired) { authExpired = true; return; }
            failed++;
          });
        });
      });

      return chain.then(function(){
        var afterSync = Promise.resolve();
        if (working) {
          // Reflète immédiatement dans le cache le nouvel état confirmé par
          // le serveur (plutôt que d'attendre le prochain refreshCache()).
          afterSync = metaSet('trousseauStore', { version: working.version, clients: working.clients, equipment: working.equipment });
        }
        return afterSync.then(function(){ return { sent: sent, failed: failed, authExpired: authExpired }; });
      });
    });
  }

  function refreshCache(token){
    return metaGet('lastSync').then(function(lastSync){
      var since = lastSync || 0;
      return apiFetch(API_TASKS + '?since=' + encodeURIComponent(since), { method: 'GET' }, token);
    }).then(function(r){
      if (r.status === 401) { var e = new Error('auth_expired'); e.authExpired = true; throw e; }
      if (r.status !== 200) throw new Error('refresh_failed');
      return r.json();
    }).then(function(json){
      var byId = {};
      return tasksGetAll().then(function(existing){
        existing.forEach(function(t){ byId[t.id] = t; });
        (json.tasks || []).forEach(function(t){ byId[t.id] = t; });
        var merged = Object.keys(byId).map(function(k){ return byId[k]; });
        return tasksReplaceAll(merged).then(function(){
          return metaSet('clients', json.clients || []);
        }).then(function(){
          return metaSet('roster', json.roster || []);
        }).then(function(){
          return metaSet('lastSync', json.serverTime || Date.now());
        });
      });
    }).then(function(){
      // Trousseau, Facturation et Droits : mis en cache "au mieux" — si l'une
      // de ces trois routes échoue (pas d'accès à cette app pour ce compte,
      // ou app pas installée), on n'annule pas toute la synchronisation pour
      // autant : on vide juste le cache de cette section (elle n'apparaîtra
      // pas dans les onglets hors-ligne). Seul l'échec des TÂCHES (ci-dessus)
      // fait échouer la synchronisation dans son ensemble.
      return Promise.all([
        apiFetch(API_TROUSSEAU_STORE, { method: 'GET' }, token)
          .then(function(r){ return r.status === 200 ? r.json() : null; })
          .catch(function(){ return null; })
          .then(function(json){ return metaSet('trousseauStore', json); }),
        apiFetch(API_FACTURATION, { method: 'GET' }, token)
          .then(function(r){ return r.status === 200 ? r.json() : null; })
          .catch(function(){ return null; })
          .then(function(json){ return metaSet('facturationCatalog', json); }),
        apiFetch(API_RIGHTS, { method: 'GET' }, token)
          .then(function(r){ return r.status === 200 ? r.json() : null; })
          .catch(function(){ return null; })
          .then(function(json){ return metaSet('rightsData', json); }),
      ]);
    });
  }

  // En cas de jeton révoqué/expiré : on l'efface et on renvoie à l'écran de
  // connexion (les actions en attente, elles, restent intactes en local).
  function forceReLogin(message){
    return metaSet('apiToken', null).then(function(){
      showOnly('login');
      if (message) {
        var errEl = $('login-error');
        errEl.textContent = message;
        errEl.hidden = false;
      }
    });
  }

  function syncThenGoLive(token){
    bootMsg.textContent = 'Synchronisation…';
    return flushPendingActions(token).then(function(result){
      if (result.authExpired) { var e = new Error('auth_expired'); e.authExpired = true; throw e; }
      if (result.sent > 0) toast(result.sent + ' élément(s) envoyé(s) au serveur.');
      if (result.failed > 0) toast(result.failed + ' élément(s) n\'ont pas pu être envoyés — ils restent en attente.');
      return refreshCache(token);
    }).then(function(){
      window.location.href = LIVE_APP_URL;
    }).catch(function(err){
      if (err && err.authExpired) {
        return forceReLogin('Votre session a expiré. Reconnectez-vous — vos données en attente d\'envoi seront envoyées automatiquement après.');
      }
      // La synchro a échoué en cours de route (réseau redevenu instable) :
      // on bascule sur le mode hors-ligne plutôt que de rester bloqué.
      renderOfflineApp();
    });
  }

  /* ---------------- écran hors-ligne : liste des tâches ---------------- */

  var CURRENT_TASKS = [];
  var CURRENT_TOKEN = null;
  var SHOW_DONE = false;

  function escHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // ---------------- écran hors-ligne : onglets (Tâches / Trousseau / Facturation / Droits) ----------------
  // Tâches est désormais consultable ET modifiable hors-ligne (créer,
  // clôturer une tâche) ainsi que Trousseau (créer/modifier client et
  // équipement) — voir queueTaskCreate()/queueClientChange()/
  // queueEquipmentChange(). Facturation et Droits restent en lecture seule
  // hors-ligne pour l'instant (voir LISEZ-MOI-OFFLINE-COMPLET.txt).

  function renderOfflineApp(){
    showOnly('offline-app');
    Promise.all([metaGet('trousseauStore'), metaGet('facturationCatalog'), metaGet('rightsData')]).then(function(res){
      var hasTrousseau = !!(res[0] && (res[0].clients || res[0].equipment));
      var hasFacturation = !!(res[1] && res[1].items);
      var hasRights = !!(res[2] && res[2].users);
      $('tab-btn-trousseau').hidden = !hasTrousseau;
      $('tab-btn-facturation').hidden = !hasFacturation;
      $('tab-btn-rights').hidden = !hasRights;
      if (CURRENT_TAB === 'trousseau' && !hasTrousseau) CURRENT_TAB = 'tasks';
      if (CURRENT_TAB === 'facturation' && !hasFacturation) CURRENT_TAB = 'tasks';
      if (CURRENT_TAB === 'rights' && !hasRights) CURRENT_TAB = 'tasks';
      renderCurrentTab();
    });
  }

  document.querySelectorAll('#offline-tabs .tabbtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      CURRENT_TAB = btn.getAttribute('data-tab');
      renderCurrentTab();
    });
  });

  function renderCurrentTab(){
    document.querySelectorAll('#offline-tabs .tabbtn').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-tab') === CURRENT_TAB);
    });
    ['tasks', 'trousseau', 'facturation', 'rights'].forEach(function(tab){
      $('tab-' + tab).hidden = (tab !== CURRENT_TAB);
    });
    if (CURRENT_TAB === 'tasks') renderOfflineTasksTab();
    else if (CURRENT_TAB === 'trousseau') renderOfflineTrousseauTab();
    else if (CURRENT_TAB === 'facturation') renderOfflineFacturationTab();
    else if (CURRENT_TAB === 'rights') renderOfflineRightsTab();
  }

  function taskClientLabel(t, clientsById){
    var c = clientsById[t.clientId];
    return c ? c.name : '';
  }

  function renderOfflineTasksTab(){
    Promise.all([tasksGetAll(), pendingGetAll(), metaGet('clients')]).then(function(res){
      var all = res[0];
      var pending = res[1];
      var clientsById = {};
      (res[2] || []).forEach(function(c){ clientsById[c.id] = c; });

      var active = all.filter(function(t){ return t.status !== 'fait'; })
        .sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
      var done = SHOW_DONE
        ? all.filter(function(t){ return t.status === 'fait'; })
             .sort(function(a, b){ return (b.completedAt || 0) - (a.completedAt || 0); })
        : [];
      CURRENT_TASKS = active.concat(done);

      var pendingByTaskId = {};
      pending.forEach(function(p){ if (p.type === 'task' && p.taskId) pendingByTaskId[p.taskId] = true; });
      $('pending-indicator').textContent = pending.length
        ? pending.length + ' en attente d\'envoi'
        : 'Tout est à jour';

      var list = $('offline-list');
      list.innerHTML = '';
      $('offline-empty').hidden = active.length > 0 || done.length > 0;

      function buildCard(t, isDone){
        var card = document.createElement('div');
        card.className = 'task-card' + (isDone ? ' is-done' : '');
        var isQueued = !!pendingByTaskId[t.id];
        var clientName = taskClientLabel(t, clientsById);
        card.innerHTML =
          '<div class="t-title"></div>' +
          '<div class="t-meta"></div>' +
          (isDone ? '<span class="pill pill-done">Terminée</span>' : '') +
          (isQueued && !isDone ? '<span class="pill pill-pending">En attente d\'envoi</span>' : '') +
          (isQueued && isDone ? '<span class="pill pill-pending">Clôture en attente d\'envoi</span>' : '') +
          (!isDone ? '<div class="t-actions"><button type="button" class="btn primary" data-complete="' + t.id + '">Clôturer</button></div>' : '');
        card.querySelector('.t-title').textContent = (t.displayId ? t.displayId + ' — ' : '') + (t.title || '(sans titre)');
        card.querySelector('.t-meta').textContent = (clientName ? clientName + ' · ' : '') + 'Échéance : ' + (t.dueDate || '—');
        if (isQueued && !isDone) {
          var btn = card.querySelector('[data-complete]');
          if (btn) btn.disabled = true;
        }
        return card;
      }

      active.forEach(function(t){ list.appendChild(buildCard(t, false)); });
      if (SHOW_DONE && done.length) {
        var sep = document.createElement('div');
        sep.className = 'done-sep';
        sep.textContent = 'Historique (terminées)';
        list.appendChild(sep);
        done.forEach(function(t){ list.appendChild(buildCard(t, true)); });
      }

      list.querySelectorAll('[data-complete]').forEach(function(btn){
        btn.addEventListener('click', function(){ openCompleteDialog(btn.getAttribute('data-complete')); });
      });
    });
  }

  $('chk-show-done').addEventListener('change', function(){
    SHOW_DONE = $('chk-show-done').checked;
    renderOfflineTasksTab();
  });

  /* ---------------- écran hors-ligne : Trousseau (lecture + écriture) ---------------- */

  function renderOfflineTrousseauTab(){
    var pane = $('tab-trousseau');
    metaGet('trousseauStore').then(function(store){
      store = store || { clients: [], equipment: [] };
      var clients = store.clients || [];
      var equipment = store.equipment || [];
      var equipByClient = {};
      equipment.forEach(function(e){
        var cid = e.clientId || '';
        (equipByClient[cid] = equipByClient[cid] || []).push(e);
      });

      var html = '<div class="trousseau-toolbar"><button type="button" class="btn sm" id="btn-new-client">+ Nouveau client</button></div>';
      if (!clients.length) {
        html += '<p class="hint">Aucun client en cache pour l\'instant.</p>';
      } else {
        html += '<p class="hint">Les créations/modifications faites ici seront envoyées dès le retour du réseau.</p>';
        clients.slice().sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); }).forEach(function(c){
          var eqs = equipByClient[c.id] || [];
          html += '<details class="offline-client"><summary>' + escHtml(c.name || 'Client') +
            (c.code ? ' <span class="hint-inline">(' + escHtml(c.code) + ')</span>' : '') +
            ' <span class="hint-inline">— ' + eqs.length + ' équipement' + (eqs.length > 1 ? 's' : '') + '</span>' +
            '<button type="button" class="sum-edit" data-edit-client="' + escHtml(c.id) + '">Modifier</button>' +
            '</summary>';
          html += '<div class="offline-client-body">';
          if (c.phone || c.email || c.address) {
            html += '<div class="offline-kv">' +
              (c.phone ? ('<div>Tél : ' + escHtml(c.phone) + '</div>') : '') +
              (c.email ? ('<div>Email : ' + escHtml(c.email) + '</div>') : '') +
              (c.address ? ('<div>Adresse : ' + escHtml(c.address) + '</div>') : '') +
              '</div>';
          }
          if (!eqs.length) { html += '<p class="hint">Aucun équipement enregistré.</p>'; }
          eqs.forEach(function(e){
            html += '<div class="offline-equip-card">';
            html += '<div class="card-head-row"><div class="t-title">' + escHtml(e.name || 'Équipement') + '</div>' +
              '<button type="button" class="card-editbtn" data-edit-equipment="' + escHtml(e.id) + '">Modifier</button></div>';
            html += '<div class="t-meta">S/N ' + escHtml(e.serial || '—') + (e.tag ? (' · ' + escHtml(e.tag)) : '') + '</div>';
            if (e.accessUser || e.accessPassSet) {
              html += '<div class="offline-kv">' +
                (e.accessUser ? ('<div>Identifiant : ' + escHtml(e.accessUser) + '</div>') : '') +
                '<div>Mot de passe : ' + (e.accessPass ? ('<code>' + escHtml(e.accessPass) + '</code>') : (e.accessPassSet ? '(enregistré — droit de le voir requis)' : '—')) + '</div>' +
                '</div>';
            }
            (e.wifiNetworks || []).forEach(function(w){
              html += '<div class="offline-kv"><div>Wifi ' + escHtml(w.ssid || '') + (w.band ? (' (' + escHtml(w.band) + ')') : '') + ' : ' +
                (w.pass ? ('<code>' + escHtml(w.pass) + '</code>') : (w.passSet ? '(enregistré — droit de le voir requis)' : '—')) + '</div></div>';
            });
            if (e.comment) { html += '<div class="hint">' + escHtml(e.comment).replace(/\n/g, '<br>') + '</div>'; }
            html += '<div class="t-actions"><button type="button" class="btn sm ghost" data-new-equipment="' + escHtml(c.id) + '">+ Équipement pour ce client</button></div>';
            html += '</div>';
          });
          if (!eqs.length) {
            html += '<div class="t-actions"><button type="button" class="btn sm ghost" data-new-equipment="' + escHtml(c.id) + '">+ Équipement pour ce client</button></div>';
          }
          html += '</div></details>';
        });
      }
      pane.innerHTML = html;

      var newClientBtn = $('btn-new-client');
      if (newClientBtn) newClientBtn.addEventListener('click', function(){ openClientDialog(null); });
      pane.querySelectorAll('[data-edit-client]').forEach(function(btn){
        btn.addEventListener('click', function(ev){
          ev.preventDefault();
          openClientDialog(btn.getAttribute('data-edit-client'));
        });
      });
      pane.querySelectorAll('[data-edit-equipment]').forEach(function(btn){
        btn.addEventListener('click', function(ev){
          ev.preventDefault();
          openEquipmentDialog(btn.getAttribute('data-edit-equipment'), null);
        });
      });
      pane.querySelectorAll('[data-new-equipment]').forEach(function(btn){
        btn.addEventListener('click', function(ev){
          ev.preventDefault();
          openEquipmentDialog(null, btn.getAttribute('data-new-equipment'));
        });
      });
    });
  }

  function renderOfflineFacturationTab(){
    var pane = $('tab-facturation');
    metaGet('facturationCatalog').then(function(cat){
      var items = (cat && cat.items) || [];
      if (!items.length) {
        pane.innerHTML = '<p class="hint">Aucun article/service en cache pour l\'instant.</p>';
        return;
      }
      var html = '<p class="hint">Lecture seule hors-ligne — les modifications nécessitent une connexion.</p>';
      items.slice().sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); }).forEach(function(it){
        html += '<div class="offline-equip-card">' +
          '<div class="t-title">' + escHtml(it.name || '(sans nom)') + '</div>' +
          '<div class="t-meta">' + (it.type === 'service' ? 'Service' : 'Article') +
          (it.unitPrice != null && it.unitPrice !== '' ? (' · ' + escHtml(it.unitPrice) + ' ' + escHtml(it.currency || '')) : '') + '</div>' +
          (it.description ? ('<div class="hint">' + escHtml(it.description) + '</div>') : '') +
          '</div>';
      });
      pane.innerHTML = html;
    });
  }

  function renderOfflineRightsTab(){
    var pane = $('tab-rights');
    metaGet('rightsData').then(function(data){
      var users = (data && data.users) || [];
      if (!users.length) {
        pane.innerHTML = '<p class="hint">Aucune donnée de droits en cache pour l\'instant.</p>';
        return;
      }
      function flags(obj, map){
        var out = [];
        map.forEach(function(pair){ if (obj && obj[pair[0]]) out.push(pair[1]); });
        return out.length ? out.join(', ') : '—';
      }
      var TR_MAP = [['canWrite','Écriture'], ['canDelete','Suppression'], ['canViewPasswords','Voir mots de passe'], ['canManageUsers','Gestion des comptes']];
      var APP_MAP = [['access','Accès'], ['edit','Modification'], ['delete','Suppression'], ['admin','Administrateur']];
      var html = '<p class="hint">Lecture seule hors-ligne — les modifications nécessitent une connexion.</p>';
      users.slice().sort(function(a, b){ return (a.username || '').localeCompare(b.username || ''); }).forEach(function(u){
        html += '<div class="offline-equip-card">';
        html += '<div class="t-title">' + escHtml(u.username || '') + (u.isSuperAdmin ? ' <span class="pill pill-pending">Super admin</span>' : '') + '</div>';
        if (!u.isSuperAdmin) {
          html += '<div class="offline-kv">' +
            '<div>Trousseau : ' + escHtml(flags(u.trousseau, TR_MAP)) + '</div>' +
            (u.task ? ('<div>Tâches : ' + escHtml(flags(u.task, APP_MAP)) + '</div>') : '') +
            (u.facturation ? ('<div>Facturation : ' + escHtml(flags(u.facturation, APP_MAP)) + '</div>') : '') +
            '</div>';
        } else {
          html += '<div class="hint">Accès complet à toutes les applications.</div>';
        }
        html += '</div>';
      });
      pane.innerHTML = html;
    });
  }

  /* ---------------- tirer pour actualiser (toutes les sections) ---------------- */

  (function setupPullToRefresh(){
    var scrollEl = $('offline-scroll');
    var indicator = $('pull-indicator');
    var startY = null, pulling = false, triggered = false;
    var THRESHOLD = 70;

    function onStart(ev){
      if (scrollEl.scrollTop > 0) { startY = null; return; }
      startY = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      pulling = true; triggered = false;
    }
    function onMove(ev){
      if (!pulling || startY === null) return;
      var y = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      var delta = y - startY;
      if (delta <= 0) { indicator.hidden = true; return; }
      if (scrollEl.scrollTop > 0) return;
      ev.preventDefault();
      indicator.hidden = false;
      triggered = delta > THRESHOLD;
      indicator.textContent = triggered ? 'Relâchez pour actualiser…' : 'Tirez vers le bas pour actualiser…';
    }
    function onEnd(){
      if (pulling && triggered) {
        indicator.textContent = 'Actualisation…';
        doPullRefresh().then(function(){ indicator.hidden = true; });
      } else {
        indicator.hidden = true;
      }
      pulling = false; startY = null; triggered = false;
    }
    scrollEl.addEventListener('touchstart', onStart, { passive: true });
    scrollEl.addEventListener('touchmove', onMove, { passive: false });
    scrollEl.addEventListener('touchend', onEnd);
    // Souris aussi (pratique pour tester sur ordinateur) :
    scrollEl.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', function(ev){ if (pulling) onMove(ev); });
    document.addEventListener('mouseup', function(){ if (pulling) onEnd(); });
  })();

  function doPullRefresh(){
    return metaGet('apiToken').then(function(token){
      if (!token) { renderOfflineApp(); return; }
      return reallyOnline(token).then(function(online){
        if (!online) {
          toast('Toujours hors-ligne — affichage des dernières données enregistrées.');
          renderOfflineApp();
          return;
        }
        // De retour en ligne : on synchronise (envoie ce qui est en
        // attente, rafraîchit tout le cache) puis on part sur le vrai site,
        // exactement comme au démarrage — le "tirer pour actualiser"
        // hors-ligne sert justement à redonner une chance de repasser en
        // ligne à tout moment.
        return syncThenGoLive(token);
      });
    });
  }

  /* ---------------- clôture d'une tâche (hors-ligne) ---------------- */

  var completeDialog = $('complete-dialog');
  var sigCanvas = $('c-signature');
  var sigCtx = sigCanvas.getContext('2d');
  var sigDrawing = false;
  var sigHasStroke = false;
  var ratingValue = 0;
  var completingTaskId = null;

  function sigClear(canvas, ctx){
    canvas = canvas || sigCanvas; ctx = ctx || sigCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Fond blanc opaque (et pas transparent) : même règle que la fenêtre de
    // clôture du site web et que le lien de validation client — un fond
    // transparent produit un PNG dont le générateur de PDF (jsPDF) peut mal
    // gérer la transparence (rectangle noir ou signature invisible dans le
    // PDF exporté ensuite depuis le site).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (canvas === sigCanvas) sigHasStroke = false;
  }
  function sigPointFromEvent(canvas, ev){
    var rect = canvas.getBoundingClientRect();
    var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    var y = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return { x: x * (canvas.width / rect.width), y: y * (canvas.height / rect.height) };
  }
  function sigStart(ev){
    ev.preventDefault();
    sigDrawing = true;
    var p = sigPointFromEvent(sigCanvas, ev);
    sigCtx.beginPath();
    sigCtx.moveTo(p.x, p.y);
  }
  function sigMove(ev){
    if (!sigDrawing) return;
    ev.preventDefault();
    var p = sigPointFromEvent(sigCanvas, ev);
    sigCtx.lineWidth = 2; sigCtx.lineCap = 'round'; sigCtx.strokeStyle = '#1A2230';
    sigCtx.lineTo(p.x, p.y);
    sigCtx.stroke();
    sigHasStroke = true;
  }
  function sigEnd(){ sigDrawing = false; }
  ['mousedown', 'touchstart'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigStart, { passive: false }); });
  ['mousemove', 'touchmove'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigMove, { passive: false }); });
  ['mouseup', 'mouseleave', 'touchend'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigEnd); });
  $('c-sig-clear').addEventListener('click', function(){ sigClear(); });

  function renderStars(){
    document.querySelectorAll('#c-rating .starbtn').forEach(function(b){
      var v = parseInt(b.getAttribute('data-star'), 10);
      b.classList.toggle('filled', v <= ratingValue);
    });
    // Note < 3 étoiles : le motif d'insatisfaction devient obligatoire (même
    // règle que sur le lien de validation envoyé au client, et que dans la
    // fenêtre de clôture normale du site web).
    var isLow = ratingValue > 0 && ratingValue < 3;
    $('c-lowrating-wrap').hidden = !isLow;
    $('c-lowrating-reason').required = isLow;
  }
  document.querySelectorAll('#c-rating .starbtn').forEach(function(b){
    b.addEventListener('click', function(){
      var v = parseInt(b.getAttribute('data-star'), 10);
      ratingValue = (ratingValue === v) ? 0 : v;
      renderStars();
    });
  });
  $('c-rating-clear').addEventListener('click', function(){ ratingValue = 0; renderStars(); });

  function openCompleteDialog(taskId){
    var t = CURRENT_TASKS.find(function(x){ return x.id === taskId; });
    if (!t) return;
    completingTaskId = taskId;
    $('complete-title').textContent = 'Clôturer — ' + (t.title || '');
    $('c-actions').value = '';
    $('c-client').value = '';
    ratingValue = parseInt(t.completionRating, 10) || 0;
    $('c-lowrating-reason').value = t.completionLowRatingReason || '';
    renderStars();
    sigClear();
    $('complete-error').hidden = true;
    completeDialog.showModal();
  }
  $('c-cancel').addEventListener('click', function(){ completeDialog.close(); });

  $('complete-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var actions = $('c-actions').value.trim();
    var clientName = $('c-client').value.trim();
    var errEl = $('complete-error');
    if (!actions || !clientName) {
      errEl.textContent = 'Merci de renseigner les actions menées et le nom du client.';
      errEl.hidden = false;
      return;
    }
    if (!sigHasStroke) {
      errEl.textContent = 'La signature du client est obligatoire.';
      errEl.hidden = false;
      return;
    }
    var lowRatingReason = $('c-lowrating-reason').value.trim();
    if (ratingValue > 0 && ratingValue < 3 && !lowRatingReason) {
      errEl.textContent = 'La note est inférieure à 3 étoiles : merci de préciser pourquoi (obligatoire).';
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;

    var payload = {
      op: 'update', id: completingTaskId, status: 'fait',
      completionActions: actions, completionClientName: clientName,
      completionRating: ratingValue > 0 ? ratingValue : null,
      completionLowRatingReason: (ratingValue > 0 && ratingValue < 3) ? lowRatingReason : '',
      signatureDataUrl: sigCanvas.toDataURL('image/png'),
    };

    pendingAdd({ type: 'task', taskId: completingTaskId, payload: payload, createdAt: Date.now() }).then(function(){
      // Mise à jour optimiste du cache local : la tâche disparaît de la
      // liste "à faire" immédiatement, sans attendre l'envoi réel.
      return tasksGetAll();
    }).then(function(all){
      var t = all.find(function(x){ return x.id === completingTaskId; });
      if (t) {
        t.status = 'fait';
        t.completedAt = t.completedAt || Date.now();
        t.completionActions = actions;
        t.completionClientName = clientName;
        t.completionRating = payload.completionRating;
        t.completionLowRatingReason = payload.completionLowRatingReason;
        return tasksUpsert(t);
      }
    }).then(function(){
      completeDialog.close();
      toast('Enregistré — sera envoyé automatiquement dès le retour du réseau.');
      renderOfflineApp();
      maybeAutoSync();
    });
  });

  /* ---------------- nouvelle tâche (hors-ligne) ---------------- */

  var taskCreateDialog = $('task-create-dialog');
  var TC_CLIENTS = [];   // dernier instantané chargé pour le formulaire
  var TC_EQUIPMENT = [];
  var TC_ROSTER = [];

  function loadClientListForForms(){
    // Préfère le Trousseau complet (a "code") s'il est en cache, sinon
    // retombe sur la liste plus simple déjà partagée par task/tasks-api.php
    // (disponible même pour un compte sans accès à l'app Trousseau).
    return Promise.all([metaGet('trousseauStore'), metaGet('clients')]).then(function(res){
      var fromTrousseau = res[0] && res[0].clients;
      TC_CLIENTS = (fromTrousseau && fromTrousseau.length) ? fromTrousseau : (res[1] || []);
      TC_EQUIPMENT = (res[0] && res[0].equipment) || [];
      return TC_CLIENTS;
    });
  }

  function fillClientSelect(selectEl, selectedId){
    selectEl.innerHTML = '';
    if (!TC_CLIENTS.length) {
      var opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '(aucun client en cache)';
      selectEl.appendChild(opt0);
      return;
    }
    TC_CLIENTS.slice().sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); }).forEach(function(c){
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name + (c.code ? ' (' + c.code + ')' : '');
      selectEl.appendChild(opt);
    });
    if (selectedId) selectEl.value = selectedId;
  }

  function fillAssignedList(){
    var wrap = $('tc-assigned-list');
    wrap.innerHTML = '';
    if (!TC_ROSTER.length) {
      wrap.innerHTML = '<div class="chklist-empty">Aucun technicien en cache.</div>';
      return;
    }
    TC_ROSTER.forEach(function(u){
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = u.id; cb.name = 'tc-assigned';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(u.username));
      wrap.appendChild(label);
    });
  }

  function fillEquipmentList(clientId){
    var wrap = $('tc-equipment-list');
    var hint = $('tc-equipment-hint');
    wrap.innerHTML = '';
    var eqs = TC_EQUIPMENT.filter(function(e){ return e.clientId === clientId; });
    if (!eqs.length) {
      hint.hidden = false;
      wrap.innerHTML = '<div class="chklist-empty">Aucun équipement en cache pour ce client.</div>';
      return;
    }
    hint.hidden = true;
    eqs.forEach(function(e){
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = e.id; cb.name = 'tc-equip';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(e.name + (e.serial ? ' (' + e.serial + ')' : '')));
      wrap.appendChild(label);
    });
  }

  function openTaskCreateDialog(){
    Promise.all([loadClientListForForms(), metaGet('roster')]).then(function(res){
      TC_ROSTER = res[1] || [];
      $('tc-title').value = '';
      $('tc-description').value = '';
      $('tc-tag').value = 'normal';
      $('tc-taglabel-wrap').hidden = true;
      $('tc-taglabel').value = '';
      $('tc-taskdate').value = '';
      $('tc-duedate').value = '';
      $('tc-is-service').checked = false;
      $('tc-equipment-wrap').hidden = false;
      fillClientSelect($('tc-client'), TC_CLIENTS[0] ? TC_CLIENTS[0].id : '');
      fillAssignedList();
      fillEquipmentList($('tc-client').value);
      $('task-create-error').hidden = true;
      taskCreateDialog.showModal();
    });
  }

  $('btn-new-task').addEventListener('click', openTaskCreateDialog);
  $('tc-cancel').addEventListener('click', function(){ taskCreateDialog.close(); });
  $('tc-client').addEventListener('change', function(){ fillEquipmentList($('tc-client').value); });
  $('tc-is-service').addEventListener('change', function(){ $('tc-equipment-wrap').hidden = $('tc-is-service').checked; });
  $('tc-tag').addEventListener('change', function(){ $('tc-taglabel-wrap').hidden = ($('tc-tag').value !== 'autre'); });

  $('tc-new-client').addEventListener('click', function(){
    taskCreateDialog.close();
    openClientDialog(null, { reopenTaskDialog: true });
  });

  $('task-create-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var errEl = $('task-create-error');
    var title = $('tc-title').value.trim();
    var clientId = $('tc-client').value;
    if (!title) { errEl.textContent = 'L\'intitulé est obligatoire.'; errEl.hidden = false; return; }
    if (!clientId) { errEl.textContent = 'Choisissez un client (créez-le d\'abord s\'il n\'existe pas encore).'; errEl.hidden = false; return; }
    errEl.hidden = true;

    var isService = $('tc-is-service').checked;
    var equipmentIds = isService ? [] : Array.prototype.slice.call(document.querySelectorAll('input[name=tc-equip]:checked')).map(function(cb){ return cb.value; });
    var assignedTo = Array.prototype.slice.call(document.querySelectorAll('input[name=tc-assigned]:checked')).map(function(cb){ return cb.value; });
    var tag = $('tc-tag').value;

    var taskId = uid('task_local');
    var client = TC_CLIENTS.find(function(c){ return c.id === clientId; });
    var now = Date.now();
    var task = {
      id: taskId,
      displayId: (client && client.code ? client.code : '???') + ' (en attente)',
      clientId: clientId,
      contactName: '',
      isService: isService,
      equipmentIds: equipmentIds,
      adhocEquipment: [],
      title: title,
      description: $('tc-description').value.trim(),
      tag: tag,
      tagLabel: tag === 'autre' ? $('tc-taglabel').value.trim() : '',
      taskDate: $('tc-taskdate').value,
      dueDate: $('tc-duedate').value,
      startTime: '', endTime: '',
      assignedTo: assignedTo,
      status: 'a_faire', statusReason: '',
      completedAt: null, completionRating: null,
      recurrenceGroupId: '', recurrence: null, seriesGrouped: false,
      createdAt: now, updatedAt: now,
    };

    var payload = {
      op: 'create', id: taskId, clientId: clientId, title: title,
      description: task.description, tag: tag, tagLabel: task.tagLabel,
      isService: isService, equipmentIds: equipmentIds,
      taskDate: task.taskDate, dueDate: task.dueDate,
      assignedTo: assignedTo,
    };

    pendingAdd({ type: 'task', taskId: taskId, payload: payload, createdAt: now })
      .then(function(){ return tasksUpsert(task); })
      .then(function(){
        taskCreateDialog.close();
        toast('Tâche créée — sera envoyée dès le retour du réseau.');
        renderOfflineApp();
        maybeAutoSync();
      });
  });

  /* ---------------- nouveau client / modification (hors-ligne) ---------------- */

  var clientDialog = $('client-edit-dialog');
  var editingClientId = null;
  var clientDialogOpts = null;

  function openClientDialog(clientId, opts){
    editingClientId = clientId;
    clientDialogOpts = opts || null;
    metaGet('trousseauStore').then(function(store){
      var c = clientId ? ((store && store.clients) || []).find(function(x){ return x.id === clientId; }) : null;
      $('client-edit-title').textContent = c ? 'Modifier le client' : 'Nouveau client';
      $('ce-name').value = c ? (c.name || '') : '';
      $('ce-phone').value = c ? (c.phone || '') : '';
      $('ce-contact').value = c ? (c.contact || '') : '';
      $('ce-email').value = c ? (c.email || '') : '';
      $('ce-address').value = c ? (c.address || '') : '';
      $('client-edit-error').hidden = true;
      clientDialog.showModal();
    });
  }
  $('ce-cancel').addEventListener('click', function(){ clientDialog.close(); });

  $('client-edit-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var errEl = $('client-edit-error');
    var name = $('ce-name').value.trim();
    var phone = $('ce-phone').value.trim();
    if (!name) { errEl.textContent = 'Le nom est obligatoire.'; errEl.hidden = false; return; }
    if (!phone) { errEl.textContent = 'Le téléphone est obligatoire.'; errEl.hidden = false; return; }
    errEl.hidden = true;

    metaGet('trousseauStore').then(function(store){
      store = store || { clients: [], equipment: [] };
      var base = editingClientId ? (store.clients || []).find(function(x){ return x.id === editingClientId; }) : null;
      var record = Object.assign({}, base || {}, {
        id: (base && base.id) || uid('cli'),
        name: name, phone: phone,
        contact: $('ce-contact').value.trim(),
        email: $('ce-email').value.trim(),
        address: $('ce-address').value.trim(),
        updatedAt: Date.now(),
      });
      if (!base) record.createdAt = Date.now();

      return pendingAdd({ type: 'client', record: record, createdAt: Date.now() })
        .then(function(){ return trousseauStoreUpsertLocal('client', record); })
        .then(function(){ return record; });
    }).then(function(record){
      clientDialog.close();
      toast('Client enregistré — sera envoyé dès le retour du réseau.');
      var reopenTask = clientDialogOpts && clientDialogOpts.reopenTaskDialog;
      clientDialogOpts = null;
      if (CURRENT_TAB === 'trousseau') renderOfflineTrousseauTab();
      if (reopenTask) {
        loadClientListForForms().then(function(){
          fillClientSelect($('tc-client'), record.id);
          fillEquipmentList(record.id);
          taskCreateDialog.showModal();
        });
      }
      maybeAutoSync();
    });
  });

  /* ---------------- nouvel équipement / modification (hors-ligne) ---------------- */

  var equipmentDialog = $('equipment-edit-dialog');
  var editingEquipmentId = null;
  var editingEquipmentClientId = null;

  function openEquipmentDialog(equipmentId, clientIdForNew){
    editingEquipmentId = equipmentId;
    metaGet('trousseauStore').then(function(store){
      store = store || { clients: [], equipment: [] };
      var e = equipmentId ? (store.equipment || []).find(function(x){ return x.id === equipmentId; }) : null;
      editingEquipmentClientId = e ? e.clientId : clientIdForNew;
      $('equipment-edit-title').textContent = e ? 'Modifier l\'équipement' : 'Nouvel équipement';
      $('ee-name').value = e ? (e.name || '') : '';
      $('ee-serial').value = e ? (e.serial || '') : '';
      $('ee-tag').value = e ? (e.tag || '') : '';
      $('ee-ip').value = e ? (e.ip || '') : '';
      $('ee-owner').value = e ? (e.owner || '') : '';
      $('ee-etat').value = e ? (e.etat || '') : '';
      $('ee-access-user').value = e ? (e.accessUser || '') : '';
      // Le mot de passe réel n'est pré-rempli que si le compte a le droit de
      // le voir (sinon la valeur mise en cache est déjà "null" — voir
      // trousseau/api.php) : laisser vide dans ce cas n'efface rien, le
      // serveur ignore ce champ pour un compte sans ce droit.
      $('ee-access-pass').value = e ? (e.accessPass || '') : '';
      var firstWifi = (e && e.wifiNetworks && e.wifiNetworks[0]) || null;
      $('ee-wifi-ssid').value = firstWifi ? (firstWifi.ssid || '') : '';
      $('ee-wifi-pass').value = firstWifi ? (firstWifi.pass || '') : '';
      $('ee-comment').value = e ? (e.comment || '') : '';
      $('equipment-edit-error').hidden = true;
      equipmentDialog.showModal();
    });
  }
  $('ee-cancel').addEventListener('click', function(){ equipmentDialog.close(); });

  $('equipment-edit-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var errEl = $('equipment-edit-error');
    var name = $('ee-name').value.trim();
    var serial = $('ee-serial').value.trim();
    if (!name) { errEl.textContent = 'Le nom est obligatoire.'; errEl.hidden = false; return; }
    if (!serial) { errEl.textContent = 'Le numéro de série est obligatoire.'; errEl.hidden = false; return; }
    errEl.hidden = true;

    metaGet('trousseauStore').then(function(store){
      store = store || { clients: [], equipment: [] };
      var base = editingEquipmentId ? (store.equipment || []).find(function(x){ return x.id === editingEquipmentId; }) : null;
      var rest = ((base && base.wifiNetworks) || []).slice(1);
      var first = ((base && base.wifiNetworks) || [])[0] || {};
      var ssid = $('ee-wifi-ssid').value.trim();
      var nets;
      if (ssid !== '') {
        nets = [{ id: first.id || uid('wifi'), ssid: ssid, pass: $('ee-wifi-pass').value, band: first.band || '' }].concat(rest);
      } else {
        nets = rest; // ssid vidé volontairement : ce réseau est retiré
      }

      var record = Object.assign({}, base || {}, {
        id: (base && base.id) || uid('eq'),
        clientId: (base && base.clientId) || editingEquipmentClientId,
        name: name, serial: serial,
        tag: $('ee-tag').value.trim(),
        ip: $('ee-ip').value.trim(),
        owner: $('ee-owner').value.trim(),
        etat: $('ee-etat').value.trim(),
        accessUser: $('ee-access-user').value.trim(),
        accessPass: $('ee-access-pass').value,
        wifiNetworks: nets,
        comment: $('ee-comment').value.trim(),
        updatedAt: Date.now(),
      });
      if (!base) record.createdAt = Date.now();

      return pendingAdd({ type: 'equipment', record: record, createdAt: Date.now() })
        .then(function(){ return trousseauStoreUpsertLocal('equipment', record); });
    }).then(function(){
      equipmentDialog.close();
      toast('Équipement enregistré — sera envoyé dès le retour du réseau.');
      if (CURRENT_TAB === 'trousseau') renderOfflineTrousseauTab();
      maybeAutoSync();
    });
  });

  /* ---------------- démarrage ---------------- */

  function maybeAutoSync(){
    metaGet('apiToken').then(function(token){
      if (!token) return;
      reallyOnline(token).then(function(online){
        if (online) syncThenGoLive(token);
      });
    });
  }

  function boot(){
    showOnly('boot');
    metaGet('apiToken').then(function(token){
      if (!token) {
        bootMsg.textContent = '';
        showOnly('login');
        return;
      }
      CURRENT_TOKEN = token;
      setupPushNotifications(token);
      reallyOnline(token).then(function(online){
        if (online) {
          syncThenGoLive(token);
        } else {
          renderOfflineApp();
        }
      });
    });
  }

  $('login-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var username = $('login-username').value.trim();
    var password = $('login-password').value;
    var errEl = $('login-error');
    errEl.hidden = true;
    var btn = document.querySelector('#login-form button[type=submit]');
    btn.disabled = true;
    doLogin(username, password).then(function(res){
      btn.disabled = false;
      if (res.status === 200 && res.json && res.json.ok) {
        metaSet('apiToken', res.json.token).then(function(){
          showOnly('boot');
          bootMsg.textContent = 'Connexion réussie…';
          setupPushNotifications(res.json.token);
          syncThenGoLive(res.json.token);
        });
      } else {
        errEl.textContent = (res.json && res.json.message) || 'Connexion impossible. Vérifiez votre réseau.';
        errEl.hidden = false;
      }
    }).catch(function(){
      btn.disabled = false;
      errEl.textContent = 'Connexion au serveur impossible. Réessayez avec une connexion internet active.';
      errEl.hidden = false;
    });
  });

  $('btn-retry-online').addEventListener('click', function(){
    bootMsg.textContent = 'Vérification…';
    showOnly('boot');
    metaGet('apiToken').then(function(token){
      reallyOnline(token).then(function(online){
        if (online) { syncThenGoLive(token); } else { toast('Toujours hors-ligne.'); renderOfflineApp(); }
      });
    });
  });

  window.addEventListener('online', function(){ maybeAutoSync(); });

  boot();
})();
