/* ============================================================
   Uplinks Apps — coquille locale hors-ligne
   ------------------------------------------------------------
   Ce fichier tourne dans l'app mobile (Capacitor), sur une origine LOCALE
   (pas https://uplinksafrica.com). Son rôle :
     1. S'il y a du réseau : synchroniser les actions en attente, rafraîchir
        le cache local, puis rediriger vers le vrai site (comportement
        identique à avant pour l'usage courant).
     2. S'il n'y en a pas : afficher les tâches déjà en cache et permettre
        de clôturer une tâche (actions + signature + note), mis de côté
        pour envoi automatique dès que le réseau revient.
   Toutes les données restent stockées uniquement sur ce téléphone
   (IndexedDB) jusqu'à leur envoi réussi au serveur.
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
  var PING_TIMEOUT_MS = 6000;

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

  function flushPendingActions(token){
    return pendingGetAll().then(function(actions){
      if (!actions.length) return { sent: 0, failed: 0, authExpired: false };
      var sent = 0, failed = 0, authExpired = false;
      var chain = Promise.resolve();
      actions.forEach(function(action){
        chain = chain.then(function(){
          if (authExpired) return; // jeton mort : inutile d'essayer les suivantes
          return apiFetch(API_TASKS, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action.payload)
          }, token).then(function(r){
            if (r.status === 200) {
              sent++;
              return pendingDelete(action.localId);
            }
            if (r.status === 401) {
              // Jeton révoqué/expiré entre-temps : on NE SUPPRIME PAS cette
              // action de la file (le travail du technicien serait perdu) —
              // on arrête tout, l'utilisateur devra se reconnecter, et cette
              // action partira à la prochaine synchronisation réussie.
              authExpired = true;
              return;
            }
            // Erreur définitive du serveur (ex. tâche déjà modifiée
            // entre-temps, données rejetées) : on retire de la file pour ne
            // pas bloquer les suivantes indéfiniment, mais on prévient.
            failed++;
            return pendingDelete(action.localId);
          }).catch(function(){
            // Pas de réseau / échec réseau : on la laisse en file, on
            // réessaiera à la prochaine synchronisation.
            failed++;
          });
        });
      });
      return chain.then(function(){ return { sent: sent, failed: failed, authExpired: authExpired }; });
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
      if (result.sent > 0) toast(result.sent + ' tâche(s) envoyée(s) au serveur.');
      return refreshCache(token);
    }).then(function(){
      window.location.href = LIVE_APP_URL;
    }).catch(function(err){
      if (err && err.authExpired) {
        return forceReLogin('Votre session a expiré. Reconnectez-vous — vos tâches en attente d\'envoi seront envoyées automatiquement après.');
      }
      // La synchro a échoué en cours de route (réseau redevenu instable) :
      // on bascule sur le mode hors-ligne plutôt que de rester bloqué.
      renderOfflineApp();
    });
  }

  /* ---------------- écran hors-ligne : liste des tâches ---------------- */

  var CURRENT_TASKS = [];
  var CURRENT_TOKEN = null;

  function renderOfflineApp(){
    showOnly('offline-app');
    Promise.all([tasksGetAll(), pendingGetAll()]).then(function(res){
      CURRENT_TASKS = res[0].filter(function(t){ return t.status !== 'fait'; })
        .sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
      var pending = res[1];
      $('pending-indicator').textContent = pending.length
        ? pending.length + ' en attente d\'envoi'
        : 'Tout est à jour';

      var list = $('offline-list');
      list.innerHTML = '';
      $('offline-empty').hidden = CURRENT_TASKS.length > 0;

      var pendingByTaskId = {};
      pending.forEach(function(p){ pendingByTaskId[p.taskId] = true; });

      CURRENT_TASKS.forEach(function(t){
        var card = document.createElement('div');
        card.className = 'task-card';
        var isQueued = !!pendingByTaskId[t.id];
        card.innerHTML =
          '<div class="t-title"></div>' +
          '<div class="t-meta"></div>' +
          (isQueued ? '<span class="pill pill-pending">En attente d\'envoi</span>' : '') +
          '<div class="t-actions"><button type="button" class="btn primary" data-complete="' + t.id + '">Clôturer</button></div>';
        card.querySelector('.t-title').textContent = t.title || '(sans titre)';
        card.querySelector('.t-meta').textContent = 'Échéance : ' + (t.dueDate || '—');
        if (isQueued) {
          var btn = card.querySelector('[data-complete]');
          if (btn) btn.disabled = true;
        }
        list.appendChild(card);
      });

      list.querySelectorAll('[data-complete]').forEach(function(btn){
        btn.addEventListener('click', function(){ openCompleteDialog(btn.getAttribute('data-complete')); });
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

  function sigClear(){
    sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    sigHasStroke = false;
  }
  function sigPointFromEvent(ev){
    var rect = sigCanvas.getBoundingClientRect();
    var x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    var y = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return { x: x * (sigCanvas.width / rect.width), y: y * (sigCanvas.height / rect.height) };
  }
  function sigStart(ev){
    ev.preventDefault();
    sigDrawing = true;
    var p = sigPointFromEvent(ev);
    sigCtx.beginPath();
    sigCtx.moveTo(p.x, p.y);
  }
  function sigMove(ev){
    if (!sigDrawing) return;
    ev.preventDefault();
    var p = sigPointFromEvent(ev);
    sigCtx.lineWidth = 2; sigCtx.lineCap = 'round'; sigCtx.strokeStyle = '#1A2230';
    sigCtx.lineTo(p.x, p.y);
    sigCtx.stroke();
    sigHasStroke = true;
  }
  function sigEnd(){ sigDrawing = false; }
  ['mousedown', 'touchstart'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigStart, { passive: false }); });
  ['mousemove', 'touchmove'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigMove, { passive: false }); });
  ['mouseup', 'mouseleave', 'touchend'].forEach(function(ev){ sigCanvas.addEventListener(ev, sigEnd); });
  $('c-sig-clear').addEventListener('click', sigClear);

  function renderStars(){
    document.querySelectorAll('#c-rating .starbtn').forEach(function(b){
      var v = parseInt(b.getAttribute('data-star'), 10);
      b.classList.toggle('filled', v <= ratingValue);
    });
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
    ratingValue = 0; renderStars();
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
    errEl.hidden = true;

    var payload = {
      op: 'update', id: completingTaskId, status: 'fait',
      completionActions: actions, completionClientName: clientName,
      completionRating: ratingValue > 0 ? ratingValue : null,
      signatureDataUrl: sigCanvas.toDataURL('image/png'),
    };

    pendingAdd({ taskId: completingTaskId, payload: payload, createdAt: Date.now() }).then(function(){
      // Mise à jour optimiste du cache local : la tâche disparaît de la
      // liste "à faire" immédiatement, sans attendre l'envoi réel.
      return tasksGetAll();
    }).then(function(all){
      var t = all.find(function(x){ return x.id === completingTaskId; });
      if (t) { t.status = 'fait'; return tasksUpsert(t); }
    }).then(function(){
      completeDialog.close();
      toast('Enregistré — sera envoyé automatiquement dès le retour du réseau.');
      renderOfflineApp();
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
