// ==UserScript==
// @name         Grepolis — Informação de Ataques e NC
// @namespace    https://grepolis.com/
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-attack-info.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-attack-info.user.js
// @version      1.0.3
// @description  Mostra duração, hora de envio e deteção cega de navios colonizadores.
// @author       Codex
// @match        https://*.grepolis.com/game/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisAttackInfoFactory() {
  'use strict';

  const VERSION = '1.0.3';
  const SENT_STORAGE_KEY = 'gai.sent.v1';
  const OVERLAY_ID = 'gai-overlay-layer';
  const MAX_SENT_RECORDS = 250;
  const SENT_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
  const NC_TOLERANCE_MS = 11_000;
  const SCAN_INTERVAL_MS = 1_000;
  const SLOT_LEFT_RATIO = 0.35;
  const SLOT_RIGHT_RATIO = 0.125;
  const SLOT_HEIGHT_PX = 18;

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function integer(value, fallback = 0) {
    return Math.max(0, Math.floor(number(value, fallback)));
  }

  function timestampMs(value) {
    const parsed = number(value);
    if (!parsed) return 0;
    return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  }

  function read(source, names, fallback = '') {
    const attributes = source?.attributes || source || {};
    for (const name of names) {
      const value = attributes[name] ?? source?.[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  }

  function plainText(value) {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function canonicalType(value) {
    const text = String(value || '').toLowerCase();
    if (/spy|espion/.test(text)) return 'spy';
    if (/support|apoio|refor/.test(text)) return 'support';
    if (/attack|ataque|revolt|colon|conquer|takeover/.test(text)) return 'attack';
    return 'unknown';
  }

  function rawObject(value) {
    if (value?.attributes) return value.attributes;
    if (typeof value?.toJSON === 'function') {
      try { return value.toJSON() || {}; } catch { return {}; }
    }
    return value || {};
  }

  function positiveUnitValue(value) {
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[^\d.-]/g, ''));
      return Number.isFinite(parsed) ? parsed > 0 : /true|yes|sim/i.test(value);
    }
    if (!value || typeof value !== 'object') return false;
    return ['count', 'amount', 'number', 'value', 'units'].some((key) => positiveUnitValue(value[key]));
  }

  function hasPositiveUnit(value, unitPattern, visited = new Set(), depth = 0) {
    if (!value || depth > 8 || typeof value !== 'object' || visited.has(value)) return false;
    visited.add(value);
    return Object.entries(value).some(([key, child]) => (
      unitPattern.test(String(key).toLowerCase())
        ? positiveUnitValue(child) || positiveUnitValue(value)
        : hasPositiveUnit(child, unitPattern, visited, depth + 1)
    ));
  }

  function hasColonizeShip(value) {
    return hasPositiveUnit(
      value,
      /colonize[_-]?ship|colony[_-]?ship|colonisation[_-]?ship|colonization[_-]?ship/
    );
  }

  function isExplicitNcType(value) {
    return /colon|conquer|takeover|revolt/.test(String(value || '').toLowerCase());
  }

  function explicitNcEvidence(raw, rawType) {
    if (hasColonizeShip(raw)) return 'colonize_ship';
    if (isExplicitNcType(rawType)) return 'command_type';
    let text = '';
    try { text = JSON.stringify(raw || {}).toLowerCase(); } catch { text = ''; }
    if (/colonize[_-]?ship|colony[_-]?ship|coloniz|takeover|conquer|conquest/.test(text)) {
      return 'raw_fields';
    }
    return '';
  }

  function isReturning(raw) {
    const direction = String(read(raw, ['direction', 'movement_direction', 'status'], '')).toLowerCase();
    return Boolean(read(raw, ['is_returning', 'returning', 'is_return'], false))
      || /return|regress/.test(direction);
  }

  function normalizeMovement(source, now = Date.now()) {
    const raw = rawObject(source);
    const rawType = String(read(raw, [
      'command_type', 'type', 'movement_type', 'attack_type', 'name'
    ], ''));
    const id = String(read(raw, ['command_id', 'commandId', 'id', 'model_id'], ''));
    const rawStarted = read(raw, [
      'started_at_ms', 'started_at', 'start_at', 'sent_at_ms', 'sent_at',
      'send_at_ms', 'send_at', 'created_at', 'startedAt', 'start_time', 'send_time'
    ]);
    const rawArrival = read(raw, [
      'arrival_at_ms', 'arrival_at', 'arrivalAt', 'arrival_time_ms',
      'arrival_time', 'finished_at', 'end_at'
    ]);
    const originTownId = String(read(raw, [
      'origin_town_id', 'home_town_id', 'originTownId', 'source_town_id', 'from_town_id'
    ], ''));
    const targetTownId = String(read(raw, [
      'target_town_id', 'targetTownId', 'destination_town_id', 'destination_id', 'town_id'
    ], ''));
    return {
      id,
      type: canonicalType(rawType),
      rawType,
      originTownId,
      targetTownId,
      origin: String(read(raw, [
        'origin_town_name', 'home_town_name', 'town_name_origin', 'source_town_name', 'origin_name', 'origin'
      ], '')),
      target: String(read(raw, [
        'target_town_name', 'town_name_destination', 'destination_town_name', 'target_name', 'target'
      ], '')),
      playerId: String(read(raw, ['player_id', 'origin_player_id', 'home_player_id'], '')),
      startedAt: timestampMs(rawStarted),
      arrivalAt: timestampMs(rawArrival) || now,
      returning: isReturning(raw),
      explicitNc: explicitNcEvidence(raw, rawType),
      raw
    };
  }

  function calibratedServerTime(rawServer, perfNow, state = {}) {
    const parsed = number(rawServer);
    if (!parsed) return { now: 0, state };
    if (parsed >= 10_000_000_000 || !Number.isInteger(parsed)) {
      return { now: timestampMs(parsed), state };
    }
    const second = integer(parsed);
    const changed = second !== state.second;
    const next = (changed || !state.epochMs)
      ? { second, epochMs: second * 1_000, perfMs: number(perfNow) }
      : state;
    return {
      now: next.epochMs + Math.max(0, number(perfNow) - next.perfMs),
      state: next
    };
  }

  function formatDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(Number(totalSeconds))) {
      return 'indisponível';
    }
    const safe = Math.max(0, Math.round(Number(totalSeconds)));
    const hours = Math.floor(safe / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    const seconds = safe % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  function formatClock(timestamp) {
    if (!timestamp) return 'indisponível';
    return new Date(timestamp).toLocaleTimeString('pt-PT', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function durationBetween(sentAt, arrivalAt) {
    const start = number(sentAt);
    const end = number(arrivalAt);
    if (!start || !end || end <= start) return null;
    return end - start;
  }

  function normalizeSentRecord(record) {
    return {
      id: String(record?.id || ''),
      type: canonicalType(record?.type || record?.sending_type || 'attack'),
      originTownId: String(record?.originTownId || record?.origin_town_id || record?.town_id || ''),
      targetTownId: String(record?.targetTownId || record?.target_town_id || record?.target_id || ''),
      sentAt: timestampMs(record?.sentAt || record?.sent_at || record?.started_at),
      capturedAt: timestampMs(record?.capturedAt || record?.captured_at) || Date.now(),
      explicitNc: Boolean(record?.explicitNc || hasColonizeShip(record?.raw || record?.params))
    };
  }

  function pruneSentRecords(records, now = Date.now()) {
    return records
      .map(normalizeSentRecord)
      .filter((record) => record.sentAt && now - record.capturedAt <= SENT_RECORD_TTL_MS)
      .slice(-MAX_SENT_RECORDS);
  }

  function rememberSentRecord(records, record, now = Date.now()) {
    const next = pruneSentRecords(records, now);
    const normalized = normalizeSentRecord({ ...record, capturedAt: now });
    if (!normalized.sentAt) return next;
    const fingerprint = [
      normalized.id, normalized.type, normalized.originTownId,
      normalized.targetTownId, normalized.sentAt
    ].join(':');
    const withoutDuplicate = next.filter((item) => [
      item.id, item.type, item.originTownId, item.targetTownId, item.sentAt
    ].join(':') !== fingerprint);
    return [...withoutDuplicate, normalized].slice(-MAX_SENT_RECORDS);
  }

  function sentRecordMatches(record, movement) {
    if (record.type !== 'attack' || movement.type !== 'attack') return false;
    if (record.id && movement.id && record.id === movement.id) return true;
    return Boolean(
      record.originTownId && movement.originTownId
      && record.targetTownId && movement.targetTownId
      && record.originTownId === movement.originTownId
      && record.targetTownId === movement.targetTownId
    );
  }

  function findSentRecord(records, movement, now = Date.now()) {
    return pruneSentRecords(records, now)
      .filter((record) => sentRecordMatches(record, movement))
      .filter((record) => !movement.arrivalAt || record.sentAt < movement.arrivalAt + 2_000)
      .sort((left, right) => right.sentAt - left.sentAt)[0] || null;
  }

  function extractCoordinates(source, prefix = '') {
    const raw = rawObject(source);
    const prefixText = prefix ? `${prefix}_` : '';
    const x = read(raw, [
      `${prefixText}island_x`, `${prefixText}x`, `${prefix}IslandX`, `${prefix}X`,
      `${prefix}_coord_x`, `${prefix}_coordinate_x`
    ]);
    const y = read(raw, [
      `${prefixText}island_y`, `${prefixText}y`, `${prefix}IslandY`, `${prefix}Y`,
      `${prefix}_coord_y`, `${prefix}_coordinate_y`
    ]);
    if (x === '' || y === '' || x === undefined || y === undefined) return null;
    const parsedX = number(x, Number.NaN);
    const parsedY = number(y, Number.NaN);
    return Number.isFinite(parsedX) && Number.isFinite(parsedY)
      ? { x: parsedX, y: parsedY }
      : null;
  }

  function townDistance(origin, target) {
    if (!origin || !target) return null;
    return Math.hypot(number(origin.x) - number(target.x), number(origin.y) - number(target.y));
  }

  function buildSpeedProfiles({ maxSirens = 50 } = {}) {
    const profiles = new Set([1]);
    const navalBonuses = [0.10, 0.15, 0.10];
    const atlantas = [0, 0.132, 0.36];
    const sirenLimit = Math.max(0, integer(maxSirens));

    for (const atlantasBonus of atlantas) {
      for (let mask = 0; mask < (1 << navalBonuses.length); mask += 1) {
        const selected = navalBonuses.filter((_, index) => mask & (1 << index));
        const additive = atlantasBonus + selected.reduce((sum, bonus) => sum + bonus, 0);
        const multiplicative = selected.reduce((product, bonus) => product * (1 + bonus), 1) * (1 + atlantasBonus);
        for (let sirens = 0; sirens <= sirenLimit; sirens += 1) {
          const sirenBonus = Math.min(1, sirens * 0.02);
          profiles.add(Number((1 + additive + sirenBonus).toFixed(6)));
          profiles.add(Number((multiplicative * (1 + sirenBonus)).toFixed(6)));
        }
      }
    }
    return [...profiles].sort((left, right) => left - right);
  }

  function calculateNcDurations({
    distance,
    unitSpeed = 1,
    colonySpeed = 3,
    profiles = buildSpeedProfiles(),
    escortSpeeds = [3, 2],
    meteorology = [1, 1.1],
    baseTravelSeconds = 900,
    distanceFactor = 50
  } = {}) {
    const safeDistance = Math.max(0, number(distance));
    const worldSpeed = Math.max(0.01, number(unitSpeed, 1));
    const safeColonySpeed = Math.max(0.01, number(colonySpeed, 3));
    const durations = new Set();
    for (const profile of profiles || [1]) {
      for (const escortSpeed of escortSpeeds || [3]) {
        for (const landModifier of meteorology || [1]) {
          const navalSpeed = safeColonySpeed * Math.max(0.01, number(profile, 1));
          const landSpeed = Math.max(0.01, number(escortSpeed, 3)) * Math.max(0.01, number(landModifier, 1));
          const effectiveSpeed = Math.min(navalSpeed, landSpeed);
          const seconds = (
            baseTravelSeconds + safeDistance * distanceFactor / effectiveSpeed
          ) / worldSpeed;
          durations.add(Math.round(seconds * 1_000));
        }
      }
    }
    return [...durations].sort((left, right) => left - right);
  }

  function classifyNcAttack(movement, {
    sentAt = movement?.startedAt,
    expectedDurations = [],
    toleranceMs = NC_TOLERANCE_MS
  } = {}) {
    if (movement?.explicitNc) {
      return { isNc: true, confidence: 'explicit', deltaMs: 0, candidates: 1 };
    }
    const durationMs = durationBetween(sentAt, movement?.arrivalAt);
    if (!durationMs || !expectedDurations.length) {
      return { isNc: false, confidence: 'impossible', deltaMs: null, candidates: 0 };
    }
    const deltas = expectedDurations.map((expected) => Math.abs(durationMs - expected));
    const deltaMs = Math.min(...deltas);
    const candidates = deltas.filter((delta) => delta <= Math.max(0, number(toleranceMs))).length;
    if (deltaMs <= Math.max(0, number(toleranceMs))) {
      return { isNc: true, confidence: candidates > 1 ? 'duration-ambiguous' : 'duration', deltaMs, candidates };
    }
    return { isNc: false, confidence: 'no-match', deltaMs, candidates: 0 };
  }

  function buildDisplayModel(movement, sentAt, nc) {
    const durationMs = durationBetween(sentAt, movement?.arrivalAt);
    return {
      durationText: formatDuration(durationMs === null ? null : durationMs / 1_000),
      sentText: formatClock(sentAt),
      ncText: nc?.isNc ? 'NC Confirmado' : nc?.confidence === 'impossible' ? 'NC: impossível confirmar' : '',
      ncConfirmed: Boolean(nc?.isNc),
      ncConfidence: nc?.confidence || 'impossible'
    };
  }

  function eventToSentRecord(command, now, page) {
    const params = command?.params || command?.data || {};
    const type = canonicalType(command?.sending_type || command?.type || params.type);
    if (type !== 'attack') return null;
    const raw = { ...command, ...params };
    const targetTownId = String(read(raw, ['target_town_id', 'targetTownId', 'target_id', 'id'], ''));
    const originTownId = String(read(raw, [
      'origin_town_id', 'originTownId', 'town_id', 'source_town_id'
    ], page?.Game?.town_id ?? page?.Game?.townId ?? ''));
    const id = String(read(raw, ['command_id', 'commandId', 'movement_id'], ''));
    return {
      id,
      type,
      originTownId,
      targetTownId,
      sentAt: now,
      explicitNc: hasColonizeShip(raw),
      raw
    };
  }

  function normalizeTownName(value) {
    return plainText(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-PT');
  }

  function isIncomingAttack(movement, ownTownIds, now = Date.now(), ownTownNames = new Set()) {
    const explicitOwnTestAttack = movement?.explicitNc && /abort/.test(String(movement.rawType || '').toLowerCase());
    return (movement?.type === 'attack' || explicitOwnTestAttack)
      && !movement.returning
      && movement.arrivalAt > now - 30_000
      && (
        ownTownIds.has(String(movement.targetTownId))
        || (movement.target && ownTownNames.has(normalizeTownName(movement.target)))
      );
  }

  function parseWorldTowns(text) {
    return String(text || '').split(/\r?\n/).map((line) => {
      const parts = line.split(',');
      if (parts.length < 7) return null;
      const decode = (value) => {
        try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
        catch { return String(value || ''); }
      };
      const id = String(integer(parts[0]));
      if (id === '0') return null;
      return {
        id,
        name: decode(parts[2]),
        x: number(parts[3], Number.NaN),
        y: number(parts[4], Number.NaN)
      };
    }).filter((town) => town && Number.isFinite(town.x) && Number.isFinite(town.y));
  }

  function modelAttributes(model) {
    if (!model) return null;
    if (model.attributes) return model;
    if (typeof model.toJSON === 'function') return { id: model.id, attributes: model.toJSON() };
    return model;
  }

  function collectMovementModels(value, output, visited = new Set(), depth = 0) {
    if (!value || depth > 6 || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value.attributes || typeof value.toJSON === 'function') {
      output.push(modelAttributes(value));
      return;
    }
    if (Array.isArray(value.models)) {
      value.models.forEach((model) => output.push(modelAttributes(model)));
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      if (/movement|command/i.test(key)) collectMovementModels(child, output, visited, depth + 1);
    });
  }

  function appendMovementModels(value, output) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.models)) {
      value.models.forEach((model) => output.push(modelAttributes(model)));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((model) => output.push(modelAttributes(model)));
      return;
    }
    Object.values(value).forEach((model) => {
      if (model && typeof model === 'object' && (model.attributes || typeof model.toJSON === 'function')) {
        output.push(modelAttributes(model));
      }
    });
  }

  function movementModels(page) {
    const output = [];
    try {
      const direct = page.MM?.getModels?.()?.MovementsUnits;
      appendMovementModels(direct, output);
      if (!output.length) {
        appendMovementModels(page.MM?.getOnlyCollectionByName?.('MovementsUnits'), output);
      }
      if (!output.length) collectMovementModels(page.MM?.getModels?.(), output);
      if (!output.length) collectMovementModels(page.MM?.getCollections?.(), output);
    } catch { /* models are optional while game boots */ }
    const seen = new Set();
    return output.filter(Boolean).filter((model) => {
      const raw = rawObject(model);
      const id = String(read(raw, ['command_id', 'commandId', 'id', 'model_id'], model?.id || ''));
      let fallbackKey = '';
      if (!id) {
        try { fallbackKey = JSON.stringify(raw); } catch { fallbackKey = String(raw); }
      }
      const key = id || fallbackKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function ownTownIds(page) {
    const values = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    const ids = new Set();
    if (Array.isArray(values)) values.forEach((town) => ids.add(String(town?.getId?.() ?? town?.id ?? '')));
    else Object.entries(values || {}).forEach(([id, town]) => ids.add(String(town?.getId?.() ?? town?.id ?? id)));
    const current = page.ITowns?.getCurrentTown?.();
    if (current) ids.add(String(current.getId?.() ?? current.id ?? ''));
    ids.add(String(page.Game?.town_id ?? page.Game?.townId ?? ''));
    return new Set([...ids].filter(Boolean));
  }

  function ownTownNames(page) {
    const values = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    const names = new Set();
    const add = (town) => {
      const name = town?.getName?.() ?? town?.attributes?.name ?? town?.name;
      if (name) names.add(normalizeTownName(name));
    };
    if (Array.isArray(values)) values.forEach(add);
    else Object.values(values || {}).forEach(add);
    add(page.ITowns?.getCurrentTown?.());
    return names;
  }

  function ownTownCoordinates(page) {
    const result = new Map();
    const values = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    const list = Array.isArray(values) ? values : Object.entries(values || {}).map(([id, town]) => ({ id, ...town }));
    list.forEach((town) => {
      const id = String(town?.getId?.() ?? town?.id ?? '');
      const x = number(town?.getIslandCoordinateX?.() ?? town?.attributes?.island_x, Number.NaN);
      const y = number(town?.getIslandCoordinateY?.() ?? town?.attributes?.island_y, Number.NaN);
      if (id && Number.isFinite(x) && Number.isFinite(y)) result.set(id, { x, y });
    });
    return result;
  }

  const Core = {
    VERSION,
    NC_TOLERANCE_MS,
    timestampMs,
    canonicalType,
    normalizeMovement,
    formatDuration,
    formatClock,
    durationBetween,
    explicitNcEvidence,
    hasColonizeShip,
    calibratedServerTime,
    normalizeSentRecord,
    pruneSentRecords,
    rememberSentRecord,
    sentRecordMatches,
    findSentRecord,
    extractCoordinates,
    townDistance,
    buildSpeedProfiles,
    calculateNcDurations,
    classifyNcAttack,
    buildDisplayModel,
    eventToSentRecord,
    isIncomingAttack,
    parseWorldTowns
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || !window.document) return;

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const ownerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let serverClockState = {};
  let worldTownsPromise = null;
  let scanTimer = 0;
  let scheduledScan = 0;
  let scanning = false;
  let subscribed = false;

  function loadSentRecords() {
    try {
      const value = typeof GM_getValue === 'function'
        ? GM_getValue(SENT_STORAGE_KEY, [])
        : JSON.parse(localStorage.getItem(SENT_STORAGE_KEY) || '[]');
      return Array.isArray(value) ? pruneSentRecords(value, serverNowMs()) : [];
    } catch { return []; }
  }

  function saveSentRecords(records) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(SENT_STORAGE_KEY, records);
      else localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(records));
    } catch { /* local persistence is optional */ }
  }

  function serverNowMs() {
    try {
      const result = calibratedServerTime(page.Timestamp?.server?.(), performance.now(), serverClockState);
      serverClockState = result.state;
      if (result.now) return result.now;
    } catch { /* browser clock fallback */ }
    return Date.now();
  }

  function readCommands() {
    const now = serverNowMs();
    const stored = loadSentRecords();
    const movements = movementModels(page)
      .map((model) => normalizeMovement(model, now))
      .filter((movement) => movement.id || movement.arrivalAt);
    return { now, stored, movements };
  }

  function readRows() {
    const selectors = [
      '#toolbar_activity_commands_list .command',
      '.activity.commands .command',
      '.command_list .command',
      '#command_overview .command',
      '#command_overview .command_row',
      '#command_overview .command_overview_command',
      '#command_overview > li.js-command-row',
      '#command_overview > li.place_command',
      '.js-command-row.place_command',
      '.command_overview .command',
      '[data-command_id]',
      '[data-command-id]'
    ];
    return [...document.querySelectorAll(selectors.join(','))].filter(rowIsVisible);
  }

  function rowId(row) {
    return String(
      row.getAttribute('data-command_id')
      || row.getAttribute('data-command-id')
      || row.dataset?.commandId
      || String(row.id || '').replace(/^command_/, '')
      || ''
    );
  }

  function findRow(rows, movement) {
    const exact = rows.find((row) => rowId(row) && movement.id && rowId(row) === movement.id);
    if (exact) return exact;
    const movementOrigin = normalizeTownName(movement.origin);
    const movementTarget = normalizeTownName(movement.target);
    const text = plainText(rows.map((row) => row.textContent || '').join(' '));
    if (rows.length === 1 && text && !movement.id && !movement.originTownId && !movement.targetTownId
      && !movementOrigin && !movementTarget) return rows[0];
    return rows.find((row) => {
      const rowText = normalizeTownName(row.textContent || '');
      const rowOriginId = row.getAttribute('data-origin_town_id') || row.getAttribute('data-origin-town-id') || '';
      const rowTargetId = row.getAttribute('data-target_town_id') || row.getAttribute('data-target-town-id') || '';
      const idsMatch = movement.originTownId && movement.targetTownId
        && rowOriginId === movement.originTownId
        && rowTargetId === movement.targetTownId;
      const namesMatch = movementOrigin && movementTarget
        && rowText.includes(movementOrigin)
        && rowText.includes(movementTarget);
      return idsMatch || namesMatch;
    }) || null;
  }

  function rowHasColonizeShip(row) {
    if (!row) return false;
    return [...row.querySelectorAll('.place_unit, [data-unit_id], [data-type]')].some((unit) => {
      const identity = [
        unit.getAttribute('data-unit_id'),
        unit.getAttribute('data-type'),
        unit.className
      ].filter(Boolean).join(' ').toLowerCase();
      if (!/colonize[_-]?ship|colony[_-]?ship|colonisation[_-]?ship|colonization[_-]?ship/.test(identity)) return false;
      const count = unit.getAttribute('data-unit_count');
      return count === null || integer(count) > 0;
    });
  }

  function movementWithRowEvidence(movement, row) {
    if (movement?.explicitNc || !rowHasColonizeShip(row)) return movement;
    return { ...movement, explicitNc: 'dom:colonize_ship' };
  }

  function rowIsVisible(row) {
    if (!row) return false;
    const style = getComputedStyle(row);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = row.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const intersects = (candidate, clip) => (
      candidate.right > clip.left
      && candidate.left < clip.right
      && candidate.bottom > clip.top
      && candidate.top < clip.bottom
    );
    const viewport = {
      left: 0,
      top: 0,
      right: document.documentElement.clientWidth,
      bottom: document.documentElement.clientHeight
    };
    if (!intersects(rect, viewport)) return false;
    for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clips = [ancestorStyle.overflow, ancestorStyle.overflowX, ancestorStyle.overflowY]
        .some((value) => /auto|scroll|hidden|clip/.test(value));
      if (!clips) continue;
      const clipRect = ancestor.getBoundingClientRect();
      if (clipRect.width && clipRect.height && !intersects(rect, clipRect)) return false;
    }
    return true;
  }

  function overlayRect(row) {
    const rect = row.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const left = rect.left + rect.width * SLOT_LEFT_RATIO;
    const right = rect.right - rect.width * SLOT_RIGHT_RATIO;
    return {
      left,
      top: rect.top + Math.max(0, (rect.height - SLOT_HEIGHT_PX) / 2),
      width: Math.max(80, right - left),
      height: Math.min(SLOT_HEIGHT_PX, rect.height)
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderOverlay(layer, row, movement, display) {
    const rect = overlayRect(row);
    if (!rect) return null;
    const key = movement.id || `${movement.originTownId}:${movement.targetTownId}:${movement.arrivalAt}`;
    let node = [...layer.querySelectorAll('.gai-overlay')]
      .find((candidate) => candidate.dataset.gaiKey === key);
    if (!node) {
      node = document.createElement('div');
      node.dataset.gaiKey = key;
      node.className = 'gai-overlay';
      layer.appendChild(node);
    }
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    node.title = `Duração total: ${display.durationText} | Enviado: ${display.sentText}`;
    node.innerHTML = `
      <span>Duração ${escapeHtml(display.durationText)}</span>
      <span>· Enviado ${escapeHtml(display.sentText)}</span>
      ${display.ncText ? `<span class="gai-nc ${display.ncConfirmed ? '' : 'gai-nc-unknown'}">· ${escapeHtml(display.ncText)}</span>` : ''}
    `;
    return key;
  }

  function createLayer() {
    let layer = document.getElementById(OVERLAY_ID);
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = OVERLAY_ID;
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      #${OVERLAY_ID}{position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible}
      #${OVERLAY_ID} .gai-overlay{position:fixed;display:flex;align-items:center;gap:3px;box-sizing:border-box;overflow:hidden;white-space:nowrap;pointer-events:none;color:#5b2d08;font:700 10px/16px Arial,sans-serif;text-shadow:0 1px #fff1b3}
      #${OVERLAY_ID} .gai-overlay>span{flex:0 0 auto}
      #${OVERLAY_ID} .gai-nc{color:#c40000;font-weight:700}
      #${OVERLAY_ID} .gai-nc-unknown{color:#8b2a00}
    `;
    document.head.appendChild(style);
    document.body.appendChild(layer);
    return layer;
  }

  async function worldTowns() {
    if (worldTownsPromise) return worldTownsPromise;
    worldTownsPromise = fetch(`${location.origin}/data/towns.txt`, { credentials: 'same-origin' })
      .then((response) => response.ok ? response.text() : '')
      .then(parseWorldTowns)
      .catch(() => []);
    return worldTownsPromise;
  }

  function movementCoordinates(movement, townMap) {
    const originRaw = movement.raw;
    const origin = extractCoordinates(originRaw, 'origin') || townMap.get(movement.originTownId);
    const target = extractCoordinates(originRaw, 'target') || townMap.get(movement.targetTownId);
    return { origin, target };
  }

  function classifyMovement(movement, sentAt, townMap) {
    if (movement.explicitNc) return classifyNcAttack(movement, { sentAt });
    const coordinates = movementCoordinates(movement, townMap);
    const distance = townDistance(coordinates.origin, coordinates.target);
    if (distance === null || !sentAt) return classifyNcAttack(movement, { sentAt });
    const unitSpeed = number(page.Game?.unit_speed ?? page.Game?.unitSpeed, 1);
    const colonySpeed = number(page.GameData?.units?.colonize_ship?.speed, 3);
    const expectedDurations = calculateNcDurations({ distance, unitSpeed, colonySpeed });
    return classifyNcAttack(movement, { sentAt, expectedDurations });
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const { now, stored, movements } = readCommands();
      const ownIds = ownTownIds(page);
      const rows = readRows();
      const incoming = movements
        .map((movement) => movementWithRowEvidence(movement, findRow(rows, movement)))
        .filter((movement) => isIncomingAttack(movement, ownIds, now, ownTownNames(page)));
      const layer = createLayer();
      const townMap = ownTownCoordinates(page);
      const missingCoordinates = incoming.some((movement) => !movement.raw || !movementCoordinates(movement, townMap).origin || !movementCoordinates(movement, townMap).target);
      if (missingCoordinates) {
        (await worldTowns()).forEach((town) => townMap.set(town.id, { x: town.x, y: town.y }));
      }
      const activeKeys = new Set();
      for (const movement of incoming) {
        const record = movement.startedAt ? null : findSentRecord(stored, movement, now);
        const sentAt = movement.startedAt || record?.sentAt || 0;
        const nc = classifyMovement(movement, sentAt, townMap);
        const display = buildDisplayModel(movement, sentAt, nc);
        const row = findRow(rows, movement);
        if (row) {
          const key = renderOverlay(layer, row, movement, display);
          if (key) activeKeys.add(key);
        }
      }
      [...layer.querySelectorAll('.gai-overlay')].forEach((node) => {
        if (!activeKeys.has(node.dataset.gaiKey)) node.remove();
      });
    } finally {
      scanning = false;
    }
  }

  function scheduleScan() {
    if (scheduledScan) return;
    scheduledScan = window.setTimeout(() => {
      scheduledScan = 0;
      void scan();
    }, 50);
  }

  function subscribeToSendEvents() {
    if (subscribed) return true;
    const observer = page.$?.Observer;
    const event = page.GameEvents?.command?.send_unit;
    if (typeof observer !== 'function' || !event) return false;
    observer(event).subscribe(`gai:${ownerId}`, (_event, command) => {
      const record = eventToSentRecord(command, serverNowMs(), page);
      if (!record) return;
      saveSentRecords(rememberSentRecord(loadSentRecords(), record, record.sentAt));
      scheduleScan();
    });
    subscribed = true;
    return true;
  }

  function boot() {
    if (page.__grepolisAttackInfoLoaded) return;
    page.__grepolisAttackInfoLoaded = VERSION;
    createLayer();
    subscribeToSendEvents();
    const waitForEvents = window.setInterval(() => {
      if (subscribeToSendEvents()) window.clearInterval(waitForEvents);
    }, 500);
    scanTimer = window.setInterval(() => void scan(), SCAN_INTERVAL_MS);
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
    document.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
    void scan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}());
