// ==UserScript==
// @name         Grepolis Auto-Purificação
// @namespace    local.grepolis.tools
// @version      1.4.1
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-auto-purification.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-auto-purification.user.js
// @description  Lança Purificação automaticamente quando Narcisismo é aplicado numa cidade própria.
// @match        https://*.grepolis.com/game/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.4.1';
  const PREFIX = '[AutoPurification]';
  const STORAGE_KEY = 'grepolis_auto_purification_state_v5';
  const LOG_KEY = 'grepolis_auto_purification_logs_v1';
  const CONFIG = Object.freeze({ scanIntervalMs: 150, fallbackFavorCost: 200, ajaxTimeoutMs: 6_000 });

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function integer(value, fallback = 0) { return Math.trunc(number(value, fallback)); }

  function normalizeToken(value) {
    return String(value || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_');
  }

  function read(source, keys, fallback) {
    const raw = source?.attributes || source || {};
    for (const key of keys) {
      if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    }
    return fallback;
  }

  function modelGet(model, key) {
    try { return model?.get?.(key); } catch { return undefined; }
  }

  function tokenFromModel(value) {
    if (typeof value === 'string') return normalizeToken(value);
    const raw = value?.attributes || value || {};
    return normalizeToken(read(raw, ['god_id', 'god', 'id', 'name'], ''));
  }

  function godFromTownModel(model) {
    let direct;
    try { direct = model?.getGod?.(); } catch { direct = undefined; }
    if (!tokenFromModel(direct)) {
      try { direct = model?.god?.(); } catch { direct = undefined; }
    }
    return tokenFromModel(direct)
      || tokenFromModel(modelGet(model, 'god'))
      || tokenFromModel(model?.attributes?.god)
      || tokenFromModel(model?.god);
  }

  function collectionValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.models)) return value.models;
    return typeof value === 'object' ? Object.entries(value).map(([key, item]) => {
      if (item && typeof item === 'object') return { __key: key, ...item };
      return { __key: key, value: item };
    }) : [];
  }

  function powerFromCollections(values, aliases, townId = '') {
    const wanted = aliases.map(normalizeToken);
    return collectionValues(values).find((power) => {
      const raw = power?.attributes || power || {};
      const id = normalizeToken(read(raw, ['power_id', 'power', 'id', 'name', '__key'], ''));
      const targetTownId = read(raw, ['town_id', 'target_town_id', 'target_id'], '');
      return wanted.includes(id) && (!townId || String(targetTownId) === String(townId));
    }) || null;
  }

  function favorFromGods(gods, godId) {
    if (typeof gods === 'string') {
      try { gods = JSON.parse(gods); } catch { gods = null; }
    }
    let god = gods?.[godId] ?? gods?.attributes?.[godId];
    if (god === undefined) {
      try { god = gods?.get?.(godId); } catch { god = undefined; }
    }
    const raw = gods?.attributes || gods || {};
    const candidates = [
      typeof god === 'number' || typeof god === 'string' ? god : undefined,
      god?.current,
      god?.favor,
      god?.attributes?.favor,
      modelGet(god, 'favor'),
      raw?.[`${godId}_favor`],
      raw?.production_overview?.[godId]?.current
    ];
    const favor = candidates.map(Number).find(Number.isFinite);
    return favor === undefined ? Number.NaN : favor;
  }

  function purificationDecision({ narcissism, protectedCity, artemisTownId, favor, cost, handled } = {}) {
    if (!narcissism) return { allowed: false, reason: 'no-narcissism' };
    if (handled) return { allowed: false, reason: 'already-handled' };
    if (protectedCity) return { allowed: false, reason: 'city-protected' };
    if (!artemisTownId) return { allowed: false, reason: 'artemis-unavailable' };
    if (!Number.isFinite(Number(favor))) return { allowed: false, reason: 'favor-unknown' };
    if (Number(favor) < Number(cost)) return { allowed: false, reason: 'insufficient-favor' };
    return { allowed: true, reason: 'allowed' };
  }

  const Core = {
    VERSION, CONFIG, normalizeToken, purificationDecision,
    godFromTownModel, powerFromCollections, favorFromGods
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || !window.document) return;

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const jobs = new Map();
  let timer = null;
  let scanning = false;
  let stopped = false;

  function load(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function save(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage is diagnostic only */ }
  }

  function log(level, message, data = {}) {
    const entries = load(LOG_KEY, []);
    entries.push({ at: Date.now(), level, message, data });
    save(LOG_KEY, entries.slice(-200));
    page.console?.[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']?.(PREFIX, message, data);
  }

  function persist() { save(STORAGE_KEY, { version: VERSION, jobs: [...jobs.values()] }); }

  function ownTowns() {
    const values = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    return Object.entries(values).map(([fallbackId, model]) => ({
      id: String(model?.getId?.() ?? model?.id ?? fallbackId), model
    })).filter((town) => town.id);
  }

  function townGod(town) {
    return godFromTownModel(town?.model);
  }

  function castedPower(town, aliases) {
    let methodValues;
    try { methodValues = town?.model?.getCastedPowers?.(); } catch { methodValues = undefined; }
    const sources = [
      methodValues,
      modelGet(town?.model, 'casted_powers'),
      town?.model?.attributes?.casted_powers
    ];
    for (const values of sources) {
      const match = powerFromCollections(values, aliases, town?.id);
      if (match) return match;
    }
    return null;
  }

  function artemisFavor() {
    const candidates = [];
    try {
      const gods = page.ITowns?.getGods?.() ?? page.ITowns?.gods;
      candidates.push(favorFromGods(gods, 'artemis'));
    } catch { /* inspect model manager below */ }
    candidates.push(
      favorFromGods(page.ITowns?.player_gods, 'artemis'),
      favorFromGods(page.Game?.favors, 'artemis')
    );
    try {
      const models = page.MM?.getModels?.() || {};
      Object.entries(models).forEach(([name, collection]) => {
        if (!/god|favor/i.test(name)) return;
        const values = collectionValues(collection);
        values.forEach((model) => {
          const raw = model?.attributes || model || {};
          if (normalizeToken(read(raw, ['god_id', 'god', 'id', '__key'], '')) === 'artemis') {
            candidates.push(read(raw, ['favor', 'current_favor', 'value'], modelGet(model, 'favor')));
          }
        });
      });
    } catch { /* unknown favor blocks casting */ }
    const favor = candidates.map(Number).find(Number.isFinite);
    return favor === undefined ? Number.NaN : favor;
  }

  function purificationCost() {
    const powers = page.GameData?.powers || {};
    const entry = powers.cleanse || powers.purification
      || Object.entries(powers).find(([id, power]) => /cleanse|purification|purificacao/i.test(`${id} ${power?.name || ''}`))?.[1];
    const cost = Number(entry?.favor ?? entry?.cost ?? entry?.favor_cost);
    return Number.isFinite(cost) ? cost : CONFIG.fallbackFavorCost;
  }

  function fingerprint(townId, effect) {
    const raw = effect?.attributes || effect || {};
    return `${townId}:${read(raw, ['id', 'power_id', 'cast_id', 'end_at', 'expires_at'], 'active')}`;
  }

  function ajaxPost(controller, action, data) {
    return new Promise((resolve, reject) => {
      const fn = page.gpAjax?.ajaxPost;
      if (typeof fn !== 'function') return reject(new Error('gpAjax.ajaxPost indisponível.'));
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`Timeout: ${controller}/${action}`)), CONFIG.ajaxTimeoutMs);
      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const payload = response?.json ?? response;
        if (error) reject(error);
        else if (payload?.error) {
          reject(new Error(String(payload.error)));
        } else if (payload?.success === false) {
          reject(new Error(`Grepolis rejeitou ${controller}/${action}.`));
        } else resolve(payload);
      }
      try {
        const request = fn.call(page.gpAjax, controller, action, data, false, (response) => finish(null, response));
        if (request?.then) request.then((response) => finish(null, response), (error) => finish(error));
        else if (request?.fail) request.fail((error) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  async function castPurification(job) {
    job.stage = 'casting';
    job.attemptedAt = Date.now();
    persist();
    try {
      await ajaxPost('town_info', 'cast', {
        power: 'cleanse',
        id: integer(job.targetTownId)
      });
      job.stage = 'done';
      job.completedAt = Date.now();
      log('info', 'Purificação automática lançada.', { townId: job.targetTownId });
    } catch (error) {
      job.stage = 'blocked';
      job.error = error.message;
      log('warn', 'Purificação bloqueada; não será repetida para este efeito.', {
        townId: job.targetTownId, error: error.message
      });
    }
    persist();
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const towns = ownTowns();
      const artemisTown = towns.find((town) => townGod(town) === 'artemis');
      const favor = artemisFavor();
      const cost = purificationCost();
      for (const town of towns) {
        const effect = castedPower(town, ['narcissism', 'narcisismo']);
        const previous = jobs.get(town.id);
        if (!effect) {
          if (previous) jobs.delete(town.id);
          continue;
        }
        const effectFingerprint = fingerprint(town.id, effect);
        const handled = previous?.fingerprint === effectFingerprint;
        if (handled) continue;
        const decision = purificationDecision({
          narcissism: true,
          protectedCity: Boolean(castedPower(town, ['town_protection', 'city_protection', 'protection', 'protecao'])),
          artemisTownId: artemisTown?.id,
          favor,
          cost,
          handled
        });
        const job = {
          targetTownId: town.id,
          sourceTownId: artemisTown?.id || '',
          fingerprint: effectFingerprint,
          detectedAt: Date.now(),
          favor: Number.isFinite(favor) ? favor : null,
          cost,
          stage: decision.allowed ? 'scheduled' : 'blocked',
          error: decision.allowed ? '' : decision.reason
        };
        jobs.set(town.id, job);
        persist();
        if (decision.allowed) await castPurification(job);
        else log('warn', 'Purificação automática cancelada.', { townId: town.id, reason: decision.reason });
      }
    } finally {
      scanning = false;
    }
  }

  function restore() {
    const stored = load(STORAGE_KEY, {});
    for (const raw of stored.jobs || []) {
      if (['scheduled', 'casting'].includes(raw.stage)) {
        raw.stage = 'blocked';
        raw.error = 'cast-status-unknown-after-reload';
      }
      jobs.set(String(raw.targetTownId), raw);
    }
  }

  function ready() {
    return typeof page.gpAjax?.ajaxPost === 'function' && typeof page.ITowns?.getTowns === 'function';
  }

  function boot() {
    if (!ready()) return setTimeout(boot, 250);
    restore();
    timer = setInterval(scan, CONFIG.scanIntervalMs);
    void scan();
    Object.defineProperty(page, '__grepolisAutoPurification', {
      configurable: true,
      value: Object.freeze({
        version: VERSION,
        stop: () => { stopped = true; clearInterval(timer); },
        start: () => {
          if (!stopped) return;
          stopped = false;
          timer = setInterval(scan, CONFIG.scanIntervalMs);
          void scan();
        },
        status: () => ({ stopped, scanning, jobs: [...jobs.values()] }),
        logs: () => load(LOG_KEY, [])
      })
    });
    log('info', `Auto-Purificação v${VERSION} iniciada.`);
  }

  boot();
}());
