'use strict';

/**
 * Global helper lib for ioBroker JS adapter.
 * Usage in other scripts: globalThis._libVoiceGpt
 */

globalThis._libVoiceGpt = globalThis._libVoiceGpt || (function () {
  var https = require('https');

  function pick(arr) {
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

  function gv(id, def) {
    var s = getState(id);
    if (!s || s.val === null || s.val === undefined) return def;
    return s.val;
  }

 function safeSet(id, val, ack) {
  // ack NUR akzeptieren, wenn es wirklich boolean ist
  if (typeof ack !== 'boolean') ack = false;

  var s = getState(id);
  if (s && s.val === val && s.ack === ack) return;
  setState(id, val, ack);
}

/**
 * Alexa-/Command-States robust triggern:
 * - erst leeren (ack:false)
 * - dann echten Wert schreiben (ack:false)
 * Dadurch entsteht sicher eine Änderung, selbst wenn derselbe Command erneut gesendet wird.
 */
function writeCommand(id, val, delayMs) {
  delayMs = delayMs || 150;
  var v = String(val || '');

  return new Promise(function (resolve) {
    // 1) leeren
    setState(id, { val: '', ack: false });

    // 2) nach kurzer Pause den eigentlichen Command setzen
    setTimeout(function () {
      setState(id, { val: v, ack: false });
      resolve();
    }, delayMs);
  });
}


  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function extractResponseText(respJson) {
    // Responses API: output[].content[].type === "output_text"
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
    // opts: { method, hostname, path, headers, body, timeoutMs }
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
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
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
    // opts: { apiKey, model, instructions, input, timeoutMs }
    var apiKey = opts && opts.apiKey;
    var model = opts && opts.model;
    var instructions = opts && opts.instructions;
    var input = opts && opts.input;
    var timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 8000;

    var body = JSON.stringify({
      model: model,
      instructions: instructions,
      input: input,
      text: { verbosity: 'low' }
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
    // opts: { apiKey, model, instructions, input, timeoutMs }
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
        verbosity: 'low',
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
      var ids = data
        .map(function (m) { return m && m.id; })
        .filter(function (id) { return !!id; });

      return ids;
    });
  }

  // Cache: pro Script-Context
  var _modelsCache = null;
  var _modelsCacheTs = 0;

  function resolveOpenAIModel(opts) {
    // opts: { apiKey, desiredModel, prefer, cacheHours }
    var apiKey = opts && opts.apiKey;
    var desiredModel = opts && opts.desiredModel;
    var prefer = (opts && opts.prefer) ? opts.prefer : [];
    var cacheHours = (opts && opts.cacheHours) ? opts.cacheHours : 6;

    if (desiredModel && desiredModel !== 'auto') {
      return Promise.resolve(desiredModel);
    }

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

  return {
    pick: pick,
    chance: chance,
    hhmm: hhmm,
    dayPart: dayPart,
    gv: gv,
    safeSet: safeSet,
    sleep: sleep,

    extractResponseText: extractResponseText,
    httpJson: httpJson,

    openAIResponses: openAIResponses,
    openAIResponsesJsonObject: openAIResponsesJsonObject,
    openAIListModels: openAIListModels,
    resolveOpenAIModel: resolveOpenAIModel
  };
})();
