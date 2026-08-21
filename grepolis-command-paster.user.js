// ==UserScript==
// @name         Grepolis — Colagem automática de comandos PT
// @namespace    https://grepolis.com/
// @version      2.5.5
// @description  Envia comandos já guardados no Planeador nativo, sem abrir janelas de ataque ou apoio.
// @match        https://*.grepolis.com/game/*
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-command-paster.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-command-paster.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisCommandPasterFactory() {
  'use strict';

  const VERSION = '2.5.5';
  const TERMINAL_STATES = new Set(['confirmed', 'cancelled', 'failed', 'expired']);
  const SUPPORTED_TYPES = new Set(['attack', 'support', 'revolt']);
  const UNIT_KEY = /^[a-z][a-z0-9_]*$/;
  const TIMING_CORRECTION_WINDOW_MS = 10_000;

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function integer(value, fallback = 0) {
    return Math.max(0, Math.floor(number(value, fallback)));
  }

  function signedInteger(value, fallback = 0) {
    return Math.trunc(number(value, fallback));
  }

  function timestampMs(value) {
    const parsed = number(value);
    if (!parsed) return 0;
    return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  }

  function canonicalType(value) {
    const text = String(value || '').toLowerCase();
    if (/support|apoio|refor/.test(text)) return 'support';
    if (/attack|ataque|revolt|colon|takeover/.test(text)) return 'attack';
    return 'unknown';
  }

  function normalizeUnits(value) {
    const units = {};
    for (const [name, amount] of Object.entries(value || {})) {
      if (!UNIT_KEY.test(name) || name === 'militia') continue;
      const count = integer(amount);
      if (count > 0) units[name] = count;
    }
    return units;
  }

  function parseStrategies(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return String(value).split(',').map((item) => item.trim()).filter(Boolean);
    }
  }

  function commandKind(command) {
    if (integer(command?.units?.colonize_ship) > 0) return 'nc';
    return canonicalType(command?.type) === 'support' ? 'support' : 'attack';
  }

  function toleranceForCommand(command, settings = {}) {
    return Math.min(15, Math.max(0, signedInteger(settings[commandKind(command)], 0)));
  }

  function normalizePlannedCommand(raw) {
    const type = String(raw?.type || '').toLowerCase();
    const canonical = canonicalType(type);
    const units = normalizeUnits(raw?.units);
    const id = String(raw?.id ?? '');
    const planId = String(raw?.plan_id ?? '');
    const originTownId = String(raw?.origin_town_id ?? raw?.town_id ?? '');
    const targetTownId = String(raw?.target_town_id ?? raw?.target_id ?? '');
    const sendAt = timestampMs(raw?.send_at);
    const arrivalAt = timestampMs(raw?.arrival_at);
    const valid = Boolean(
      id && planId && originTownId && targetTownId
      && sendAt && arrivalAt && arrivalAt > sendAt
      && SUPPORTED_TYPES.has(type) && canonical !== 'unknown'
      && Object.keys(units).length
    );
    return {
      id,
      planId,
      planName: String(raw?.plan_name || ''),
      type,
      canonicalType: canonical,
      originTownId,
      targetTownId,
      sendAt,
      arrivalAt,
      units,
      useHero: Boolean(raw?.use_hero),
      spell: raw?.spell || '',
      strategies: parseStrategies(raw?.strategies),
      canEdit: raw?.can_edit !== false,
      valid,
      invalidReason: valid ? '' : 'planned-command-incomplete'
    };
  }

  function buildSendPayload(command) {
    const payload = {
      id: integer(command.targetTownId),
      town_id: integer(command.originTownId),
      type: command.type,
      nl_init: true,
      ...normalizeUnits(command.units)
    };
    if (command.useHero) payload.use_hero = true;
    if (command.spell) payload.power_id = command.spell;
    if (command.strategies?.length) payload.attacking_strategy = [...command.strategies];
    return payload;
  }

  function plannedTimes(command, settings = {}) {
    return {
      toleranceSeconds: toleranceForCommand(command, settings),
      dispatchAt: command.sendAt,
      desiredArrivalAt: command.arrivalAt
    };
  }

  function arrivalResult(actualArrivalAt, desiredArrivalAt, toleranceSeconds = 0) {
    const actualSecond = Math.floor(number(actualArrivalAt) / 1_000) * 1_000;
    const desiredSecond = Math.floor(number(desiredArrivalAt) / 1_000) * 1_000;
    const deviationMs = actualSecond - desiredSecond;
    const earliestAcceptedMs = -Math.max(0, signedInteger(toleranceSeconds, 0)) * 1_000;
    return {
      deviationMs,
      accepted: deviationMs >= earliestAcceptedMs && deviationMs <= 0,
      retry: deviationMs < earliestAcceptedMs
    };
  }

  function commandFingerprint(command) {
    return JSON.stringify({
      id: command?.id,
      planId: command?.planId,
      type: command?.type,
      originTownId: command?.originTownId,
      targetTownId: command?.targetTownId,
      sendAt: command?.sendAt,
      arrivalAt: command?.arrivalAt,
      units: command?.units,
      useHero: command?.useHero,
      spell: command?.spell,
      strategies: command?.strategies
    });
  }

  function median(values) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function releaseAt(dispatchAt, rttMs, earlyBiasMs = 120) {
    return number(dispatchAt) - Math.max(0, number(rttMs)) / 2 - Math.max(0, number(earlyBiasMs));
  }

  function calibratedAttemptAt(sendStartedAt, deviationMs, toleranceSeconds = 0) {
    const acceptedWindowCenterMs = 500 - Math.max(0, signedInteger(toleranceSeconds, 0)) * 500;
    return number(sendStartedAt) - number(deviationMs) + acceptedWindowCenterMs;
  }

  function isTerminal(job) {
    return TERMINAL_STATES.has(job?.status);
  }

  function reconcileCapturedJobs({ jobs = {}, capturedIds = [], commands = [], offsets = {}, now = 0 }) {
    const commandMap = new Map(commands.map((command) => [String(command.id), command]));
    const next = {};
    for (const rawId of capturedIds) {
      const id = String(rawId);
      const existing = jobs[id] ? { ...jobs[id] } : { id, status: 'pending' };
      if (isTerminal(existing)) {
        next[id] = existing;
        continue;
      }
      const command = commandMap.get(id);
      if (!command) {
        next[id] = { ...existing, status: 'cancelled', error: 'removed-from-planner' };
        continue;
      }
      const times = plannedTimes(command, offsets);
      const fingerprint = commandFingerprint(command);
      const changed = Boolean(existing.fingerprint && existing.fingerprint !== fingerprint);
      next[id] = {
        ...existing,
        command,
        fingerprint,
        ...times,
        error: '',
        ...(changed ? { status: 'pending', releaseAt: 0, rttMs: 0, previewValidatedAt: 0, attempts: 0 } : {})
      };
      if (!command.valid) {
        next[id].status = 'failed';
        next[id].error = command.invalidReason;
      } else if (times.dispatchAt + TIMING_CORRECTION_WINDOW_MS <= now && existing.status !== 'sending') {
        next[id].status = 'expired';
        next[id].error = 'dispatch-time-passed';
      }
    }
    return next;
  }

  const Core = {
    VERSION,
    timestampMs,
    canonicalType,
    normalizeUnits,
    parseStrategies,
    commandKind,
    toleranceForCommand,
    normalizePlannedCommand,
    buildSendPayload,
    plannedTimes,
    arrivalResult,
    commandFingerprint,
    median,
    releaseAt,
    calibratedAttemptAt,
    isTerminal,
    reconcileCapturedJobs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || !window.document) return;

  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const CONFIG = Object.freeze({
    preflightLeadMs: 20_000,
    attemptLeadMs: 15_000,
    plannerRefreshMs: 1_000,
    ajaxTimeoutMs: 12_000,
    commandResolveTimeoutMs: 12_000,
    maximumRttMs: 2_000,
    earlyBiasMs: 120,
    maximumParallel: 1,
    spamGapMs: 20,
    maximumFailedAttempts: 200,
    timingCorrectionWindowMs: TIMING_CORRECTION_WINDOW_MS,
    leaseDurationMs: 7_000,
    leaseHeartbeatMs: 2_000,
    logLimit: 100
  });
  const DEFAULT_SETTINGS = Object.freeze({ attack: 0, support: 0, nc: 0 });
  const PANEL_ID = 'gcp-command-paster-controls';
  const STYLE_ID = 'gcp-command-paster-style';
  const ownerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let namespace = '';
  let storageKey = '';
  let leaseKey = '';
  let state = null;
  let activeSends = 0;
  let tickTimer = 0;
  let refreshTimer = 0;
  let leaseTimer = 0;
  let uiTimer = 0;
  let clockSyncPromise = null;
  let clockAnchor = null;
  let memoryLease = null;
  let stopped = false;
  let stopRequested = false;

  function blankState() {
    return {
      version: VERSION,
      armed: false,
      settings: { ...DEFAULT_SETTINGS },
      capturedIds: [],
      jobs: {},
      confirmedIds: [],
      confirmedFingerprints: [],
      rttSamples: [],
      logs: [],
      updatedAt: 0
    };
  }

  function loadValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function saveValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage failure is surfaced by status only */ }
  }

  function loadState() {
    const stored = loadValue(storageKey, null);
    const base = blankState();
    if (!stored || typeof stored !== 'object') return base;
    return {
      ...base,
      ...stored,
      version: VERSION,
      settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
      capturedIds: Array.isArray(stored.capturedIds) ? stored.capturedIds.map(String) : [],
      jobs: stored.jobs && typeof stored.jobs === 'object' ? stored.jobs : {},
      confirmedIds: Array.isArray(stored.confirmedIds) ? stored.confirmedIds.map(String) : [],
      confirmedFingerprints: Array.isArray(stored.confirmedFingerprints) ? stored.confirmedFingerprints.map(String) : [],
      rttSamples: Array.isArray(stored.rttSamples) ? stored.rttSamples.slice(-12) : [],
      logs: Array.isArray(stored.logs) ? stored.logs.slice(-CONFIG.logLimit) : []
    };
  }

  function persist() {
    if (!state) return;
    state.updatedAt = Date.now();
    saveValue(storageKey, state);
  }

  function log(level, message, details = {}) {
    state.logs.push({ at: Date.now(), level, message, details });
    state.logs = state.logs.slice(-CONFIG.logLimit);
    persist();
    if (level === 'error') console.error(`[GCP] ${message}`, details);
    else if (level === 'warn') console.warn(`[GCP] ${message}`, details);
    else console.info(`[GCP] ${message}`, details);
  }

  function notify(message, type = 'error') {
    const human = page.HumanMessage;
    if (type === 'success' && typeof human?.success === 'function') human.success(message);
    else if (typeof human?.error === 'function') human.error(message);
    else console[type === 'success' ? 'info' : 'error'](`[GCP] ${message}`);
  }

  function rawServerTimestamp() {
    try { return page.Timestamp?.server?.(); }
    catch { return 0; }
  }

  function serverNowMs() {
    if (clockAnchor) {
      return clockAnchor.serverMs + (performance.now() - clockAnchor.performanceMs);
    }
    const raw = rawServerTimestamp();
    const parsed = number(raw);
    if (parsed >= 10_000_000_000 || !Number.isInteger(parsed)) return timestampMs(parsed);
    if (parsed) return parsed * 1_000 + 500;
    return Date.now();
  }

  async function synchronizeServerClock() {
    if (clockSyncPromise) return clockSyncPromise;
    clockSyncPromise = (async () => {
      const initial = number(rawServerTimestamp());
      if (!initial) {
        clockAnchor = { serverMs: Date.now(), performanceMs: performance.now() };
        return clockAnchor;
      }
      if (initial >= 10_000_000_000 || !Number.isInteger(initial)) {
        clockAnchor = { serverMs: timestampMs(initial), performanceMs: performance.now() };
        return clockAnchor;
      }
      const deadline = performance.now() + 1_500;
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        const current = number(rawServerTimestamp());
        if (current > initial) {
          clockAnchor = { serverMs: current * 1_000, performanceMs: performance.now() };
          return clockAnchor;
        }
      }
      clockAnchor = { serverMs: initial * 1_000 + 500, performanceMs: performance.now() };
      return clockAnchor;
    })().finally(() => { clockSyncPromise = null; });
    return clockSyncPromise;
  }

  function ajax(method, controller, action, data, timeoutMs = CONFIG.ajaxTimeoutMs) {
    return new Promise((resolve, reject) => {
      const fn = page.gpAjax?.[method];
      if (typeof fn !== 'function') return reject(new Error(`gpAjax.${method} indisponível.`));
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`Timeout: ${controller}/${action}`)), timeoutMs);
      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(response);
      }
      try {
        const request = fn.call(page.gpAjax, controller, action, data || {}, false,
          (response) => finish(null, response));
        if (request?.then) request.then((response) => finish(null, response), (error) => finish(error));
        else if (request?.fail) request.fail((error) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  function responseJson(response) {
    return response?.json || response?.data || response || {};
  }

  async function fetchPlannedCommands() {
    const response = await ajax('ajaxGet', 'attack_planer', 'attacks', { nl_init: true });
    const rows = response?.data?.attacks || responseJson(response)?.attacks || [];
    return rows.map(normalizePlannedCommand);
  }

  function ownTownIds() {
    const towns = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    return new Set(Object.entries(towns).map(([fallbackId, town]) => String(
      town?.getId?.() ?? town?.id ?? town?.attributes?.id ?? fallbackId
    )));
  }

  function previewAvailableUnits(response) {
    const units = responseJson(response)?.units || {};
    const output = {};
    for (const [name, record] of Object.entries(units)) {
      output[name] = integer(record?.total ?? record?.count ?? record?.amount ?? record);
    }
    return output;
  }

  function validatePreview(command, response) {
    const data = responseJson(response);
    if (data.controller_type && data.controller_type !== 'town_info') {
      throw new Error('Preview devolveu controlador inesperado.');
    }
    if (data.target_id && String(data.target_id) !== command.targetTownId) {
      throw new Error('Preview devolveu cidade-alvo diferente.');
    }
    const previewType = canonicalType(data.type);
    if (previewType !== 'unknown' && previewType !== command.canonicalType) {
      throw new Error('Preview devolveu tipo de comando diferente.');
    }
    const available = previewAvailableUnits(response);
    for (const [name, required] of Object.entries(command.units)) {
      if (integer(available[name]) < required) {
        throw new Error(`Tropas insuficientes: ${name} (${available[name] || 0}/${required}).`);
      }
    }
    return available;
  }

  function leaseRecord() {
    try { return JSON.parse(localStorage.getItem(leaseKey) || 'null'); }
    catch { return memoryLease; }
  }

  function writeLease(record) {
    memoryLease = record;
    try { localStorage.setItem(leaseKey, JSON.stringify(record)); }
    catch { /* fallback protects one tab when localStorage is blocked */ }
  }

  function removeLease() {
    memoryLease = null;
    try { localStorage.removeItem(leaseKey); }
    catch { /* fallback already cleared */ }
  }

  function ownsLease(now = Date.now()) {
    const lease = leaseRecord();
    return Boolean(lease?.owner === ownerId && number(lease.expiresAt) > now);
  }

  function acquireLease() {
    const now = Date.now();
    const current = leaseRecord();
    if (current?.owner && current.owner !== ownerId && number(current.expiresAt) > now) return false;
    writeLease({ owner: ownerId, expiresAt: now + CONFIG.leaseDurationMs });
    return ownsLease(now);
  }

  function renewLease() {
    if (stopped) return;
    if (!ownsLease()) {
      if (acquireLease()) {
        // Outra tab pode ter confirmado comandos enquanto esta aguardava.
        state = loadState();
        renderPanel();
        if (state.armed) scheduleTick(0);
      }
    } else writeLease({ owner: ownerId, expiresAt: Date.now() + CONFIG.leaseDurationMs });
  }

  function releaseLease() {
    try {
      if (leaseRecord()?.owner === ownerId) removeLease();
    } catch { /* ignore */ }
  }

  function movementModels() {
    try {
      const direct = page.MM?.getModels?.()?.MovementsUnits;
      if (direct && typeof direct === 'object') return Object.values(direct);
      return page.MM?.getOnlyCollectionByName?.('MovementsUnits')?.models || [];
    } catch { return []; }
  }

  function movementRecord(model) {
    const source = model?.attributes || model?.toJSON?.() || model || {};
    return {
      id: String(source.command_id ?? source.id ?? model?.id ?? ''),
      type: canonicalType(source.command_type ?? source.type ?? source.movement_type),
      originTownId: String(source.origin_town_id ?? source.home_town_id ?? source.source_town_id ?? ''),
      targetTownId: String(source.target_town_id ?? source.destination_town_id ?? source.town_id ?? ''),
      startedAt: timestampMs(source.started_at ?? source.start_at ?? source.created_at),
      arrivalAt: timestampMs(source.arrival_at_ms ?? source.arrival_at ?? source.arrival_time ?? source.finished_at),
      returning: Boolean(source.returning ?? source.is_returning)
    };
  }

  function movements() {
    return movementModels().map(movementRecord).filter((movement) => movement.id);
  }

  function commandIds() {
    return new Set(movements().map((movement) => movement.id));
  }

  function findResponseCommand(response) {
    const visited = new Set();
    function visit(value, depth = 0) {
      if (!value || depth > 6) return null;
      if (typeof value !== 'object') return null;
      if (visited.has(value)) return null;
      visited.add(value);
      const commandId = value.command_id ?? value.commandId;
      const arrival = value.arrival_at_ms ?? value.arrival_at ?? value.arrival_time;
      if (commandId) return { id: String(commandId), arrivalAt: timestampMs(arrival) };
      for (const child of Object.values(value)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    return visit(response);
  }

  async function waitForMovement(beforeIds, command, sendStartedAt, response, timeoutMs = CONFIG.commandResolveTimeoutMs) {
    const direct = findResponseCommand(response);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates = movements().filter((movement) => (
        !beforeIds.has(movement.id)
        && !movement.returning
        && movement.type === command.canonicalType
        && movement.originTownId === command.originTownId
        && movement.targetTownId === command.targetTownId
        && (!movement.startedAt || movement.startedAt >= sendStartedAt - 5_000)
      ));
      if (direct?.id) {
        const exact = candidates.find((movement) => movement.id === direct.id);
        if (exact) return exact;
        if (direct.arrivalAt) return { id: direct.id, arrivalAt: direct.arrivalAt };
      }
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) throw new Error('Mais de um movimento novo corresponde ao envio.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Comando enviado não apareceu nos movimentos.');
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, number(ms))));
  }

  async function cancelAttempt(job, movement) {
    const cancelStartedAt = serverNowMs();
    await ajax('ajaxPost', 'command_info', 'cancel_command', {
      id: integer(movement.id),
      town_id: integer(job.command.originTownId)
    }, 5_000);
    const cancelFinishedAt = serverNowMs();
    log('info', 'Tentativa cancelada; spam serial retomado.', {
      commandId: job.id,
      movementId: movement.id,
      actualArrivalAt: movement.arrivalAt,
      desiredArrivalAt: job.desiredArrivalAt
    });
    return {
      cancelStartedAt,
      cancelFinishedAt,
      cancelRttMs: cancelFinishedAt - cancelStartedAt
    };
  }

  async function measurePreview(command) {
    const action = command.canonicalType === 'support' ? 'support' : 'attack';
    const started = performance.now();
    const response = await ajax('ajaxGet', 'town_info', action, {
      id: integer(command.targetTownId),
      town_id: integer(command.originTownId),
      nl_init: true
    });
    const rttMs = performance.now() - started;
    validatePreview(command, response);
    return { response, rttMs };
  }

  function updateJob(id, changes) {
    state.jobs[id] = { ...state.jobs[id], ...changes, updatedAt: Date.now() };
    persist();
    renderPanel();
  }

  function jobWasEdited(job) {
    const latest = state.jobs[job.id];
    return Boolean(latest?.fingerprint && latest.fingerprint !== job.fingerprint);
  }

  function appendAttemptRecord(id, record) {
    const history = Array.isArray(state.jobs[id]?.attemptHistory)
      ? state.jobs[id].attemptHistory.slice(-99)
      : [];
    updateJob(id, { attemptHistory: [...history, record] });
  }

  async function preflightJob(job) {
    if (job.status !== 'pending') return;
    updateJob(job.id, { status: 'preflight', error: '' });
    try {
      if (!ownsLease()) throw new Error('Outra tab controla este mundo.');
      const currentCommands = await fetchPlannedCommands();
      const currentCommand = currentCommands.find((command) => command.id === job.id);
      if (!currentCommand) {
        updateJob(job.id, { status: 'cancelled', error: 'removed-from-planner' });
        return;
      }
      const currentTimes = plannedTimes(currentCommand, state.settings);
      updateJob(job.id, {
        command: currentCommand,
        fingerprint: commandFingerprint(currentCommand),
        ...currentTimes
      });
      job = state.jobs[job.id];
      if (!ownTownIds().has(job.command.originTownId)) throw new Error('Cidade de origem não pertence ao jogador.');
      await synchronizeServerClock();
      const samples = [];
      let response = null;
      for (let index = 0; index < 3; index += 1) {
        const measured = await measurePreview(job.command);
        response = measured.response;
        samples.push(measured.rttMs);
        if (index < 2) await new Promise((resolve) => setTimeout(resolve, 120));
      }
      const rttMs = median(samples);
      state.rttSamples = [...state.rttSamples, ...samples].slice(-12);
      if (rttMs > CONFIG.maximumRttMs) throw new Error(`Latência excessiva (${Math.round(rttMs)} ms).`);
      if (serverNowMs() >= job.dispatchAt + CONFIG.timingCorrectionWindowMs) {
        updateJob(job.id, { status: 'expired', error: 'preflight-finished-late' });
        return;
      }
      if (state.jobs[job.id]?.status !== 'preflight') return;
      updateJob(job.id, {
        status: 'ready',
        rttMs,
        releaseAt: job.dispatchAt - CONFIG.attemptLeadMs,
        previewValidatedAt: Date.now(),
        previewTargetId: String(responseJson(response)?.target_id || job.command.targetTownId)
      });
    } catch (error) {
      updateJob(job.id, { status: 'failed', error: error.message || String(error) });
      log('error', 'Pré-validação falhou.', { commandId: job.id, error: error.message });
    }
  }

  async function sendJob(job) {
    if (job.status !== 'ready' || activeSends >= CONFIG.maximumParallel) return;
    if (!ownsLease()) return;
    const now = serverNowMs();
    if (now > job.dispatchAt + CONFIG.timingCorrectionWindowMs) {
      updateJob(job.id, { status: 'expired', error: 'attempt-window-passed' });
      return;
    }
    activeSends += 1;
    updateJob(job.id, { status: 'sending', sendStartedAt: now, error: '' });
    try {
      while (ownsLease() && state.armed && !stopRequested) {
        if (jobWasEdited(job)) {
          updateJob(job.id, { status: 'pending', error: '' });
          break;
        }
        if (serverNowMs() > job.dispatchAt + CONFIG.timingCorrectionWindowMs) {
          updateJob(job.id, { status: 'failed', error: 'target-second-missed' });
          break;
        }
        if (number(state.jobs[job.id]?.failedAttempts) >= CONFIG.maximumFailedAttempts) {
          updateJob(job.id, { status: 'failed', error: 'maximum-failed-attempts' });
          break;
        }
        const beforeIds = commandIds();
        const sendStartedAt = serverNowMs();
        const attempts = number(state.jobs[job.id]?.attempts) + 1;
        updateJob(job.id, {
          status: 'sending',
          sendStartedAt,
          sendResponseAt: 0,
          sendRttMs: 0,
          actualArrivalAt: 0,
          deviationMs: null,
          cancelStartedAt: 0,
          cancelFinishedAt: 0,
          cancelRttMs: 0,
          diagnosticOutcome: 'pedido-enviado',
          attempts,
          error: ''
        });
        let response = null;
        let sendError = null;
        try {
          response = await ajax('ajaxPost', 'town_info', 'send_units', buildSendPayload(job.command), 5_000);
        } catch (error) {
          sendError = error;
        }
        const sendResponseAt = serverNowMs();
        updateJob(job.id, {
          sendResponseAt,
          sendRttMs: sendResponseAt - sendStartedAt,
          diagnosticOutcome: 'resposta-recebida'
        });
        const direct = findResponseCommand(response);
        let movement = null;
        try {
          movement = await waitForMovement(
            beforeIds,
            job.command,
            sendStartedAt,
            response,
            direct?.id ? CONFIG.commandResolveTimeoutMs : 750
          );
        } catch (error) {
          if (direct?.id || !String(error.message).includes('não apareceu nos movimentos')) throw error;
        }
        if (sendError && movement) {
          log('warn', 'Resposta de envio ambígua reconciliada pelo movimento criado.', {
            commandId: job.id,
            movementId: movement.id,
            error: sendError.message || String(sendError)
          });
        }
        if (jobWasEdited(job)) {
          if (movement) {
            const cancellation = await cancelAttempt(job, movement);
            appendAttemptRecord(job.id, {
              attempt: attempts,
              movementId: movement.id,
              requestAt: sendStartedAt,
              responseAt: sendResponseAt,
              sendRttMs: sendResponseAt - sendStartedAt,
              arrivalAt: movement.arrivalAt,
              cancelRttMs: cancellation.cancelRttMs,
              result: 'CANCELADO-APÓS-EDIÇÃO'
            });
          }
          updateJob(job.id, { status: 'pending', error: '' });
          break;
        }
        if (stopRequested || !state.armed) {
          if (movement) {
            try {
              const cancellation = await cancelAttempt(job, movement);
              appendAttemptRecord(job.id, {
                attempt: attempts,
                movementId: movement.id,
                requestAt: sendStartedAt,
                responseAt: sendResponseAt,
                sendRttMs: sendResponseAt - sendStartedAt,
                arrivalAt: movement.arrivalAt,
                cancelRttMs: cancellation.cancelRttMs,
                result: 'CANCELADO-MANUAL'
              });
            } catch (error) {
              updateJob(job.id, { status: 'failed', error: `manual-cancel-failed:${error.message || error}` });
              throw error;
            }
          }
          updateJob(job.id, { status: 'cancelled', error: 'manual-disarm' });
          break;
        }
        if (!movement) {
          const failedAttempts = number(state.jobs[job.id]?.failedAttempts) + 1;
          updateJob(job.id, {
            failedAttempts,
            diagnosticOutcome: 'rejeitado-sem-movimento',
            error: `envio-rejeitado-${failedAttempts}/${CONFIG.maximumFailedAttempts}${sendError ? `:${sendError.message || sendError}` : ''}`
          });
          appendAttemptRecord(job.id, {
            attempt: attempts,
            requestAt: sendStartedAt,
            responseAt: sendResponseAt,
            sendRttMs: sendResponseAt - sendStartedAt,
            result: 'REJEITADO'
          });
          await delay(CONFIG.spamGapMs);
          continue;
        }
        const timing = arrivalResult(movement.arrivalAt, job.desiredArrivalAt, job.toleranceSeconds);
        updateJob(job.id, {
          movementId: movement.id,
          actualArrivalAt: movement.arrivalAt,
          deviationMs: timing.deviationMs,
          timingAccepted: timing.accepted,
          lastMovementRequestAt: sendStartedAt,
          lastMovementResponseAt: sendResponseAt,
          lastMovementSendRttMs: sendResponseAt - sendStartedAt,
          lastMovementArrivalAt: movement.arrivalAt,
          lastMovementDeviationMs: timing.deviationMs,
          lastMovementOutcome: timing.accepted ? 'aceite' : (timing.retry ? 'cedo' : 'tarde'),
          diagnosticOutcome: timing.accepted ? 'aceite' : (timing.retry ? 'cedo' : 'tarde')
        });
        if (timing.accepted) {
          appendAttemptRecord(job.id, {
            attempt: attempts,
            movementId: movement.id,
            requestAt: sendStartedAt,
            responseAt: sendResponseAt,
            sendRttMs: sendResponseAt - sendStartedAt,
            arrivalAt: movement.arrivalAt,
            deviationMs: timing.deviationMs,
            result: 'MANTIDO'
          });
          const confirmedIds = new Set(state.confirmedIds);
          confirmedIds.add(job.id);
          state.confirmedIds = [...confirmedIds].slice(-1_000);
          const confirmedFingerprints = new Set(state.confirmedFingerprints);
          confirmedFingerprints.add(job.fingerprint || commandFingerprint(job.command));
          state.confirmedFingerprints = [...confirmedFingerprints].slice(-1_000);
          updateJob(job.id, { status: 'confirmed', error: '' });
          page.$?.Observer?.(page.GameEvents?.command?.send_unit)?.publish?.({
            sending_type: job.command.canonicalType,
            target_id: integer(job.command.targetTownId),
            params: buildSendPayload(job.command)
          });
          log('info', 'Comando confirmado no segundo exato.', {
            commandId: job.id,
            movementId: movement.id,
            attempts
          });
          break;
        }
        let cancellation = null;
        try {
          cancellation = await cancelAttempt(job, movement);
        } catch (error) {
          appendAttemptRecord(job.id, {
            attempt: attempts,
            movementId: movement.id,
            requestAt: sendStartedAt,
            responseAt: sendResponseAt,
            sendRttMs: sendResponseAt - sendStartedAt,
            arrivalAt: movement.arrivalAt,
            deviationMs: timing.deviationMs,
            result: 'CANCELAMENTO-FALHOU'
          });
          throw error;
        }
        appendAttemptRecord(job.id, {
          attempt: attempts,
          movementId: movement.id,
          requestAt: sendStartedAt,
          responseAt: sendResponseAt,
          sendRttMs: sendResponseAt - sendStartedAt,
          arrivalAt: movement.arrivalAt,
          deviationMs: timing.deviationMs,
          cancelRttMs: cancellation.cancelRttMs,
          result: 'CANCELADO'
        });
        updateJob(job.id, { ...cancellation, lastMovementCancelRttMs: cancellation.cancelRttMs });
        const calibratedAt = calibratedAttemptAt(
          sendStartedAt,
          timing.deviationMs,
          job.toleranceSeconds
        );
        updateJob(job.id, { calibratedAt, error: '' });
        log('info', 'Referência calibrada registada; retry mantido até ao fim da janela.', {
          commandId: job.id,
          deviationMs: timing.deviationMs,
          toleranceSeconds: job.toleranceSeconds,
          calibratedAt
        });
        await delay(CONFIG.spamGapMs);
      }
      if ((stopRequested || !state.armed) && state.jobs[job.id]?.status === 'sending') {
        updateJob(job.id, { status: 'cancelled', error: 'manual-disarm' });
      }
    } catch (error) {
      updateJob(job.id, { status: 'failed', error: error.message || 'retry-loop-failed' });
      log('error', 'Ciclo interrompido para evitar comando duplicado.', {
        commandId: job.id,
        error: error.message
      });
    } finally {
      activeSends = Math.max(0, activeSends - 1);
      finishIfDone();
      renderPanel();
    }
  }

  function finishIfDone() {
    const jobs = Object.values(state.jobs);
    if (!state.armed || !jobs.length || jobs.some((job) => !isTerminal(job))) return;
    state.armed = false;
    persist();
    const failed = jobs.filter((job) => job.status === 'failed');
    if (failed.length) {
      log('warn', 'Colagem terminou com falhas.', { failed: failed.length });
      notify(`Colagem terminou com ${failed.length} falha(s). Reveja os comandos no Planeador.`);
    } else {
      log('info', 'Colagem desarmada: não existem comandos válidos pendentes.');
      notify('Colagem concluída. Não existem comandos pendentes.', 'success');
    }
  }

  async function syncPlans() {
    if (!state?.armed || !ownsLease()) return;
    try {
      const commands = await fetchPlannedCommands();
      state.jobs = reconcileCapturedJobs({
        jobs: state.jobs,
        capturedIds: state.capturedIds,
        commands,
        offsets: state.settings,
        now: serverNowMs()
      });
      persist();
      finishIfDone();
      renderPanel();
    } catch (error) {
      log('warn', 'Não foi possível actualizar o Planeador.', { error: error.message });
    }
  }

  async function arm() {
    if (state.armed) return;
    if (activeSends > 0) {
      notify('Aguarde: cancelamento do comando em curso ainda não terminou.');
      return;
    }
    try {
      stopRequested = false;
      await synchronizeServerClock();
      const commands = await fetchPlannedCommands();
      const confirmed = new Set(state.confirmedFingerprints);
      const captured = commands.filter((command) => !confirmed.has(commandFingerprint(command)));
      state.capturedIds = captured.map((command) => command.id);
      state.jobs = reconcileCapturedJobs({
        jobs: {},
        capturedIds: state.capturedIds,
        commands,
        offsets: state.settings,
        now: serverNowMs()
      });
      const pending = Object.values(state.jobs).filter((job) => !isTerminal(job));
      state.armed = pending.length > 0;
      persist();
      if (!state.armed) {
        notify('Nenhum comando planeado futuro e ainda não enviado.');
        return;
      }
      acquireLease();
      log('info', 'Colagem automática armada.', { commands: pending.length, offsets: state.settings });
      notify(`Colagem armada: ${pending.length} comando(s).`, 'success');
      scheduleTick(0);
    } catch (error) {
      log('error', 'Não foi possível armar a colagem.', { error: error.message });
      notify(`Falha ao armar: ${error.message}`);
    }
  }

  function disarm() {
    if (!state.armed) return;
    stopRequested = true;
    state.armed = false;
    for (const job of Object.values(state.jobs)) {
      if (!isTerminal(job)) {
        if (job.status === 'sending') job.error = 'manual-stop-requested';
        else {
          job.status = 'cancelled';
          job.error = 'manual-disarm';
        }
      }
    }
    persist();
    log('info', 'Colagem desarmada manualmente.');
    renderPanel();
  }

  function nextDelay(now) {
    const active = Object.values(state.jobs).filter((job) => !isTerminal(job));
    if (!active.length) return 1_000;
    const nearest = Math.min(...active.map((job) => (
      job.status === 'ready' ? number(job.releaseAt, job.dispatchAt) : job.dispatchAt - CONFIG.preflightLeadMs
    )));
    const remaining = nearest - now;
    if (remaining <= 2_000) return 10;
    if (remaining <= 15_000) return 50;
    return 250;
  }

  function scheduleTick(delay) {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, delay);
  }

  function tick() {
    if (stopped || !state?.armed) return scheduleTick(1_000);
    renewLease();
    if (!ownsLease()) return scheduleTick(250);
    const now = serverNowMs();
    const jobs = Object.values(state.jobs).sort((left, right) => left.dispatchAt - right.dispatchAt);
    for (const job of jobs) {
      if (isTerminal(job) || job.status === 'sending' || job.status === 'preflight') continue;
      if (now >= job.dispatchAt + CONFIG.timingCorrectionWindowMs) {
        updateJob(job.id, { status: 'expired', error: 'dispatch-time-passed' });
        continue;
      }
      if (job.status === 'pending' && now >= job.dispatchAt - CONFIG.preflightLeadMs) {
        void preflightJob(job);
      } else if (job.status === 'ready' && now >= job.releaseAt && activeSends < CONFIG.maximumParallel) {
        void sendJob(job);
      }
    }
    finishIfDone();
    scheduleTick(nextDelay(now));
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) return;
    const button = panel.querySelector('[data-gcp-toggle]');
    if (button) {
      const stopping = stopRequested && activeSends > 0;
      button.textContent = stopping ? 'A parar…' : (state.armed ? 'Cancelar' : 'Activar');
      button.disabled = stopping;
      button.classList.toggle('gcp-armed', state.armed);
    }
    panel.querySelectorAll('[data-gcp-offset]').forEach((input) => { input.disabled = state.armed; });
  }

  function saveSettingsFromPanel(panel) {
    const seconds = (type) => Math.min(15, Math.max(0,
      signedInteger(panel.querySelector(`[data-gcp-offset="${type}"]`)?.value)
    ));
    state.settings = {
      attack: seconds('attack'),
      support: seconds('support'),
      nc: seconds('nc')
    };
    persist();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .attack_planner.attacks.gcp-panel-host{position:relative}
      #${PANEL_ID}{position:absolute;z-index:5;top:6px;left:9px;height:28px;margin:0;padding:0;color:#2b1a0b;font-size:12px;display:flex;align-items:center;gap:9px;white-space:nowrap}
      #${PANEL_ID}[hidden]{display:none!important}
      #${PANEL_ID} label{display:flex;align-items:center;gap:4px;font-weight:bold}
      #${PANEL_ID} select{width:52px;height:22px;box-sizing:border-box}
      #${PANEL_ID} button{min-width:105px;height:27px;cursor:pointer;font-weight:bold}
      #${PANEL_ID} button.gcp-armed{background:#8b1e16;color:#fff}
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    const options = Array.from({ length: 16 }, (_, value) => `<option value="${value}">${value}</option>`).join('');
    panel.innerHTML = `
      <label>Ataque <select data-gcp-offset="attack">${options}</select>s</label>
      <label>Apoio <select data-gcp-offset="support">${options}</select>s</label>
      <label>NC <select data-gcp-offset="nc">${options}</select>s</label>
      <button type="button" data-gcp-toggle></button>
    `;
    for (const type of ['attack', 'support', 'nc']) {
      const input = panel.querySelector(`[data-gcp-offset="${type}"]`);
      input.value = String(state.settings[type]);
      input.addEventListener('change', () => saveSettingsFromPanel(panel));
    }
    panel.querySelector('[data-gcp-toggle]').addEventListener('click', () => {
      saveSettingsFromPanel(panel);
      if (state.armed) disarm();
      else void arm();
    });
    return panel;
  }

  function scanPlanner() {
    const existingPanel = document.getElementById(PANEL_ID);
    const planner = document.querySelector('.gpwindow_content .attack_planner.attacks');
    if (!planner) {
      if (existingPanel) existingPanel.hidden = true;
      return;
    }
    injectStyle();
    document.querySelectorAll('.gpwindow_content.gcp-panel-host').forEach((node) => node.classList.remove('gcp-panel-host'));
    planner.classList.add('gcp-panel-host');
    if (existingPanel) {
      existingPanel.hidden = false;
      if (existingPanel.parentElement !== planner) planner.insertBefore(existingPanel, planner.firstChild);
    } else {
      planner.insertBefore(createPanel(), planner.firstChild);
    }
    renderPanel();
  }

  function initialize() {
    const worldId = String(page.Game?.world_id || location.hostname.split('.')[0] || 'world');
    const playerId = String(page.Game?.player_id || 'player');
    namespace = `${worldId}:${playerId}`;
    storageKey = `gcp:state:${namespace}`;
    leaseKey = `gcp:lease:${namespace}`;
    state = loadState();
    acquireLease();
    scanPlanner();
    leaseTimer = setInterval(renewLease, CONFIG.leaseHeartbeatMs);
    refreshTimer = setInterval(() => void syncPlans(), CONFIG.plannerRefreshMs);
    uiTimer = setInterval(() => {
      scanPlanner();
      renderPanel();
    }, 500);
    if (state.armed) void syncPlans();
    scheduleTick(50);
    window.addEventListener('beforeunload', () => {
      stopped = true;
      clearTimeout(tickTimer);
      clearInterval(refreshTimer);
      clearInterval(leaseTimer);
      clearInterval(uiTimer);
      releaseLease();
    }, { once: true });
  }

  let attempts = 0;
  const waitForGame = setInterval(() => {
    attempts += 1;
    if (page.Game?.world_id && page.Game?.player_id && page.gpAjax) {
      clearInterval(waitForGame);
      initialize();
    } else if (attempts >= 120) {
      clearInterval(waitForGame);
      console.error('[GCP] APIs do Grepolis indisponíveis.');
    }
  }, 500);
}());
