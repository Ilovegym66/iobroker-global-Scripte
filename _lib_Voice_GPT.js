
 'use strict';

/**
 * Global helper lib for ioBroker JS adapter.
 * Usage: globalThis._libVoiceGpt
 *
 * v1.2 (2025-12-22)
 * - exports writeCommand (was missing before)
 * - non-repeating pick (pickNR) with per-key "bag"
 * - voiceGreetingDecision(): richer greeting/decision via OpenAI, with safe fallback
 * - more robust gv/safeSet helpers
 */

globalThis._libVoiceGpt = (function (PREV) {
  var https = require('https');

  // =========================
  // Basics
  // =========================
  function pick(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function chance(p) {
    return Math.random() < p;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function hhmm(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayPart(d) {
    d = d || new Date();
    var h = d.getHours();
    if (h >= 5 && h < 11) return 'morgen';
    if (h >= 11 && h < 17) return 'tag';
    if (h >= 17 && h < 22) return 'abend';
    return 'nacht';
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function exists(id) {
    try { return !!existsState(id); } catch (e) { return false; }
  }

  function gv(id, def) {
    try {
      if (!id) return def;
      var s = getState(id);
      if (!s || s.val === null || s.val === undefined) return def;
      return s.val;
    } catch (e) {
      return def;
    }
  }

  function safeSet(id, val, ack) {
    try {
      if (!id) return;
      if (typeof ack !== 'boolean') ack = false;

      var s = null;
      try { s = getState(id); } catch (e) { s = null; }

      if (s && s.val === val && s.ack === ack) return;
      setState(id, val, ack);
    } catch (e) {}
  }

  /**
   * Alexa/Command states robust trigger:
   * - clear first (ack:false)
   * - then write actual value (ack:false)
   */
  function writeCommand(id, val, delayMs) {
    delayMs = delayMs || 150;
    var v = String(val || '');

    return new Promise(function (resolve) {
      try { setState(id, { val: '', ack: false }); } catch (e) {}
      setTimeout(function () {
        try { setState(id, { val: v, ack: false }); } catch (e) {}
        resolve();
      }, delayMs);
    });
  }

  // =========================
  // Non-repeating pick (anti-repeat)
  // =========================
  // per key: bag of remaining indices
  var _bags = Object.create(null);
  var _lastPick = Object.create(null); // key-> last string

  function _shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * pickNR(key, arr):
   * - cycles through all elements in random order before repeating
   * - additionally avoids immediate same-as-last when possible
   */
  function pickNR(key, arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    key = String(key || 'default');

    var bag = _bags[key];
    if (!Array.isArray(bag) || bag.length === 0) {
      bag = [];
      for (var i = 0; i < arr.length; i++) bag.push(i);
      _shuffle(bag);
      _bags[key] = bag;
    }

    // try to avoid immediate repetition
    var last = _lastPick[key];
    var idx = bag.shift();
    var val = arr[idx];

    if (arr.length > 1 && last && String(val) === String(last) && bag.length) {
      // swap with next
      var idx2 = bag.shift();
      bag.unshift(idx); // put previous back at front
      idx = idx2;
      val = arr[idx];
    }

    _lastPick[key] = val;
    return val;
  }

  // =========================
  // OpenAI Responses API
  // =========================
  function extractResponseText(respJson) {
    try {
      var out = respJson && respJson.output;
      if (!Array.isArray(out)) return '';
      var parts = [];
      for (var i = 0; i < out.length; i++) {
        var item = out[i];
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          for (var j = 0; j < item.content.length; j++) {
            var c = item.content[j];
            if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
          }
        }
      }
      return parts.join(' ').trim();
    } catch (e) {
      return '';
    }
  }

  function httpJson(opts) {
    return new Promise(function (resolve, reject) {
      var method = opts.method;
      var hostname = opts.hostname;
      var path = opts.path;
      var headers = opts.headers || {};
      var body = opts.body || null;
      var timeoutMs = opts.timeoutMs || 8000;

      var req = https.request(
        { method: method, hostname: hostname, path: path, headers: headers, timeout: timeoutMs },
        function (res) {
          var data = '';
          res.on('data', function (chunk) { data += chunk; });
          res.on('end', function () {
            var ok = res.statusCode >= 200 && res.statusCode < 300;
            if (!ok) return reject(new Error('HTTP ' + res.statusCode + ': ' + data));
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(e); }
          });
        }
      );

      req.on('timeout', function () { req.destroy(new Error('HTTP timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function extractFirstJsonObject(text) {
    var s = String(text || '');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return s.slice(start, end + 1);
    return '';
  }

  function openAIResponses(opts) {
    var apiKey = opts && opts.apiKey;
    var model = opts && opts.model;
    var instructions = opts && opts.instructions;
    var input = opts && opts.input;
    var timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 8000;

    var body = JSON.stringify({
      model: model,
      instructions: instructions,
      input: input,
      text: { verbosity: (opts && opts.verbosity) ? opts.verbosity : 'low' }
    });

    return httpJson({
      method: 'POST',
      hostname: 'api.openai.com',
      path: '/v1/responses',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body: body,
      timeoutMs: timeoutMs
    }).then(function (json) {
      return extractResponseText(json);
    });
  }

  function openAIResponsesJsonObject(opts) {
    var apiKey = opts && opts.apiKey;
    var model = opts && opts.model;
    var instructions = opts && opts.instructions;
    var input = opts && opts.input;
    var timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 9000;

    var body = JSON.stringify({
      model: model,
      instructions: instructions,
      input: input,
      text: {
        verbosity: (opts && opts.verbosity) ? opts.verbosity : 'low',
        format: { type: 'json_object' }
      }
    });

    return httpJson({
      method: 'POST',
      hostname: 'api.openai.com',
      path: '/v1/responses',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body: body,
      timeoutMs: timeoutMs
    }).then(function (json) {
      var txt = extractResponseText(json);
      if (!txt) return null;

      try {
        return JSON.parse(txt);
      } catch (e) {
        var candidate = extractFirstJsonObject(txt);
        if (!candidate) throw e;
        return JSON.parse(candidate);
      }
    });
  }

  function openAIListModels(apiKey, timeoutMs) {
    timeoutMs = timeoutMs || 8000;

    return httpJson({
      method: 'GET',
      hostname: 'api.openai.com',
      path: '/v1/models',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      timeoutMs: timeoutMs
    }).then(function (json) {
      var data = (json && json.data) ? json.data : [];
      var ids = data.map(function (m) { return m && m.id; }).filter(function (id) { return !!id; });
      return ids;
    });
  }

  var _modelsCache = null;
  var _modelsCacheTs = 0;

  function resolveOpenAIModel(opts) {
    var apiKey = opts && opts.apiKey;
    var desiredModel = opts && opts.desiredModel;
    var prefer = (opts && opts.prefer) ? opts.prefer : [];
    var cacheHours = (opts && opts.cacheHours) ? opts.cacheHours : 6;

    if (desiredModel && desiredModel !== 'auto') return Promise.resolve(desiredModel);

    var now = Date.now();
    var cacheValid = _modelsCache && ((now - _modelsCacheTs) <= cacheHours * 3600 * 1000);

    var p = cacheValid
      ? Promise.resolve(_modelsCache)
      : openAIListModels(apiKey).then(function (ids) {
          _modelsCache = ids;
          _modelsCacheTs = Date.now();
          return ids;
        });

    return p.then(function (ids) {
      ids = ids || [];
      for (var i = 0; i < prefer.length; i++) {
        if (ids.indexOf(prefer[i]) !== -1) return prefer[i];
      }
      return ids.length ? ids[0] : null;
    });
  }

  // =========================
  // High-level: richer TTS JSON (greeting/decision)
  // =========================
  // small in-memory cache to reduce repeats per room+station+dayPart
  var _voiceMem = Object.create(null); // key -> {lastTs, lastGreeting, lastDecision}

  function _clip(s, maxLen) {
    s = String(s || '').trim();
    if (!maxLen || s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1).trim() + '…';
  }

  function buildLocalGreetingDecision(params) {
    var room = String(params.room || 'raum');
    var now = params.now || new Date();
    var station = String(params.station || 'Radio');
    var isDark = !!params.isDark;
    var time = hhmm(now);
    var part = dayPart(now);

    // mehr Varianz lokal: pickNR statt pick
    var greetings = params.greetings || [
      'Hallo du da… ich mach ein bisschen Radio an.',
      'Hey, was geht ab? Ich starte Musik.',
      'Oh, damit habe ich jetzt nicht gerechnet!',
      'Gääähn… jetzt hast du mich geweckt.',
      'So. Wir beide… und ein bisschen Musik.',
      'Ich bin bereit. Lass uns was hören.'
    ];

    var jokes = params.jokes || [
      'Kurzer Service-Hinweis: Der Kaffee ist leider noch nicht im WLAN.',
      'Ich wollte ja Sport machen… aber dann hat mich die Couch bedroht.',
      'Ich bin nicht faul. Ich bin im Energiesparmodus.',
      'Wenn ich ein Körper hätte, würde ich jetzt mitwippen.'
    ];

    var g = pickNR('greet:' + room, greetings);

    var opener =
      (part === 'morgen') ? ('Guten Morgen! Es ist ' + time + '.') :
      (part === 'tag')    ? ('Guten Tag! Es ist ' + time + '.') :
      (part === 'abend')  ? ('Guten Abend! Es ist ' + time + '.') :
                            ('Pssst… es ist ' + time + '.');

    var d = opener + ' Ich starte jetzt ' + station + '.';
    if (isDark) d += ' Weil es dunkel ist, mache ich Licht an.';
    if (chance(0.55)) d += ' ' + pickNR('joke:' + room, jokes);

    return {
      greeting: _clip(g, params.maxGreetingChars || 120),
      decision: _clip(d, params.maxDecisionChars || 420)
    };
  }

  /**
   * voiceGreetingDecision(params) => Promise<{greeting, decision}>
   *
   * params:
   * - apiKey (optional) OR apiKeyState (optional)
   * - modelDesired ('auto' ok), modelPrefer[]
   * - room, station, now, isDark, extraContext
   * - maxGreetingChars, maxDecisionChars
   * - style: { humorLevel: 0..2, vivid: true/false, slightlyLonger: true/false }
   */
  function voiceGreetingDecision(params) {
    params = params || {};
    var room = String(params.room || 'raum');
    var now = params.now || new Date();
    var station = String(params.station || 'Radio');
    var isDark = !!params.isDark;

    // anti-repeat memo key
    var memoKey = room + '|' + station + '|' + dayPart(now);
    var memo = _voiceMem[memoKey];

    // small cooldown against identical lines
    if (memo && (Date.now() - memo.lastTs) < 2 * 60 * 1000) {
      // force local variation rather than returning same
      // (still returns quickly)
    }

    var apiKey = (params.apiKey && String(params.apiKey).trim()) || '';
    if (!apiKey && params.apiKeyState) apiKey = String(gv(params.apiKeyState, '') || '').trim();

    // no key / no helpers -> local
    if (!apiKey || typeof resolveOpenAIModel !== 'function' || typeof openAIResponsesJsonObject !== 'function') {
      var loc = buildLocalGreetingDecision(params);
      _voiceMem[memoKey] = { lastTs: Date.now(), lastGreeting: loc.greeting, lastDecision: loc.decision };
      return Promise.resolve(loc);
    }

    var prefer = Array.isArray(params.modelPrefer) ? params.modelPrefer : [];
    var desired = params.modelDesired || params.desiredModel || 'auto';
    var timeoutMs = params.timeoutMs || 9000;

    return resolveOpenAIModel({ apiKey: apiKey, desiredModel: desired, prefer: prefer }).then(function (model) {
      if (!model) {
        var loc2 = buildLocalGreetingDecision(params);
        _voiceMem[memoKey] = { lastTs: Date.now(), lastGreeting: loc2.greeting, lastDecision: loc2.decision };
        return loc2;
      }

      var time = hhmm(now);
      var part = dayPart(now);

      var style = params.style || {};
      var humorLevel = (style.humorLevel === 0 || style.humorLevel === 1 || style.humorLevel === 2) ? style.humorLevel : 1;
      var vivid = (style.vivid === true);
      var slightlyLonger = (style.slightlyLonger !== false); // default true

      var maxG = params.maxGreetingChars || 140;
      var maxD = params.maxDecisionChars || 520;

      var tone =
        (humorLevel === 0) ? 'freundlich und sachlich' :
        (humorLevel === 2) ? 'locker, witzig, aber nicht albern' :
                             'locker, sympathisch';

      var extraContext = String(params.extraContext || '').trim();
      var darkText = isDark ? 'Es ist dunkel; Licht wird eingeschaltet/bleibt an.' : 'Licht bleibt unverändert.';

      var instructions =
        'Du gibst NUR ein JSON-Objekt zurück. Kein Text außerhalb JSON. ' +
        'Deutsch, Alexa-TTS geeignet, kein SSML. ' +
        'Sicher: keine Beleidigungen gegen Personen/Gruppen, keine politischen Inhalte, keine Sexualinhalte.';

      // bewusst weniger enge Grenzen + mehr Varianz
      var input =
        'Kontext:\n' +
        '- Raum: ' + room + '\n' +
        '- Tageszeit: ' + part + '\n' +
        '- Uhrzeit: ' + time + '\n' +
        '- Sender: ' + station + '\n' +
        '- Licht: ' + darkText + '\n' +
        (extraContext ? ('- Extra: ' + extraContext + '\n') : '') +
        '\nErzeuge JSON: {"greeting":"...","decision":"..."}\n' +
        'Regeln:\n' +
        '- greeting: 1–2 Sätze, natürlich, ' + tone + ', max ' + maxG + ' Zeichen.\n' +
        '- decision: ' + (slightlyLonger ? '2–3 Sätze' : 'max 2 Sätze') + ', max ' + maxD + ' Zeichen.\n' +
        '- decision MUSS enthalten: Uhrzeit UND "Ich starte <Sender>".\n' +
        '- Optional: 1 kurzer, neuer Witz (keine Wiederholung von Standard-Floskeln).\n' +
        '- Optional: 0–1 mildes Wort (z.B. "Mist", "verdammt", "so ein Käse") – nie gegen Personen.\n' +
        (vivid ? '- Sprachbilder erlaubt, aber kurz und verständlich.\n' : '');

      return openAIResponsesJsonObject({
        apiKey: apiKey,
        model: model,
        instructions: instructions,
        input: input,
        timeoutMs: timeoutMs,
        verbosity: 'medium' // wichtiger Hebel: nicht "low"
      }).then(function (obj) {
        if (!obj || typeof obj !== 'object') return buildLocalGreetingDecision(params);

        var g = _clip(obj.greeting, maxG);
        var d = _clip(obj.decision, maxD);

        // Anti-repeat: wenn exakt gleich wie letztes Mal, fall back to local
        if (memo && memo.lastGreeting === g && memo.lastDecision === d) {
          return buildLocalGreetingDecision(params);
        }

        var out = { greeting: g, decision: d };
        _voiceMem[memoKey] = { lastTs: Date.now(), lastGreeting: out.greeting, lastDecision: out.decision };
        return out;
      }).catch(function () {
        return buildLocalGreetingDecision(params);
      });
    });
  }

  // =========================
  // Public API
  // =========================
  return {
    // compat
    pick: pick,
    pickNR: pickNR,
    chance: chance,
    hhmm: hhmm,
    dayPart: dayPart,
    gv: gv,
    safeSet: safeSet,
    writeCommand: writeCommand,
    sleep: sleep,

    extractResponseText: extractResponseText,
    httpJson: httpJson,

    openAIResponses: openAIResponses,
    openAIResponsesJsonObject: openAIResponsesJsonObject,
    openAIListModels: openAIListModels,
    resolveOpenAIModel: resolveOpenAIModel,

    // new high-level
    voiceGreetingDecision: voiceGreetingDecision
  };
})(globalThis._libVoiceGpt);
