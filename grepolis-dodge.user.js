// ==UserScript==
// @name         Grepolis Dodge Silencioso PT
// @namespace    https://grepolis.com/
// @version      1.3.4
// @description  Dodge, snipe de NC e milícia automáticos, sem interface no jogo.
// @author       unknown
// @match        https://*.grepolis.com/game/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisDodgeFactory() {
  'use strict';

  const VERSION = '1.3.4';
  const CONFIG = Object.freeze({
    enabled: true,
    returnOffsetMs: 1_000,
    ncReturnOffsetMs: -100,
    ncFallbackReturnOffsetMs: -1_000,
    ncHighPrecisionUncertaintyMs: 75,
    ncDurationToleranceMs: 11_000,
    ncBaseTravelSeconds: 900,
    ncDistanceFactor: 50,
    ncSpeedModifiers: null,
    militiaLeadMs: 1_000,
    militiaLatencySafetyMs: 100,
    militiaActiveMs: 3 * 60 * 60_000,
    purificationScanIntervalMs: 100,
    purificationFavorCost: 200,
    waveGapSeconds: 300,
    sendLeadSeconds: 30,
    minimumSendLeadSeconds: 5,
    destinationTravelMarginSeconds: 5,
    cancellationWindowSeconds: 600,
    cancellationSafetySeconds: 2,
    scanIntervalMs: 1_000,
    heartbeatIntervalMs: 50,
    ajaxTimeoutMs: 12_000,
    commandResolveTimeoutMs: 12_000,
    mapCacheMs: 30 * 60_000,
    maxDestinationPreviews: 20,
    maximumRttMs: 2_000,
    maximumTimerSlipMs: 500,
    lockTtlMs: 10_000,
    logLimit: 100
  });

  const STORAGE_KEY = 'gd.runtime.v1';
  const LOG_KEY = 'gd.logs.v1';
  const LOCK_KEY = 'gd.tab-lock.v1';
  const MAP_KEY = 'gd.world-towns.v1';
  const PREFIX = '[GD]';

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

  function timestampHasMilliseconds(value) {
    const parsed = number(value, Number.NaN);
    if (!Number.isFinite(parsed)) return false;
    return parsed >= 10_000_000_000 || !Number.isInteger(parsed);
  }

  function calibratedServerTime(rawServer, perfNow, state = {}) {
    if (timestampHasMilliseconds(rawServer)) {
      return { now: timestampMs(rawServer), state };
    }
    const second = integer(rawServer);
    if (!second) return { now: 0, state };
    const changed = second !== state.second;
    const jumped = state.second && Math.abs(second - state.second) > 2;
    const next = (changed || jumped || !state.epochMs)
      ? { second, epochMs: second * 1_000, perfMs: number(perfNow) }
      : state;
    return { now: next.epochMs + Math.max(0, number(perfNow) - next.perfMs), state: next };
  }

  function read(source, names, fallback = '') {
    const attributes = source?.attributes || source || {};
    for (const name of names) {
      const value = attributes[name] ?? source?.[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  }

  function canonicalType(value) {
    const text = String(value || '').toLowerCase();
    if (/spy|espion/.test(text)) return 'spy';
    if (/support|apoio|refor/.test(text)) return 'support';
    if (/attack|ataque|revolt|colon/.test(text)) return 'attack';
    return 'unknown';
  }

  function normalizeMovement(raw, now = Date.now()) {
    const rawAttributes = raw?.attributes || raw || {};
    const rawType = String(read(raw, [
      'command_type', 'type', 'movement_type', 'attack_type', 'name'
    ]));
    const type = canonicalType(rawType);
    const id = String(read(raw, ['command_id', 'id', 'model_id'], ''));
    const rawStarted = read(raw, [
      'started_at', 'start_at', 'created_at', 'startedAt', 'start_time'
    ]);
    const startedAt = timestampMs(rawStarted);
    const rawArrival = read(raw, [
      'arrival_at_ms', 'arrival_time_ms', 'arrival_at', 'arrivalAt',
      'arrival_time', 'finished_at', 'end_at'
    ]);
    const arrivalAt = timestampMs(rawArrival);
    const homeTownId = String(read(raw, ['home_town_id', 'homeTownId'], ''));
    const targetTownId = String(read(raw, [
      'target_town_id', 'targetTownId', 'destination_town_id', 'town_id'
    ], ''));
    const direction = String(read(raw, ['direction', 'movement_direction', 'status'], '')).toLowerCase();
    const returning = Boolean(read(raw, ['is_returning', 'returning', 'is_return'], false))
      || /return|regress/.test(direction)
      // Regra nativa de GameModels.MovementsUnits.isReturning().
      || Boolean(homeTownId && targetTownId && homeTownId === targetTownId);
    return {
      id,
      type,
      rawType,
      originTownId: String(read(raw, [
        'origin_town_id', 'home_town_id', 'originTownId', 'source_town_id'
      ], '')),
      targetTownId,
      playerId: String(read(raw, ['player_id', 'origin_player_id', 'home_player_id'], '')),
      startedAt,
      startedHasMilliseconds: timestampHasMilliseconds(rawStarted),
      arrivalAt: arrivalAt || now,
      arrivalHasMilliseconds: timestampHasMilliseconds(rawArrival),
      returning,
      raw: { ...rawAttributes }
    };
  }

  function groupAttackWaves(attacks, gapSeconds = CONFIG.waveGapSeconds) {
    const gapMs = Math.max(0, number(gapSeconds)) * 1_000;
    const groups = [];
    const byTown = new Map();
    [...attacks].sort((a, b) => a.arrivalAt - b.arrivalAt).forEach((attack) => {
      const key = String(attack.targetTownId);
      const townGroups = byTown.get(key) || [];
      const current = townGroups.at(-1);
      if (!current || attack.arrivalAt - current.lastArrivalAt > gapMs) {
        const next = {
          id: `town:${key}:${attack.id || attack.arrivalAt}`,
          targetTownId: key,
          firstArrivalAt: attack.arrivalAt,
          lastArrivalAt: attack.arrivalAt,
          commandIds: [String(attack.id)],
          attacks: [attack],
          ncArrivalAt: attack.nc?.isNc ? attack.arrivalAt : 0,
          ncConfidence: attack.nc?.isNc ? attack.nc.confidence : ''
        };
        townGroups.push(next);
        groups.push(next);
      } else {
        current.lastArrivalAt = Math.max(current.lastArrivalAt, attack.arrivalAt);
        current.commandIds.push(String(attack.id));
        current.attacks.push(attack);
        if (attack.nc?.isNc && (!current.ncArrivalAt || attack.arrivalAt < current.ncArrivalAt)) {
          current.ncArrivalAt = attack.arrivalAt;
          current.ncConfidence = attack.nc.confidence;
        }
      }
      byTown.set(key, townGroups);
    });
    return groups;
  }

  function calculateCancelAt(sentAt, lastAttackArrivalAt, returnOffsetMs = 1_000) {
    const desiredReturnAt = number(lastAttackArrivalAt) + number(returnOffsetMs);
    return number(sentAt) + (desiredReturnAt - number(sentAt)) / 2;
  }

  function chooseSentAt(movement, sentAtEstimate) {
    return movement?.startedAt && movement?.startedHasMilliseconds
      ? movement.startedAt
      : number(sentAtEstimate);
  }

  function buildNcSpeedModifiers({ maxSirens = 50 } = {}) {
    // Independentes e opcionais: Cartografia 10%, Farol 15%, outro bónus
    // naval de 25% e Movimento de tropas melhorado 30%.
    const bonuses = [0.10, 0.15, 0.25, 0.30];
    const modifiers = new Set();
    const combinations = 1 << bonuses.length;
    for (let mask = 0; mask < combinations; mask += 1) {
      const selected = bonuses.filter((_, index) => mask & (1 << index));
      const additiveBase = 1 + selected.reduce((sum, bonus) => sum + bonus, 0);
      const multiplicativeBase = selected.reduce((product, bonus) => product * (1 + bonus), 1);
      for (let sirens = 0; sirens <= Math.max(0, integer(maxSirens)); sirens += 1) {
        const sirenBonus = Math.min(1, sirens * 0.02);
        modifiers.add(Number((additiveBase + sirenBonus).toFixed(6)));
        modifiers.add(Number((multiplicativeBase * (1 + sirenBonus)).toFixed(6)));
      }
    }
    return [...modifiers].sort((left, right) => left - right);
  }

  function calculateNcDurations({ distance, unitSpeed = 1, colonySpeed = 3, modifiers = CONFIG.ncSpeedModifiers } = {}) {
    const safeDistance = Math.max(0, number(distance));
    const safeWorldSpeed = Math.max(0.01, number(unitSpeed, 1));
    const safeColonySpeed = Math.max(0.01, number(colonySpeed, 3));
    const profiles = Array.isArray(modifiers) && modifiers.length ? modifiers : buildNcSpeedModifiers();
    return [...new Set(profiles.map((modifier) => Math.round((
      CONFIG.ncBaseTravelSeconds
      + safeDistance * CONFIG.ncDistanceFactor / (safeColonySpeed * Math.max(0.01, number(modifier, 1)))
    ) * 1_000 / safeWorldSpeed)))];
  }

  function classifyNcAttack(movement, {
    expectedDurations = [],
    revoltActive = false,
    toleranceMs = CONFIG.ncDurationToleranceMs
  } = {}) {
    let rawText = '';
    try { rawText = JSON.stringify(movement?.raw || {}).toLowerCase(); }
    catch { rawText = String(movement?.rawType || '').toLowerCase(); }
    const explicit = /colonize_ship|colony_ship|coloniz|colonis|takeover|conquer|conquest/.test(
      `${movement?.rawType || ''} ${rawText}`
    );
    if (explicit) return { isNc: true, confidence: 'explicit', deltaMs: 0 };
    const duration = number(movement?.arrivalAt) - number(movement?.startedAt);
    if (!movement?.startedAt || duration <= 0 || !expectedDurations.length) {
      return { isNc: false, confidence: 'insufficient-data', deltaMs: null };
    }
    const deltaMs = Math.min(...expectedDurations.map((expected) => Math.abs(duration - expected)));
    if (deltaMs <= Math.max(0, number(toleranceMs))) {
      return { isNc: true, confidence: revoltActive ? 'high' : 'timing-match', deltaMs };
    }
    return {
      isNc: false,
      confidence: 'no-match',
      deltaMs
    };
  }

  function chooseReturnOffset({ nc = false, hasMilliseconds = false, uncertaintyMs = Infinity } = {}) {
    if (!nc) return CONFIG.returnOffsetMs;
    return hasMilliseconds && number(uncertaintyMs, Infinity) <= CONFIG.ncHighPrecisionUncertaintyMs
      ? CONFIG.ncReturnOffsetMs
      : CONFIG.ncFallbackReturnOffsetMs;
  }

  function parseDurationMs(value) {
    if (typeof value === 'string') {
      const match = value.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
      if (match) {
        return (integer(match[1]) * 3_600 + integer(match[2]) * 60 + integer(match[3])) * 1_000;
      }
    }
    const parsed = number(value, Number.NaN);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed < 1_000_000 ? parsed * 1_000 : parsed;
  }

  function extractTravelDurationMs(value) {
    let best = null;
    const visited = new Set();
    function visit(candidate, path = '', depth = 0) {
      if (candidate === null || candidate === undefined || depth > 7) return;
      if (typeof candidate !== 'object') {
        if (/duration|travel|runtime|time_to_target/i.test(path)) {
          const duration = parseDurationMs(candidate);
          if (duration && (!best || duration < best)) best = duration;
        }
        return;
      }
      if (visited.has(candidate)) return;
      visited.add(candidate);
      Object.entries(candidate).forEach(([key, child]) => visit(child, `${path}.${key}`, depth + 1));
    }
    visit(value);
    return best;
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
        playerId: String(integer(parts[1])),
        name: decode(parts[2]),
        islandX: integer(parts[3]),
        islandY: integer(parts[4]),
        islandSlot: integer(parts[5]),
        points: integer(parts[6])
      };
    }).filter(Boolean);
  }

  function sameIsland(town, islandX, islandY) {
    return number(town?.islandX) === number(islandX) && number(town?.islandY) === number(islandY);
  }

  function sortDestinations(towns, origin) {
    const slot = number(origin?.islandSlot);
    return [...towns]
      .filter((town) => town.id !== String(origin?.id))
      .sort((left, right) => (
        Math.abs(number(left.islandSlot) - slot) - Math.abs(number(right.islandSlot) - slot)
        || left.id.localeCompare(right.id)
      ));
  }

  function buildSupportUnits(preview) {
    const units = preview?.json?.units || preview?.units || {};
    const output = {};
    for (const [name, record] of Object.entries(units)) {
      if (name === 'militia') continue;
      const count = integer(record?.count ?? record?.amount ?? record);
      if (count > 0) output[name] = count;
    }
    return output;
  }

  function buildSupportPayload(sourceTownId, targetTownId, units) {
    return {
      id: integer(targetTownId),
      type: 'support',
      town_id: integer(sourceTownId),
      nl_init: true,
      ...units
    };
  }

  function extractSupportCapacity(value) {
    const strings = [];
    const visited = new Set();
    function visit(candidate, depth = 0) {
      if (candidate === null || candidate === undefined || depth > 8) return;
      if (typeof candidate === 'string') {
        strings.push(candidate.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' '));
        return;
      }
      if (typeof candidate !== 'object' || visited.has(candidate)) return;
      visited.add(candidate);
      Object.values(candidate).forEach((child) => visit(child, depth + 1));
    }
    visit(value);
    const text = strings.join(' ').replace(/\s+/g, ' ');
    const match = text.match(/(?:capacidade|capacity)\s*:?\s*(\d+)\s*\/\s*(\d+)/i);
    return match ? { requiredCapacity: integer(match[1]), availableCapacity: integer(match[2]) } : null;
  }

  function planSupportCommands(units, unitCatalog = {}, serverCapacity = null) {
    const navalNames = /^(big_transporter|small_transporter|bireme|attack_ship|demolition_ship|trireme|colonize_ship|transport_boat|fast_transport_ship|light_ship|fire_ship)$/;
    const land = {};
    const naval = {};
    let requiredCapacity = 0;
    let availableCapacity = 0;
    for (const [name, count] of Object.entries(units || {})) {
      const data = unitCatalog?.[name] || {};
      const navalUnit = Boolean(data.is_naval || data.isNaval)
        || /naval|ship/.test(String(data.type || data.unit_type || '').toLowerCase())
        || navalNames.test(name);
      if (navalUnit) {
        naval[name] = count;
        availableCapacity += integer(count) * number(data.capacity, 0);
      } else {
        land[name] = count;
        requiredCapacity += integer(count) * Math.max(1, number(data.population, 1));
      }
    }
    if (serverCapacity && Number.isFinite(Number(serverCapacity.requiredCapacity))
      && Number.isFinite(Number(serverCapacity.availableCapacity))) {
      requiredCapacity = integer(serverCapacity.requiredCapacity);
      availableCapacity = integer(serverCapacity.availableCapacity);
    }
    const split = requiredCapacity > availableCapacity
      && Object.keys(land).length > 0
      && Object.keys(naval).length > 0;
    return split
      ? { split: true, requiredCapacity, availableCapacity, plans: [
        { kind: 'land', units: land }, { kind: 'naval', units: naval }
      ] }
      : { split: false, requiredCapacity, availableCapacity, plans: [{ kind: 'mixed', units: { ...units } }] };
  }

  function supportDestinationUnavailable(value) {
    const visited = new Set();
    const unavailableKey = /^(vacation_mode|vacation|in_vacation|player_in_vacation|vacation_protection|is_on_vacation)$/i;
    const unavailableText = /(vacation[_ -]?mode|vacation protection|player.{0,40}(?:is|in).{0,20}vacation|modo de f[eé]rias|protec[cç][aã]o de f[eé]rias)/i;
    function inspect(candidate, depth = 0) {
      if (candidate === null || candidate === undefined || depth > 8) return false;
      if (typeof candidate === 'string') return unavailableText.test(candidate);
      if (typeof candidate !== 'object' || visited.has(candidate)) return false;
      visited.add(candidate);
      return Object.entries(candidate).some(([key, child]) => {
        if (unavailableKey.test(key) && (child === true || child === 1 || child === '1')) return true;
        return inspect(child, depth + 1);
      });
    }
    return inspect(value);
  }

  function cancellationFeasibility({ sentAt, cancelAt, outboundArrivalAt, config = CONFIG }) {
    const cancelElapsed = cancelAt - sentAt;
    if (cancelElapsed <= 0) return { allowed: false, reason: 'cancel-in-past' };
    if (cancelElapsed >= (config.cancellationWindowSeconds - config.cancellationSafetySeconds) * 1_000) {
      return { allowed: false, reason: 'cancel-window' };
    }
    if (outboundArrivalAt - cancelAt <= config.destinationTravelMarginSeconds * 1_000) {
      return { allowed: false, reason: 'travel-too-short' };
    }
    return { allowed: true, reason: 'allowed' };
  }

  function normalizeToken(value) {
    return String(value || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_');
  }

  function isNarcissismPower(value) {
    return /(^|_)(narcissism|narcisismo)(_|$)/.test(normalizeToken(value));
  }

  function isCityProtectionPower(value) {
    return /(^|_)(town_protection|city_protection|protection|protecao)(_|$)/.test(normalizeToken(value));
  }

  function purificationDecision({ narcissism, protectedCity, artemisTownId, favor, cost = 200, handled = false } = {}) {
    if (!narcissism) return { allowed: false, reason: 'no-narcissism' };
    if (handled) return { allowed: false, reason: 'already-handled' };
    if (protectedCity) return { allowed: false, reason: 'city-protected' };
    if (!artemisTownId) return { allowed: false, reason: 'artemis-unavailable' };
    if (!Number.isFinite(Number(favor))) return { allowed: false, reason: 'favor-unknown' };
    if (Number(favor) < Number(cost)) return { allowed: false, reason: 'insufficient-favor' };
    return { allowed: true, reason: 'allowed' };
  }

  const Core = {
    VERSION,
    CONFIG,
    timestampMs,
    timestampHasMilliseconds,
    calibratedServerTime,
    canonicalType,
    normalizeMovement,
    groupAttackWaves,
    calculateCancelAt,
    chooseSentAt,
    calculateNcDurations,
    buildNcSpeedModifiers,
    classifyNcAttack,
    chooseReturnOffset,
    parseDurationMs,
    extractTravelDurationMs,
    parseWorldTowns,
    sameIsland,
    sortDestinations,
    buildSupportUnits,
    buildSupportPayload,
    extractSupportCapacity,
    planSupportCommands,
    supportDestinationUnavailable,
    cancellationFeasibility,
    normalizeToken,
    isNarcissismPower,
    isCityProtectionPower,
    purificationDecision
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || !window.document) return;

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const ownerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  let stopped = !CONFIG.enabled;
  let busy = false;
  let latencyMs = 100;
  const latencySamples = [];
  let lastHeartbeatAt = performance.now();
  let serverClockState = {};
  let worldTownsCache = null;
  let scanTimer = null;
  let heartbeatTimer = null;
  let lastPurificationScanAt = 0;
  const jobs = new Map();
  const militiaJobs = new Map();
  const purificationJobs = new Map();

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
    } catch (error) { console.warn(PREFIX, 'Falha ao guardar estado.', error); }
  }

  function log(level, message, details = {}) {
    const entry = { at: Date.now(), level, message, details };
    const history = [entry, ...load(LOG_KEY, [])].slice(0, CONFIG.logLimit);
    save(LOG_KEY, history);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    let diagnostic = '{}';
    try { diagnostic = JSON.stringify(details); } catch { diagnostic = '{"error":"details-unserializable"}'; }
    fn(PREFIX, message, diagnostic);
  }

  function persistJobs() {
    const plainJob = (job) => ({
      ...job,
      commandIds: [...(job.commandIds || [])],
      attacks: (job.attacks || []).map((attack) => ({
        id: attack.id,
        type: attack.type,
        rawType: attack.rawType,
        originTownId: attack.originTownId,
        targetTownId: attack.targetTownId,
        startedAt: attack.startedAt,
        startedHasMilliseconds: attack.startedHasMilliseconds,
        arrivalAt: attack.arrivalAt,
        arrivalHasMilliseconds: attack.arrivalHasMilliseconds,
        nc: attack.nc
      }))
    });
    save(STORAGE_KEY, {
      version: VERSION,
      jobs: [...jobs.values()].map(plainJob),
      militiaJobs: [...militiaJobs.values()],
      purificationJobs: [...purificationJobs.values()]
    });
  }

  function timingUncertaintyMs() {
    if (latencySamples.length < 4) return Infinity;
    const sorted = [...latencySamples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.max(0, (p95 - median) / 2);
  }

  function serverNowMs() {
    try {
      const calibrated = calibratedServerTime(page.Timestamp?.server?.(), performance.now(), serverClockState);
      serverClockState = calibrated.state;
      if (calibrated.now) return calibrated.now;
    } catch { /* use local time */ }
    return Date.now();
  }

  function serverClockHasMilliseconds() {
    try { return timestampHasMilliseconds(page.Timestamp?.server?.()); }
    catch { return false; }
  }

  function modelAttributes(model) {
    if (!model) return null;
    if (model.attributes) return model;
    if (typeof model.toJSON === 'function') return { id: model.id, attributes: model.toJSON() };
    return model;
  }

  function movementModels() {
    try {
      const direct = page.MM?.getModels?.()?.MovementsUnits;
      if (direct && typeof direct === 'object') return Object.values(direct).map(modelAttributes);
      return (page.MM?.getOnlyCollectionByName?.('MovementsUnits')?.models || []).map(modelAttributes);
    } catch { return []; }
  }

  function movements() {
    const now = serverNowMs();
    return movementModels().map((model) => normalizeMovement(model, now));
  }

  function ownTowns() {
    const values = page.ITowns?.getTowns?.() || page.ITowns?.towns || {};
    return Object.entries(values).map(([fallbackId, town]) => ({
      id: String(town?.getId?.() ?? town?.id ?? fallbackId),
      name: String(town?.getName?.() ?? town?.attributes?.name ?? fallbackId),
      islandX: integer(town?.getIslandCoordinateX?.() ?? town?.attributes?.island_x),
      islandY: integer(town?.getIslandCoordinateY?.() ?? town?.attributes?.island_y),
      islandSlot: integer(town?.getIslandNumber?.() ?? town?.attributes?.island_number),
      model: town
    })).filter((town) => town.id && town.islandX && town.islandY);
  }

  function townGod(town) {
    return normalizeToken(town?.model?.getGod?.() ?? town?.model?.attributes?.god ?? town?.model?.god);
  }

  function castedPower(town, aliases) {
    for (const alias of aliases) {
      try {
        const power = town?.model?.getCastedPower?.(alias);
        if (power) return power;
      } catch { /* try the model data below */ }
    }
    const values = town?.model?.getCastedPowers?.()
      ?? town?.model?.attributes?.casted_powers
      ?? town?.model?.attributes?.powers
      ?? [];
    const entries = Array.isArray(values) ? values : Object.entries(values || {}).map(([id, value]) => ({ id, ...(value || {}) }));
    return entries.find((power) => {
      const id = read(power, ['power_id', 'power', 'id', 'name'], '');
      return aliases.some((alias) => normalizeToken(id) === normalizeToken(alias));
    }) || null;
  }

  function narcissismInTown(town) {
    return castedPower(town, ['narcissism', 'narcisismo']);
  }

  function protectionInTown(town) {
    return castedPower(town, ['town_protection', 'city_protection', 'protection', 'protecao']);
  }

  function artemisFavor() {
    const candidates = [];
    try {
      const gods = page.ITowns?.getGods?.() ?? page.ITowns?.gods;
      candidates.push(gods?.artemis?.favor, gods?.artemis?.attributes?.favor);
    } catch { /* continue */ }
    try {
      const models = page.MM?.getModels?.() || {};
      Object.entries(models).forEach(([name, collection]) => {
        if (!/god|favor/i.test(name)) return;
        const values = Array.isArray(collection) ? collection : Object.values(collection || {});
        values.forEach((model) => {
          const raw = model?.attributes || model || {};
          if (normalizeToken(read(raw, ['god_id', 'god', 'id'], '')) === 'artemis') {
            candidates.push(read(raw, ['favor', 'current_favor', 'value'], Number.NaN));
          }
        });
      });
    } catch { /* unknown is safer than guessing */ }
    const favor = candidates.map(Number).find(Number.isFinite);
    return favor === undefined ? Number.NaN : favor;
  }

  function purificationCost() {
    const powers = page.GameData?.powers || {};
    const entry = powers.cleanse || powers.purification
      || Object.entries(powers).find(([id, power]) => /purification|purificacao/i.test(`${id} ${power?.name || ''}`))?.[1];
    const cost = Number(entry?.favor ?? entry?.cost ?? entry?.favor_cost);
    return Number.isFinite(cost) ? cost : CONFIG.purificationFavorCost;
  }

  function effectFingerprint(townId, effect) {
    const raw = effect?.attributes || effect || {};
    return `${townId}:${read(raw, ['id', 'power_id', 'cast_id', 'end_at', 'expires_at'], 'active')}`;
  }

  async function castPurification(job) {
    job.stage = 'casting';
    job.attemptedAt = serverNowMs();
    persistJobs();
    try {
      await ajaxPost('powers', 'cast', {
        power_id: 'cleanse',
        target_id: integer(job.targetTownId),
        target_type: 'town',
        town_id: integer(job.sourceTownId)
      });
      job.stage = 'done';
      job.completedAt = serverNowMs();
      log('info', 'PurificaÃ§Ã£o automÃ¡tica lanÃ§ada.', { townId: job.targetTownId });
    } catch (error) {
      job.stage = 'blocked';
      job.error = error.message;
      log('warn', 'PurificaÃ§Ã£o automÃ¡tica bloqueada; nÃ£o serÃ¡ repetida neste efeito.', {
        townId: job.targetTownId, error: error.message
      });
    }
    persistJobs();
  }

  function monitorPurification() {
    const towns = ownTowns();
    const artemisTown = towns.find((town) => townGod(town) === 'artemis');
    const favor = artemisFavor();
    const cost = purificationCost();
    for (const town of towns) {
      const effect = narcissismInTown(town);
      const previous = purificationJobs.get(town.id);
      if (!effect) {
        if (previous) purificationJobs.delete(town.id);
        continue;
      }
      const fingerprint = effectFingerprint(town.id, effect);
      const handled = previous?.fingerprint === fingerprint;
      const decision = purificationDecision({
        narcissism: true,
        protectedCity: Boolean(protectionInTown(town)),
        artemisTownId: artemisTown?.id,
        favor,
        cost,
        handled
      });
      if (handled) continue;
      const job = {
        targetTownId: town.id,
        sourceTownId: artemisTown?.id || '',
        fingerprint,
        detectedAt: serverNowMs(),
        favor: Number.isFinite(favor) ? favor : null,
        cost,
        stage: decision.allowed ? 'scheduled' : 'blocked',
        error: decision.allowed ? '' : decision.reason
      };
      purificationJobs.set(town.id, job);
      persistJobs();
      if (decision.allowed) void castPurification(job);
      else log('warn', 'PurificaÃ§Ã£o automÃ¡tica cancelada.', { townId: town.id, reason: decision.reason });
    }
  }

  function incomingAttacks() {
    const ownIds = new Set(ownTowns().map((town) => town.id));
    const now = serverNowMs();
    return movements().filter((movement) => (
      movement.type === 'attack'
      && !movement.returning
      && movement.arrivalAt > now
      && ownIds.has(movement.targetTownId)
    ));
  }

  function ajax(method, controller, action, data) {
    return new Promise((resolve, reject) => {
      const fn = page.gpAjax?.[method];
      if (typeof fn !== 'function') return reject(new Error(`gpAjax.${method} indisponível.`));
      const started = performance.now();
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`Timeout: ${controller}/${action}`)), CONFIG.ajaxTimeoutMs);
      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const rtt = performance.now() - started;
        latencySamples.push(rtt);
        if (latencySamples.length > 30) latencySamples.shift();
        latencyMs = latencyMs * 0.7 + rtt * 0.3;
        if (error) reject(error);
        else if (response?.success === false || response?.json?.success === false) {
          const rejection = new Error(`Grepolis rejeitou ${controller}/${action}.`);
          rejection.definitive = true;
          rejection.response = response;
          reject(rejection);
        } else resolve(response);
      }
      try {
        const request = fn.call(page.gpAjax, controller, action, data || {}, false, (response) => finish(null, response));
        if (request?.then) request.then((response) => finish(null, response), (error) => finish(error));
        else if (request?.fail) request.fail((error) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  function ajaxGet(controller, action, data) { return ajax('ajaxGet', controller, action, data); }
  function ajaxPost(controller, action, data) { return ajax('ajaxPost', controller, action, data); }

  async function loadWorldTowns() {
    if (worldTownsCache && Date.now() - worldTownsCache.at < CONFIG.mapCacheMs) return worldTownsCache.towns;
    const stored = load(MAP_KEY, null);
    if (stored?.at && Date.now() - stored.at < CONFIG.mapCacheMs && Array.isArray(stored.towns)) {
      worldTownsCache = stored;
      return stored.towns;
    }
    const response = await fetch(`${location.origin}/data/towns.txt`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Mapa do mundo indisponível (${response.status}).`);
    const towns = parseWorldTowns(await response.text());
    worldTownsCache = { at: Date.now(), towns };
    save(MAP_KEY, worldTownsCache);
    return towns;
  }

  function previewData(response) { return response?.json || response || {}; }

  function revoltActiveTownIds() {
    const ids = new Set();
    const now = serverNowMs();
    try {
      const models = page.MM?.getModels?.() || {};
      Object.entries(models).forEach(([name, collection]) => {
        if (!/revolt|conquest/i.test(name)) return;
        const values = Array.isArray(collection) ? collection : Object.values(collection || {});
        values.forEach((model) => {
          const raw = model?.attributes || model || {};
          const townId = String(read(raw, ['town_id', 'target_town_id', 'targetTownId'], ''));
          const endAt = timestampMs(read(raw, ['revolt_end', 'end_at', 'finished_at', 'revolt_end_at'], 0));
          if (townId && (!endAt || endAt > now)) ids.add(townId);
        });
      });
    } catch { /* context remains unknown */ }
    return ids;
  }

  function townDistance(left, right) {
    return Math.hypot(number(left?.islandX) - number(right?.islandX), number(left?.islandY) - number(right?.islandY));
  }

  async function classifyAttacks(attacks) {
    const worldTowns = await loadWorldTowns();
    const byId = new Map(worldTowns.map((town) => [town.id, town]));
    const revolts = revoltActiveTownIds();
    const unitSpeed = number(page.Game?.unit_speed ?? page.Game?.unitSpeed, 1);
    const colonySpeed = number(page.GameData?.units?.colonize_ship?.speed, 3);
    return attacks.map((attack) => {
      const origin = byId.get(attack.originTownId);
      const target = byId.get(attack.targetTownId);
      const expectedDurations = origin && target ? calculateNcDurations({
        distance: townDistance(origin, target), unitSpeed, colonySpeed
      }) : [];
      return {
        ...attack,
        nc: classifyNcAttack(attack, {
          expectedDurations,
          revoltActive: revolts.has(attack.targetTownId)
        })
      };
    });
  }

  async function chooseDestination(source, desiredReturnAt, excludedIds = new Set()) {
    const all = await loadWorldTowns();
    const sourceMapTown = all.find((town) => town.id === source.id) || source;
    const candidates = sortDestinations(
      all.filter((town) => sameIsland(town, source.islandX, source.islandY) && !excludedIds.has(town.id)),
      sourceMapTown
    ).slice(0, CONFIG.maxDestinationPreviews);
    const estimatedCancelElapsed = Math.max(0, (desiredReturnAt - serverNowMs()) / 2);
    for (const town of candidates) {
      try {
        const response = await ajaxGet('town_info', 'support', {
          id: integer(town.id), town_id: integer(source.id), nl_init: true
        });
        const data = previewData(response);
        if (supportDestinationUnavailable(response)) {
          log('warn', `Destino ${town.id} ignorado: jogador em modo de férias.`);
          continue;
        }
        if (data.controller_type && data.controller_type !== 'town_info') continue;
        if (data.type && data.type !== 'support') continue;
        if (data.target_id && String(data.target_id) !== town.id) continue;
        const travelDurationMs = extractTravelDurationMs(response);
        const units = buildSupportUnits(response);
        const total = Object.values(units).reduce((sum, count) => sum + count, 0);
        if (!travelDurationMs || !total) continue;
        if (travelDurationMs <= estimatedCancelElapsed + CONFIG.destinationTravelMarginSeconds * 1_000) continue;
        return { town, travelDurationMs, units, capacity: extractSupportCapacity(response) };
      } catch (error) {
        log('warn', `Destino ${town.id} rejeitado.`, { error: error.message });
      }
    }
    return null;
  }

  async function warmTimingSamples(sourceTownId, targetTownId, firstArrivalAt) {
    while (latencySamples.length < 4 && firstArrivalAt - serverNowMs() > 8_000) {
      try {
        await ajaxGet('town_info', 'support', {
          id: integer(targetTownId), town_id: integer(sourceTownId), nl_init: true
        });
      } catch {
        break;
      }
    }
  }

  function commandIds() { return new Set(movements().map((movement) => movement.id).filter(Boolean)); }

  async function waitForCreatedSupport(beforeIds, sourceId, targetId, sentAt) {
    const deadline = Date.now() + CONFIG.commandResolveTimeoutMs;
    while (Date.now() < deadline) {
      const candidates = movements().filter((movement) => (
        movement.type === 'support'
        && !movement.returning
        && movement.originTownId === String(sourceId)
        && movement.targetTownId === String(targetId)
        && movement.id
        && !beforeIds.has(movement.id)
        && (!movement.startedAt || Math.abs(movement.startedAt - sentAt) < 60_000)
      ));
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) throw new Error('Mais de um apoio novo corresponde ao envio.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('O apoio enviado não apareceu nos movimentos.');
  }

  async function waitForCommandGone(commandId) {
    const deadline = Date.now() + CONFIG.commandResolveTimeoutMs;
    while (Date.now() < deadline) {
      if (!movements().some((movement) => movement.id === String(commandId) && !movement.returning)) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  function townMilitiaActive(townId, now = serverNowMs()) {
    const remembered = militiaJobs.get(String(townId));
    if (number(remembered?.activeUntil) > now) return true;
    const town = ownTowns().find((candidate) => candidate.id === String(townId))?.model;
    try {
      const units = typeof town?.units === 'function' ? town.units() : {};
      if (integer(units?.militia) > 0) return true;
    } catch { /* inspect attributes */ }
    const activeUntil = timestampMs(
      town?.get?.('militia_active_until')
      ?? town?.attributes?.militia_active_until
      ?? town?.attributes?.militia_end_at
    );
    return activeUntil > now || Boolean(town?.get?.('militia_active') ?? town?.attributes?.militia_active);
  }

  function discoverMilitiaAction(response) {
    let text = '';
    try { text = JSON.stringify(response); } catch { text = String(response || ''); }
    if (!/militia|milícia|milicia/i.test(text)) return '';
    const patterns = [
      /action[=\\"':\s]+([a-z_]*militia[a-z_]*)/i,
      /ajaxPost\([^,]+,\s*["']([^"']*militia[^"']*)/i,
      /([a-z_]*militia[a-z_]*)\s*\(/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1];
    }
    return 'militia';
  }

  function militiaConfirmed(response, townId) {
    if (townMilitiaActive(townId)) return true;
    let text = '';
    try { text = JSON.stringify(response); } catch { text = String(response || ''); }
    return /militia[^\d]{0,30}[1-9]\d*|militia_active[^a-z]{0,10}(?:true|1)/i.test(text);
  }

  async function activateMilitia(job) {
    if (job.stage !== 'scheduled') return;
    if (townMilitiaActive(job.townId)) {
      job.stage = 'active';
      job.activeUntil = Math.max(number(job.activeUntil), serverNowMs() + CONFIG.militiaActiveMs);
      persistJobs();
      return;
    }
    job.stage = 'activating';
    persistJobs();
    try {
      const action = 'request_militia';
      if (!action) throw new Error('A quinta não anunciou uma ação de milícia.');
      const response = await ajaxPost('building_farm', action, { town_id: integer(job.townId) });
      const deadline = Date.now() + 5_000;
      while (!militiaConfirmed(response, job.townId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!militiaConfirmed(response, job.townId)) {
        throw new Error('A ativação não ficou confirmada no estado da cidade.');
      }
      job.stage = 'active';
      job.activatedAt = serverNowMs();
      job.activeUntil = job.activatedAt + CONFIG.militiaActiveMs;
      log('info', 'Milícia ativada.', { townId: job.townId, attackArrivalAt: job.attackArrivalAt });
    } catch (error) {
      job.stage = 'blocked';
      job.error = error.message;
      log('error', 'Ativação da milícia ficou bloqueada; não será repetida para este ataque.', {
        townId: job.townId,
        error: error.message
      });
    }
    persistJobs();
  }

  function reconcileMilitia(attacks) {
    const now = serverNowMs();
    const firstByTown = new Map();
    attacks.forEach((attack) => {
      const current = firstByTown.get(attack.targetTownId);
      if (!current || attack.arrivalAt < current.arrivalAt) firstByTown.set(attack.targetTownId, attack);
    });
    firstByTown.forEach((attack, townId) => {
      if (townMilitiaActive(townId, now)) return;
      const existing = militiaJobs.get(townId);
      if (existing && ['scheduled', 'activating'].includes(existing.stage)) {
        if (attack.arrivalAt < existing.attackArrivalAt) {
          existing.attackArrivalAt = attack.arrivalAt;
          existing.activateAt = attack.arrivalAt - CONFIG.militiaLeadMs;
        }
        return;
      }
      if (existing?.stage === 'blocked' && existing.attackId === attack.id) return;
      militiaJobs.set(townId, {
        townId,
        attackId: attack.id,
        attackArrivalAt: attack.arrivalAt,
        activateAt: attack.arrivalAt - CONFIG.militiaLeadMs,
        stage: 'scheduled'
      });
    });
    persistJobs();
  }

  async function cancelJob(job, reason = 'scheduled') {
    if (job.stage === 'cancelling' || job.stage === 'done') return;
    job.stage = 'cancelling';
    persistJobs();
    const requestAt = serverNowMs();
    try {
      await ajaxPost('command_info', 'cancel_command', {
        id: integer(job.commandId), town_id: integer(job.sourceTownId)
      });
      const gone = await waitForCommandGone(job.commandId);
      if (!gone) throw new Error('O movimento não desapareceu após o cancelamento.');
      job.stage = 'done';
      job.cancelledAt = requestAt + latencyMs / 2;
      job.expectedReturnAt = job.sentAt + 2 * (job.cancelledAt - job.sentAt);
      log('info', 'Apoio cancelado.', {
        sourceTownId: job.sourceTownId,
        targetTownId: job.destinationTownId,
        commandId: job.commandId,
        reason,
        desiredReturnAt: job.desiredReturnAt,
        expectedReturnAt: job.expectedReturnAt,
        deltaMs: Math.round(job.expectedReturnAt - job.desiredReturnAt)
      });
    } catch (error) {
      job.stage = 'blocked';
      job.error = error.message;
      log('error', 'Cancelamento ficou ambíguo; não será repetido.', { commandId: job.commandId, error: error.message });
    }
    persistJobs();
  }

  async function sendSupportLeg({ wave, source, destination, units, kind, referenceArrivalAt, returnOffsetMs, desiredReturnAt }) {
    const remainingSeconds = (wave.firstArrivalAt - serverNowMs()) / 1_000;
    if (remainingSeconds < CONFIG.minimumSendLeadSeconds) {
      log('error', 'Sem margem para enviar esta parte do apoio.', { sourceTownId: source.id, kind, remainingSeconds });
      return false;
    }
    const beforeIds = commandIds();
    const requestStartedAt = serverNowMs();
    let sendError = null;
    try {
      await ajaxPost('town_info', 'send_units', buildSupportPayload(source.id, destination.town.id, units));
    } catch (error) {
      if (error.definitive) {
        log('warn', 'Destino rejeitou explicitamente o apoio.', { targetTownId: destination.town.id, kind });
        return 'destination-rejected';
      }
      sendError = error;
    }
    const sentAtEstimate = requestStartedAt + latencyMs / 2;
    let movement;
    try {
      movement = await waitForCreatedSupport(beforeIds, source.id, destination.town.id, sentAtEstimate);
    } catch (error) {
      log('error', 'Parte do apoio não confirmada; não será repetida.', {
        sourceTownId: source.id, kind, requestError: sendError?.message || '', resolverError: error.message
      });
      return false;
    }
    if (sendError) {
      log('warn', 'O callback falhou, mas a parte do apoio foi confirmada.', {
        commandId: movement.id, kind, error: sendError.message
      });
    }
    const sentAt = chooseSentAt(movement, sentAtEstimate);
    const cancelAt = calculateCancelAt(sentAt, referenceArrivalAt, returnOffsetMs);
    const outboundArrivalAt = movement.arrivalAt || sentAt + destination.travelDurationMs;
    const feasible = cancellationFeasibility({ sentAt, cancelAt, outboundArrivalAt });
    const job = {
      ...wave,
      id: `${wave.id}:${kind}`,
      parentWaveId: wave.id,
      supportKind: kind,
      stage: feasible.allowed ? 'scheduled' : 'cancelling',
      sourceTownId: source.id,
      destinationTownId: destination.town.id,
      commandId: movement.id,
      sentAt,
      outboundArrivalAt,
      desiredReturnAt,
      returnOffsetMs,
      tactic: wave.ncArrivalAt ? 'nc-snipe' : 'dodge',
      ncConfidence: wave.ncConfidence || '',
      cancelAt,
      createdAt: serverNowMs()
    };
    jobs.set(job.id, job);
    persistJobs();
    log('info', 'Parte do apoio enviada e confirmada.', {
      sourceTownId: source.id, targetTownId: destination.town.id, commandId: movement.id,
      kind, sentAt, cancelAt, desiredReturnAt
    });
    if (!feasible.allowed) {
      job.stage = 'scheduled';
      await cancelJob(job, feasible.reason);
    }
    return true;
  }

  async function startJob(wave, excludedDestinationIds = new Set()) {
    const source = ownTowns().find((town) => town.id === wave.targetTownId);
    if (!source) return;
    const referenceArrivalAt = wave.ncArrivalAt || wave.lastArrivalAt;
    const referenceAttack = wave.ncArrivalAt
      ? wave.attacks?.find((attack) => attack.arrivalAt === wave.ncArrivalAt)
      : null;
    let returnOffsetMs = chooseReturnOffset({
      nc: Boolean(wave.ncArrivalAt),
      hasMilliseconds: Boolean(referenceAttack?.arrivalHasMilliseconds) && serverClockHasMilliseconds(),
      uncertaintyMs: timingUncertaintyMs()
    });
    const desiredReturnAt = referenceArrivalAt + returnOffsetMs;
    const destination = await chooseDestination(source, desiredReturnAt, excludedDestinationIds);
    if (!destination) {
      jobs.set(wave.id, { ...wave, stage: 'blocked', error: 'no-viable-destination' });
      persistJobs();
      log('error', 'Não existe uma cidade viável na mesma ilha.', { sourceTownId: source.id });
      return;
    }
    if (wave.ncArrivalAt && referenceAttack?.arrivalHasMilliseconds && serverClockHasMilliseconds()) {
      await warmTimingSamples(source.id, destination.town.id, wave.firstArrivalAt);
      returnOffsetMs = chooseReturnOffset({
        nc: true,
        hasMilliseconds: true,
        uncertaintyMs: timingUncertaintyMs()
      });
    }
    const finalDesiredReturnAt = referenceArrivalAt + returnOffsetMs;
    const remainingSeconds = (wave.firstArrivalAt - serverNowMs()) / 1_000;
    if (remainingSeconds < CONFIG.minimumSendLeadSeconds) {
      jobs.set(wave.id, { ...wave, stage: 'blocked', error: 'lead-expired-during-preview' });
      persistJobs();
      log('error', 'A pré-validação demorou demasiado; apoio não enviado.', {
        sourceTownId: source.id,
        remainingSeconds: Math.round(remainingSeconds * 10) / 10
      });
      return;
    }
    if (latencyMs > CONFIG.maximumRttMs) throw new Error(`Latência excessiva (${Math.round(latencyMs)} ms).`);
    const supportPlan = planSupportCommands(destination.units, page.GameData?.units || {}, destination.capacity);
    if (supportPlan.split) {
      log('info', 'Capacidade insuficiente; apoio dividido entre tropas terrestres e frota.', {
        sourceTownId: source.id,
        requiredCapacity: supportPlan.requiredCapacity,
        availableCapacity: supportPlan.availableCapacity
      });
      let confirmed = 0;
      for (const plan of supportPlan.plans) {
        const result = await sendSupportLeg({
          wave, source, destination, units: plan.units, kind: plan.kind,
          referenceArrivalAt, returnOffsetMs, desiredReturnAt: finalDesiredReturnAt
        });
        if (result === 'destination-rejected' && confirmed === 0) {
          excludedDestinationIds.add(destination.town.id);
          return startJob(wave, excludedDestinationIds);
        }
        if (result === true) confirmed += 1;
      }
      if (!confirmed) {
        jobs.set(wave.id, { ...wave, stage: 'blocked', error: 'split-send-unconfirmed' });
        persistJobs();
      }
      return;
    }
    const beforeIds = commandIds();
    const requestStartedAt = serverNowMs();
    let sendError = null;
    try {
      await ajaxPost('town_info', 'send_units', buildSupportPayload(source.id, destination.town.id, destination.units));
    } catch (error) {
      if (error.definitive) {
        excludedDestinationIds.add(destination.town.id);
        log('warn', 'Destino rejeitou o apoio; será tentada outra cidade da ilha.', {
          targetTownId: destination.town.id
        });
        return startJob(wave, excludedDestinationIds);
      }
      // A callback em timeout não prova que o servidor rejeitou o comando. Resolve-se
      // sempre pelos movimentos antes de permitir outro envio.
      sendError = error;
    }
    const sentAtEstimate = requestStartedAt + latencyMs / 2;
    let movement;
    try {
      movement = await waitForCreatedSupport(beforeIds, source.id, destination.town.id, sentAtEstimate);
    } catch (error) {
      log('error', 'Envio não confirmado; não será repetido.', {
        sourceTownId: source.id,
        requestError: sendError?.message || '',
        resolverError: error.message
      });
      jobs.set(wave.id, { ...wave, stage: 'blocked', error: 'send-unconfirmed' });
      persistJobs();
      return;
    }
    if (sendError) {
      log('warn', 'O callback do envio falhou, mas o apoio foi confirmado pelos movimentos.', {
        commandId: movement.id,
        error: sendError.message
      });
    }
    // started_at costuma vir truncado a segundos. Esse erro seria duplicado no
    // regresso; só preferimos o valor do movimento quando conserva milissegundos.
    const sentAt = chooseSentAt(movement, sentAtEstimate);
    const cancelAt = calculateCancelAt(sentAt, referenceArrivalAt, returnOffsetMs);
    const outboundArrivalAt = movement.arrivalAt || sentAt + destination.travelDurationMs;
    const feasible = cancellationFeasibility({ sentAt, cancelAt, outboundArrivalAt });
    const job = {
      ...wave,
      stage: feasible.allowed ? 'scheduled' : 'cancelling',
      sourceTownId: source.id,
      destinationTownId: destination.town.id,
      commandId: movement.id,
      sentAt,
      outboundArrivalAt,
      desiredReturnAt: finalDesiredReturnAt,
      returnOffsetMs,
      tactic: wave.ncArrivalAt ? 'nc-snipe' : 'dodge',
      ncConfidence: wave.ncConfidence || '',
      cancelAt,
      createdAt: serverNowMs()
    };
    jobs.set(wave.id, job);
    persistJobs();
    log('info', 'Apoio enviado e confirmado.', {
      sourceTownId: source.id,
      targetTownId: destination.town.id,
      commandId: movement.id,
      attackArrivalAt: referenceArrivalAt,
      attackArrivalIso: new Date(referenceArrivalAt).toISOString(),
      movementStartedAt: movement.startedAt,
      movementStartedHasMilliseconds: movement.startedHasMilliseconds,
      sentAtEstimate,
      sentAt,
      cancelAt,
      desiredReturnAt: finalDesiredReturnAt,
      tactic: job.tactic,
      returnOffsetMs
    });
    if (!feasible.allowed) {
      log('warn', 'Viagem real inviável; cancelamento imediato.', { reason: feasible.reason });
      job.stage = 'scheduled';
      await cancelJob(job, feasible.reason);
    }
  }

  function reconcileWaves(waves) {
    for (const wave of waves) {
      const relatedJobs = [...jobs.values()].filter((candidate) => (
        candidate.targetTownId === wave.targetTownId
        && ['scheduled', 'cancelling'].includes(candidate.stage)
        && wave.firstArrivalAt <= candidate.lastArrivalAt + CONFIG.waveGapSeconds * 1_000
      ));
      for (const job of relatedJobs) {
        if (job.stage !== 'scheduled') continue;
        const ncChanged = Boolean(wave.ncArrivalAt) && wave.ncArrivalAt !== job.ncArrivalAt;
        if (wave.lastArrivalAt <= job.lastArrivalAt && !ncChanged) continue;
        job.lastArrivalAt = wave.lastArrivalAt;
        job.commandIds = wave.commandIds;
        job.attacks = wave.attacks;
        job.ncArrivalAt = wave.ncArrivalAt;
        job.ncConfidence = wave.ncConfidence;
        const referenceAttack = wave.ncArrivalAt
          ? wave.attacks?.find((attack) => attack.arrivalAt === wave.ncArrivalAt)
          : null;
        job.returnOffsetMs = chooseReturnOffset({
          nc: Boolean(wave.ncArrivalAt),
          hasMilliseconds: Boolean(referenceAttack?.arrivalHasMilliseconds) && serverClockHasMilliseconds(),
          uncertaintyMs: timingUncertaintyMs()
        });
        const referenceArrivalAt = wave.ncArrivalAt || wave.lastArrivalAt;
        job.tactic = wave.ncArrivalAt ? 'nc-snipe' : 'dodge';
        job.desiredReturnAt = referenceArrivalAt + job.returnOffsetMs;
        job.cancelAt = calculateCancelAt(job.sentAt, referenceArrivalAt, job.returnOffsetMs);
        const feasible = cancellationFeasibility({
          sentAt: job.sentAt, cancelAt: job.cancelAt, outboundArrivalAt: job.outboundArrivalAt
        });
        if (!feasible.allowed) job.forceCancelReason = `wave-extension:${feasible.reason}`;
      }
      persistJobs();
    }
  }

  function acquireLock() {
    try {
      const now = Date.now();
      const current = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      if (current && current.ownerId !== ownerId && current.expiresAt > now) return false;
      localStorage.setItem(LOCK_KEY, JSON.stringify({ ownerId, expiresAt: now + CONFIG.lockTtlMs }));
      return true;
    } catch { return true; }
  }

  async function scan() {
    if (stopped || busy || !acquireLock()) return;
    busy = true;
    try {
      const now = serverNowMs();
      const rawAttacks = incomingAttacks();
      // A milícia depende apenas da chegada; não deve ficar bloqueada se a
      // classificação logística de NC ou o mapa público falharem.
      reconcileMilitia(rawAttacks);
      const attacks = await classifyAttacks(rawAttacks);
      const waves = groupAttackWaves(attacks, CONFIG.waveGapSeconds);
      reconcileWaves(waves);
      const candidate = waves.find((wave) => {
        const related = [...jobs.values()].find((job) => (
          job.targetTownId === wave.targetTownId
          && wave.firstArrivalAt <= job.lastArrivalAt + CONFIG.waveGapSeconds * 1_000
          && (
            ['scheduled', 'cancelling'].includes(job.stage)
            || (job.stage === 'done' && (
              wave.lastArrivalAt <= job.lastArrivalAt
              || now < number(job.expectedReturnAt) + 1_000
            ))
            || (job.stage === 'blocked' && wave.lastArrivalAt <= job.lastArrivalAt)
          )
        ));
        if (related) return false;
        const seconds = (wave.firstArrivalAt - now) / 1_000;
        return seconds <= CONFIG.sendLeadSeconds && seconds >= CONFIG.minimumSendLeadSeconds;
      });
      if (candidate) {
        const attempt = [...jobs.values()].filter((job) => job.targetTownId === candidate.targetTownId).length;
        await startJob({ ...candidate, id: `${candidate.id}:attempt:${attempt}` });
      }
    } catch (error) { log('error', 'Ciclo de monitorização falhou.', { error: error.message }); }
    finally { busy = false; }
  }

  async function heartbeat() {
    if (stopped || !acquireLock()) return;
    const current = performance.now();
    const slip = current - lastHeartbeatAt - CONFIG.heartbeatIntervalMs;
    lastHeartbeatAt = current;
    const now = serverNowMs();
    if (now - lastPurificationScanAt >= CONFIG.purificationScanIntervalMs) {
      lastPurificationScanAt = now;
      monitorPurification();
    }
    for (const job of jobs.values()) {
      if (job.stage !== 'scheduled') continue;
      if (job.forceCancelReason) {
        await cancelJob(job, job.forceCancelReason);
        continue;
      }
      const dispatchAt = job.cancelAt - latencyMs / 2;
      if (now >= dispatchAt) {
        if (slip > CONFIG.maximumTimerSlipMs) {
          log('warn', 'Temporizador atrasado; cancelamento executado assim que possível.', { slipMs: Math.round(slip) });
        }
        await cancelJob(job);
      }
    }
    for (const job of militiaJobs.values()) {
      if (job.stage !== 'scheduled') continue;
      const advanceMs = Math.max(
        CONFIG.militiaLeadMs,
        CONFIG.militiaLeadMs + latencyMs / 2 + CONFIG.militiaLatencySafetyMs
      );
      const dispatchAt = job.attackArrivalAt - advanceMs;
      if (now >= dispatchAt) await activateMilitia(job);
    }
  }

  function restoreJobs() {
    const stored = load(STORAGE_KEY, {});
    for (const raw of stored.jobs || []) {
      if (['scheduled', 'cancelling'].includes(raw.stage)) {
        const exists = movements().some((movement) => movement.id === String(raw.commandId) && !movement.returning);
        raw.stage = exists ? 'scheduled' : 'blocked';
        if (!exists) raw.error = 'command-missing-after-reload';
      }
      jobs.set(raw.id, raw);
    }
    for (const raw of stored.militiaJobs || []) {
      if (raw.stage === 'activating') raw.stage = 'blocked';
      if (raw.stage === 'active' && number(raw.activeUntil) <= serverNowMs()) raw.stage = 'expired';
      militiaJobs.set(String(raw.townId), raw);
    }
    for (const raw of stored.purificationJobs || []) {
      if (['scheduled', 'casting'].includes(raw.stage)) {
        raw.stage = 'blocked';
        raw.error = 'cast-status-unknown-after-reload';
      }
      purificationJobs.set(String(raw.targetTownId), raw);
    }
  }

  function start() {
    stopped = false;
    clearInterval(scanTimer);
    clearInterval(heartbeatTimer);
    scanTimer = setInterval(scan, CONFIG.scanIntervalMs);
    heartbeatTimer = setInterval(() => heartbeat().catch((error) => log('error', error.message)), CONFIG.heartbeatIntervalMs);
    scan();
    log('info', `Grepolis Dodge v${VERSION} iniciado.`, { world: page.Game?.world_id || location.hostname });
  }

  function stop() {
    stopped = true;
    clearInterval(scanTimer);
    clearInterval(heartbeatTimer);
    log('warn', 'Grepolis Dodge desativado pela consola.');
  }

  async function waitForBindings() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (page.gpAjax && page.ITowns && page.MM && page.Timestamp) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async function boot() {
    if (page.__grepolisDodgeLoaded) return;
    page.__grepolisDodgeLoaded = VERSION;
    if (!await waitForBindings()) {
      console.error(PREFIX, 'APIs internas do Grepolis não ficaram disponíveis; script parado.');
      return;
    }
    restoreJobs();
    page.GrepolisDodge = Object.freeze({
      version: VERSION,
      start,
      stop,
      status: () => ({
        stopped,
        busy,
        latencyMs: Math.round(latencyMs),
        timingUncertaintyMs: timingUncertaintyMs(),
        jobs: [...jobs.values()],
        militiaJobs: [...militiaJobs.values()],
        purificationJobs: [...purificationJobs.values()]
      }),
      logs: () => load(LOG_KEY, [])
    });
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch((error) => console.error(PREFIX, error)), { once: true });
  } else boot().catch((error) => console.error(PREFIX, error));
}());
