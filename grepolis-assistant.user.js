// ==UserScript==
// @name         Grepolis Assistant PT
// @namespace    https://grepolis.com/
// @version      1.5.0
// @description  Assistente defensivo com validação temporal, reservas e cálculo de sorte.
// @author       Codex
// @match        https://*.grepolis.com/game/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisAssistantFactory() {
  'use strict';

  const VERSION = '1.5.0';
  const STORAGE_KEY = 'ga.settings.v1';
  const LOG_KEY = 'ga.logs.v1';
  const SEEN_KEY = 'ga.seen.v1';
  const ACTION_KEY = 'ga.actions.v1';
  const MAX_LOGS = 150;
  const CURRENT_TOWN_NAME_SELECTOR = '#ui_box > div.town_name_area > div.town_groups_dropdown.btn_toggle_town_groups_menu > div.caption.js-viewport > div';
  const TOWN_DROPDOWN_SELECTOR = '#ui_box > div.town_name_area > div.town_groups_dropdown.btn_toggle_town_groups_menu';
  const TOWN_LIST_SPAN_SELECTOR = '#town_groups_list > div.content.js-dropdown-item-list.town_groups_list > div.town_group > div.group_towns.ui-droppable > div > span';
  const NEXT_TOWN_SELECTOR = '#ui_box > div.town_name_area > div.btn_next_town.button_arrow.right';
  const PREV_TOWN_SELECTOR = '#ui_box > div.town_name_area > div.btn_prev_town.button_arrow.left';

  const DEFAULTS = Object.freeze({
    enabled: true,
    simulation: true,
    warningSeconds: 300,
    dodgeLeadSeconds: 90,
    caveReserve: 5_000,
    caveTarget: 25_000,
    autoConfirmCave: false,
    caveConfirmMax: 10_000,
    caveSessionBudget: 30_000,
    executionArmMinutes: 10,
    autoSendSupport: false,
    supportSessionLimit: 3,
    supportMinLeadSeconds: 30,
    supportExecutionArmMinutes: 10,
    supportSendPercent: 100,
    supportReservePerUnit: 0,
    supportMinimumTotal: 1,
    supportArrivalBufferSeconds: 10,
    supportRequireTravelTime: true,
    luckAttackStrength: 100_000,
    luckDefenseStrength: 100_000,
    luckMorale: 100,
    luckAttackBonus: 0,
    luckDefenseBonus: 0,
    luckSelected: 0,
    scanInterval: 5_000,
    waveGapSeconds: 300,
    autoPrepareCave: true,
    autoPrepareDodge: true,
    automationArmMinutes: 30,
    automationFailureLimit: 3,
    watchdogStaleSeconds: 20,
    collapsed: false,
    activeTab: 'threats',
    panelX: null,
    panelY: null,
    launcherSide: 'right',
    dodgeTargetTownId: '',
    dodgeFallbackTownId: '',
    autoSelectFallback: true,
    townPolicies: {}
  });

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function timestampMs(value) {
    const parsed = number(value);
    if (!parsed) return 0;
    return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  }

  function readAttribute(source, names, fallback = '') {
    const attributes = source?.attributes || source || {};
    for (const name of names) {
      const value = attributes[name] ?? source?.[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  }

  function canonicalType(value) {
    const text = String(value || '').toLowerCase();
    if (/spy|espion|spying/.test(text)) return 'spy';
    if (/support|apoio|refor/.test(text)) return 'support';
    if (/attack|ataque|revolt|colon/.test(text)) return 'attack';
    return 'unknown';
  }

  function plainText(value) {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function playerNameFromOriginLink(value, originName = '') {
    const text = plainText(value);
    if (!text) return '';
    const parenthesized = [...text.matchAll(/\(([^()]+)\)/g)].at(-1)?.[1]?.trim();
    if (parenthesized && normalizeTownLabel(parenthesized) !== normalizeTownLabel(originName)) {
      return parenthesized;
    }
    return '';
  }

  function normalizeCommand(raw, now = Date.now()) {
    const arrivalAt = timestampMs(readAttribute(raw, [
      'arrival_at',
      'arrivalAt',
      'arrival_time',
      'arrival',
      'finished_at',
      'end_at'
    ]));
    const typeText = readAttribute(raw, [
      'command_type',
      'type',
      'movement_type',
      'attack_type',
      'name'
    ], 'unknown');
    const origin = String(readAttribute(raw, [
      'origin_town_name',
      'home_town_name',
      'town_name_origin',
      'origin_name',
      'origin',
      'source_town_name'
    ], 'Origem desconhecida'));
    const target = String(readAttribute(raw, [
      'target_town_name',
      'town_name_destination',
      'target_name',
      'target',
      'destination_town_name'
    ], 'Cidade atual'));
    const id = String(readAttribute(raw, [
      'id',
      'command_id',
      'model_id'
    ], `${typeText}:${origin}:${target}:${arrivalAt || now}`));
    const targetTownId = String(readAttribute(raw, [
      'target_town_id',
      'targetTownId',
      'destination_town_id',
      'destination_id',
      'town_id'
    ], ''));
    const originTownId = String(readAttribute(raw, [
      'origin_town_id',
      'home_town_id',
      'originTownId',
      'source_town_id',
      'source_id'
    ], ''));
    const playerId = String(readAttribute(raw, [
      'player_id',
      'origin_player_id',
      'home_player_id'
    ], ''));
    const explicitPlayerName = String(readAttribute(raw, [
      'player_name',
      'origin_player_name',
      'home_player_name',
      'town_player_name',
      'player'
    ], ''));
    const playerName = explicitPlayerName || playerNameFromOriginLink(
      readAttribute(raw, ['link_origin', 'origin_link'], ''),
      origin
    );

    return {
      id,
      type: canonicalType(typeText),
      rawType: String(typeText),
      origin,
      target,
      originTownId,
      targetTownId,
      playerId,
      playerName,
      arrivalAt: arrivalAt || now,
      detectedAt: now,
      synthetic: Boolean(readAttribute(raw, ['synthetic'], false))
    };
  }

  function extractTownResources(town) {
    let resources = {};
    try {
      if (typeof town?.resources === 'function') resources = town.resources() || {};
      else if (typeof town?.getResources === 'function') resources = town.getResources() || {};
      else resources = town?.resources || {};
    } catch {
      resources = {};
    }
    return {
      wood: number(resources.wood ?? resources.get?.('wood') ?? 0),
      stone: number(resources.stone ?? resources.get?.('stone') ?? 0),
      silver: number(
        resources.iron
        ?? resources.silver
        ?? resources.get?.('iron')
        ?? resources.get?.('silver')
        ?? town?.getResource?.('iron')
        ?? town?.getResource?.('silver')
        ?? 0
      )
    };
  }

  function assessThreat(command, now = Date.now(), settings = DEFAULTS) {
    const seconds = Math.max(0, Math.floor((command.arrivalAt - now) / 1_000));
    const base = command.type === 'spy' ? 45 : command.type === 'attack' ? 60 : 10;
    const proximity = seconds <= 60 ? 40
      : seconds <= number(settings.warningSeconds, 300) ? 30
        : seconds <= 1_800 ? 15 : 0;
    const score = Math.min(100, base + proximity);
    const level = score >= 90 ? 'critical'
      : score >= 70 ? 'high'
        : score >= 45 ? 'medium' : 'low';
    return { score, level, seconds };
  }

  function calculateCaveDeposit({
    availableSilver,
    storedSilver,
    reserve,
    target
  }) {
    const spendable = Math.max(0, Math.floor(number(availableSilver) - number(reserve)));
    const missing = Math.max(0, Math.floor(number(target) - number(storedSilver)));
    return Math.min(spendable, missing);
  }

  function calculateDodgeAt(arrivalAt, leadSeconds) {
    return number(arrivalAt) - Math.max(0, number(leadSeconds)) * 1_000;
  }

  function parseDurationSeconds(value) {
    const text = plainText(value);
    const match = text.match(/(?:^|\D)(\d{1,3}):([0-5]\d):([0-5]\d)(?:\D|$)/);
    if (match) {
      return number(match[1]) * 3_600 + number(match[2]) * 60 + number(match[3]);
    }
    const short = text.match(/(?:^|\D)(\d{1,3}):([0-5]\d)(?:\D|$)/);
    if (short) return number(short[1]) * 60 + number(short[2]);
    const hours = number(text.match(/(\d+)\s*h/i)?.[1]);
    const minutes = number(text.match(/(\d+)\s*m(?:in)?/i)?.[1]);
    const seconds = number(text.match(/(\d+)\s*s(?:eg)?/i)?.[1]);
    const total = hours * 3_600 + minutes * 60 + seconds;
    return total > 0 ? total : null;
  }

  function calculateLuckScenario({
    attackStrength = 0,
    defenseStrength = 0,
    morale = 100,
    attackBonus = 0,
    defenseBonus = 0,
    selectedLuck = 0
  } = {}) {
    const attack = Math.max(0, number(attackStrength));
    const defense = Math.max(0, number(defenseStrength));
    const moralePercent = Math.max(0, Math.min(100, number(morale, 100)));
    const luck = Math.max(-30, Math.min(30, number(selectedLuck)));
    const attackBonusFactor = Math.max(0, 1 + number(attackBonus) / 100);
    const defenseBonusFactor = Math.max(0, 1 + number(defenseBonus) / 100);
    const attackBeforeLuck = attack * (moralePercent / 100) * attackBonusFactor;
    const effectiveDefense = defense * defenseBonusFactor;
    const effectiveAttack = attackBeforeLuck * (1 + luck / 100);
    const requiredLuck = attackBeforeLuck > 0
      ? ((effectiveDefense / attackBeforeLuck) - 1) * 100
      : Number.POSITIVE_INFINITY;
    const ratio = effectiveDefense > 0
      ? effectiveAttack / effectiveDefense
      : effectiveAttack > 0 ? Number.POSITIVE_INFINITY : 1;
    const status = effectiveDefense <= 0 || requiredLuck <= -30
      ? 'guaranteed'
      : requiredLuck <= 30 ? 'possible' : 'impossible';
    const scenarios = [-30, 0, 30].map((scenarioLuck) => {
      const scenarioAttack = attackBeforeLuck * (1 + scenarioLuck / 100);
      return {
        luck: scenarioLuck,
        attack: scenarioAttack,
        ratio: effectiveDefense > 0
          ? scenarioAttack / effectiveDefense
          : scenarioAttack > 0 ? Number.POSITIVE_INFINITY : 1,
        favorable: scenarioAttack >= effectiveDefense
      };
    });

    return {
      attack,
      defense,
      morale: moralePercent,
      attackBeforeLuck,
      effectiveAttack,
      effectiveDefense,
      selectedLuck: luck,
      requiredLuck,
      ratio,
      margin: effectiveAttack - effectiveDefense,
      favorable: effectiveAttack >= effectiveDefense,
      status,
      scenarios
    };
  }

  function automationDecision(command, now = Date.now(), settings = DEFAULTS) {
    if (!command || number(command.arrivalAt) <= number(now)) {
      return { action: '', due: false, reason: 'expired' };
    }
    if (command.type === 'spy') {
      return {
        action: 'cave',
        due: Boolean(settings.autoPrepareCave)
          && number(command.arrivalAt) - number(now) <= number(settings.warningSeconds, 300) * 1_000,
        reason: settings.autoPrepareCave ? 'waiting' : 'disabled'
      };
    }
    if (command.type === 'attack') {
      return {
        action: 'dodge',
        due: Boolean(settings.autoPrepareDodge)
          && number(now) >= calculateDodgeAt(command.arrivalAt, settings.dodgeLeadSeconds),
        reason: settings.autoPrepareDodge ? 'waiting' : 'disabled'
      };
    }
    return { action: '', due: false, reason: 'unsupported' };
  }

  function resolveTownPolicy(townId, settings = DEFAULTS) {
    const override = settings.townPolicies?.[String(townId)] || {};
    return {
      caveEnabled: override.caveEnabled ?? Boolean(settings.autoPrepareCave),
      dodgeEnabled: override.dodgeEnabled ?? Boolean(settings.autoPrepareDodge),
      safeTownId: String(override.safeTownId ?? settings.dodgeTargetTownId ?? ''),
      fallbackSafeTownId: String(
        override.fallbackSafeTownId ?? settings.dodgeFallbackTownId ?? ''
      ),
      priority: ['high', 'normal', 'low'].includes(override.priority)
        ? override.priority : 'normal',
      canReceiveDodge: override.canReceiveDodge ?? true,
      warningSeconds: Math.max(0, number(
        override.warningSeconds,
        settings.warningSeconds
      )),
      dodgeLeadSeconds: Math.max(0, number(
        override.dodgeLeadSeconds,
        settings.dodgeLeadSeconds
      ))
    };
  }

  function selectSafeDestination({
    threatenedTownId,
    preferredTownId = '',
    fallbackTownIds = [],
    availableTowns = [],
    blockedTownIds = [],
    threatenedTownIds = [],
    allowAnyFallback = true
  }) {
    const threatened = String(threatenedTownId || '');
    const blocked = new Set([...blockedTownIds, ...threatenedTownIds].map(String));
    blocked.add(threatened);
    const available = new Map(
      availableTowns.map((town) => [String(town.id), town])
    );
    const explicit = [
      String(preferredTownId || ''),
      ...fallbackTownIds.map((id) => String(id || ''))
    ].filter(Boolean);
    const candidates = [
      ...explicit,
      ...(allowAnyFallback
        ? [...available.values()]
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt'))
          .map((town) => String(town.id))
        : [])
    ];
    const townId = candidates.find((id, index) => (
      available.has(id)
      && !blocked.has(id)
      && candidates.indexOf(id) === index
    )) || '';
    return {
      townId,
      usedFallback: Boolean(townId && townId !== String(preferredTownId || '')),
      reason: townId
        ? townId === String(preferredTownId || '') ? 'preferred' : 'fallback'
        : 'unavailable'
    };
  }

  function reactionPriorityOffset(priority) {
    return priority === 'high' ? -15_000 : priority === 'low' ? 15_000 : 0;
  }

  function compareReactionCandidates(left, right) {
    const leftAt = number(left.command?.arrivalAt)
      + reactionPriorityOffset(left.decision?.policy?.priority);
    const rightAt = number(right.command?.arrivalAt)
      + reactionPriorityOffset(right.decision?.policy?.priority);
    return leftAt - rightAt || number(left.command?.arrivalAt) - number(right.command?.arrivalAt);
  }

  function nextAutomationFailureState(success, consecutiveFailures = 0, failureLimit = 3) {
    if (success) return { consecutiveFailures: 0, breakerOpen: false };
    const failures = Math.max(0, number(consecutiveFailures)) + 1;
    return {
      consecutiveFailures: failures,
      breakerOpen: failures >= Math.max(1, number(failureLimit, 3))
    };
  }

  function automationHealth({
    enabled,
    armedUntil,
    busy,
    breakerOpen,
    consecutiveFailures,
    lastScanAt
  }, now = Date.now(), staleSeconds = 20) {
    const scanAgeSeconds = lastScanAt
      ? Math.max(0, Math.floor((number(now) - number(lastScanAt)) / 1_000))
      : null;
    if (!enabled) return { status: 'off', label: 'Pausada', scanAgeSeconds };
    if (breakerOpen) {
      return { status: 'blocked', label: 'Proteção ativada', scanAgeSeconds };
    }
    if (scanAgeSeconds === null || scanAgeSeconds > Math.max(1, number(staleSeconds, 20))) {
      return { status: 'warning', label: 'Leitura atrasada', scanAgeSeconds };
    }
    if (busy) return { status: 'busy', label: 'A executar', scanAgeSeconds };
    if (number(consecutiveFailures) > 0) {
      return { status: 'warning', label: 'Falhas recentes', scanAgeSeconds };
    }
    return {
      status: number(armedUntil) > number(now) ? 'armed' : 'healthy',
      label: number(armedUntil) > number(now) ? 'Armada' : 'Saudável',
      scanAgeSeconds
    };
  }

  function caveExecutionDecision({
    enabled = false,
    armed = false,
    simulation = false,
    amount = 0,
    maxPerDeposit = 0,
    spentInSession = 0,
    sessionBudget = 0
  } = {}) {
    const deposit = Math.max(0, Math.floor(number(amount)));
    if (!enabled) return { allowed: false, reason: 'disabled' };
    if (simulation) return { allowed: false, reason: 'simulation' };
    if (!armed) return { allowed: false, reason: 'not-armed' };
    if (deposit <= 0) return { allowed: false, reason: 'invalid-amount' };
    if (deposit > Math.max(0, number(maxPerDeposit))) {
      return { allowed: false, reason: 'deposit-limit' };
    }
    if (number(spentInSession) + deposit > Math.max(0, number(sessionBudget))) {
      return { allowed: false, reason: 'session-budget' };
    }
    return { allowed: true, reason: 'allowed' };
  }

  function supportExecutionDecision({
    enabled = false,
    armed = false,
    simulation = false,
    synthetic = false,
    secondsUntilArrival = 0,
    minLeadSeconds = 0,
    sentInSession = 0,
    sessionLimit = 0,
    selectedUnits = 0,
    travelSeconds = null,
    arrivalBufferSeconds = 0,
    requireTravelTime = true
  } = {}) {
    const hasTravelTime = travelSeconds !== null
      && travelSeconds !== undefined
      && travelSeconds !== ''
      && Number.isFinite(Number(travelSeconds));
    if (!enabled) return { allowed: false, reason: 'disabled' };
    if (simulation) return { allowed: false, reason: 'simulation' };
    if (synthetic) return { allowed: false, reason: 'synthetic' };
    if (!armed) return { allowed: false, reason: 'not-armed' };
    if (number(secondsUntilArrival) < Math.max(0, number(minLeadSeconds))) {
      return { allowed: false, reason: 'insufficient-lead' };
    }
    if (number(sentInSession) >= Math.max(1, number(sessionLimit, 1))) {
      return { allowed: false, reason: 'session-limit' };
    }
    if (number(selectedUnits) <= 0) return { allowed: false, reason: 'no-units' };
    if (requireTravelTime && !hasTravelTime) {
      return { allowed: false, reason: 'travel-time-unknown' };
    }
    if (hasTravelTime
      && number(travelSeconds) + Math.max(0, number(arrivalBufferSeconds))
        >= number(secondsUntilArrival)) {
      return { allowed: false, reason: 'arrival-too-late' };
    }
    return { allowed: true, reason: 'allowed' };
  }

  function calculateSupportSelection(
    availableUnits = [],
    sendPercent = 100,
    reservePerUnit = 0
  ) {
    const percent = Math.max(0, Math.min(100, number(sendPercent, 100)));
    const reserve = Math.max(0, Math.floor(number(reservePerUnit)));
    const units = availableUnits.map((unit) => {
      const available = Math.max(0, Math.floor(number(unit?.available ?? unit)));
      const movable = Math.max(0, available - reserve);
      const selected = Math.min(movable, Math.floor(movable * percent / 100));
      return {
        name: String(unit?.name || ''),
        available,
        reserve: Math.min(reserve, available),
        movable,
        selected
      };
    });
    return {
      percent,
      reservePerUnit: reserve,
      units,
      availableTotal: units.reduce((sum, unit) => sum + unit.available, 0),
      selectedTotal: units.reduce((sum, unit) => sum + unit.selected, 0)
    };
  }

  function analyzePreflight({
    towns = [],
    settings = DEFAULTS,
    capabilities = {},
    reactions = []
  } = {}) {
    const errors = [];
    const warnings = [];
    const add = (list, code, message, townId = '') => {
      if (!list.some((issue) => issue.code === code && issue.townId === String(townId))) {
        list.push({ code, message, townId: String(townId || '') });
      }
    };
    const townIds = new Set(towns.map((town) => String(town.id)));
    const attackedTownIds = reactions
      .filter((reaction) => reaction.type === 'attack')
      .map((reaction) => String(reaction.targetTownId));
    const blockedTownIds = towns
      .filter((town) => !resolveTownPolicy(town.id, settings).canReceiveDodge)
      .map((town) => String(town.id));

    if (!settings.enabled) {
      add(errors, 'monitoring-disabled', 'A monitorização está desativada.');
    }
    if (!towns.length) {
      add(errors, 'no-towns', 'Nenhuma cidade foi carregada pelo jogo.');
    }
    if (!capabilities.layoutTownSwitch) {
      add(errors, 'town-switch-missing', 'Não foi detetado um método fiável para trocar de cidade.');
    }
    if (number(settings.automationArmMinutes) < 1) {
      add(errors, 'arm-duration-invalid', 'O período de armamento tem de ser pelo menos 1 minuto.');
    }
    if (number(settings.automationFailureLimit) < 1) {
      add(errors, 'failure-limit-invalid', 'O limite de falhas tem de ser pelo menos 1.');
    }
    const scanSeconds = Math.max(2, number(settings.scanInterval, 5_000) / 1_000);
    if (number(settings.watchdogStaleSeconds) <= scanSeconds) {
      add(
        errors,
        'watchdog-too-short',
        'O limite do watchdog tem de ser superior ao intervalo de leitura.'
      );
    } else if (number(settings.watchdogStaleSeconds) < scanSeconds * 2) {
      add(
        warnings,
        'watchdog-tight',
        'O watchdog está muito próximo do intervalo de leitura e pode interromper sessões lentas.'
      );
    }
    if (settings.autoPrepareCave
      && !capabilities.caveBuilding
      && !capabilities.caveInput) {
      add(errors, 'cave-unavailable', 'A gruta e o respetivo campo não foram detetados.');
    }
    if (settings.autoConfirmCave) {
      if (number(settings.caveConfirmMax) <= 0) {
        add(errors, 'cave-confirm-limit-invalid', 'O limite por depósito automático tem de ser superior a zero.');
      }
      if (number(settings.caveSessionBudget) <= 0) {
        add(errors, 'cave-session-budget-invalid', 'O orçamento da sessão da gruta tem de ser superior a zero.');
      }
      if (number(settings.caveSessionBudget) < number(settings.caveConfirmMax)) {
        add(
          warnings,
          'cave-budget-below-limit',
          'O orçamento da sessão é inferior ao limite de um depósito.'
        );
      }
      if (number(settings.executionArmMinutes) < 1) {
        add(errors, 'execution-duration-invalid', 'O armamento da execução tem de durar pelo menos 1 minuto.');
      }
    }
    if (settings.autoSendSupport) {
      if (number(settings.supportSessionLimit) < 1) {
        add(errors, 'support-session-limit-invalid', 'O limite de apoios por sessão tem de ser pelo menos 1.');
      }
      if (number(settings.supportMinLeadSeconds) < 5) {
        add(errors, 'support-lead-invalid', 'A margem mínima do apoio tem de ser pelo menos 5 segundos.');
      }
      if (number(settings.supportExecutionArmMinutes) < 1) {
        add(errors, 'support-duration-invalid', 'O armamento de apoios tem de durar pelo menos 1 minuto.');
      }
      if (number(settings.supportSendPercent) <= 0
        || number(settings.supportSendPercent) > 100) {
        add(errors, 'support-percent-invalid', 'A percentagem de tropas tem de estar entre 1% e 100%.');
      }
      if (number(settings.supportReservePerUnit) < 0) {
        add(errors, 'support-reserve-invalid', 'A reserva por tipo de unidade não pode ser negativa.');
      }
      if (number(settings.supportMinimumTotal) < 1) {
        add(errors, 'support-minimum-invalid', 'O mínimo total do apoio tem de ser pelo menos 1 unidade.');
      }
      if (number(settings.supportArrivalBufferSeconds) < 0) {
        add(errors, 'support-arrival-buffer-invalid', 'A margem de chegada não pode ser negativa.');
      }
    }
    if (settings.autoPrepareDodge && !capabilities.mapJump) {
      add(errors, 'map-jump-missing', 'O salto no mapa não está disponível para preparar desvios.');
    }
    if (settings.autoPrepareDodge && towns.length < 2) {
      add(errors, 'insufficient-towns', 'São necessárias pelo menos duas cidades para preparar desvios.');
    }

    Object.entries(settings.townPolicies || {}).forEach(([townId, policy]) => {
      if (!townIds.has(String(townId))) {
        add(
          warnings,
          `orphan-policy:${townId}`,
          `Existe uma política guardada para uma cidade que já não está disponível: ${townId}.`,
          townId
        );
      }
      ['safeTownId', 'fallbackSafeTownId'].forEach((field) => {
        const destination = String(policy?.[field] || '');
        if (destination && !townIds.has(destination)) {
          add(
            warnings,
            `missing-policy-destination:${townId}:${field}`,
            `A política da cidade ${townId} aponta para um destino inexistente.`,
            townId
          );
        }
      });
    });

    towns.forEach((town) => {
      const policy = resolveTownPolicy(town.id, settings);
      if (!policy.dodgeEnabled) return;
      const choice = selectSafeDestination({
        threatenedTownId: town.id,
        preferredTownId: policy.safeTownId,
        fallbackTownIds: [
          policy.fallbackSafeTownId,
          settings.dodgeFallbackTownId
        ].filter(Boolean),
        availableTowns: towns,
        blockedTownIds,
        threatenedTownIds: attackedTownIds,
        allowAnyFallback: Boolean(settings.autoSelectFallback)
      });
      if (!choice.townId) {
        add(
          errors,
          `no-safe-destination:${town.id}`,
          `${town.name}: não existe um destino seguro disponível.`,
          town.id
        );
      } else if (choice.usedFallback) {
        add(
          warnings,
          `fallback-required:${town.id}`,
          `${town.name}: o destino principal não está disponível; será usada uma alternativa.`,
          town.id
        );
      }
    });

    const score = Math.max(0, 100 - errors.length * 25 - warnings.length * 5);
    return {
      passed: errors.length === 0,
      errors,
      warnings,
      score
    };
  }

  function policyDecision(command, now = Date.now(), settings = DEFAULTS) {
    const policy = resolveTownPolicy(command?.targetTownId, settings);
    return {
      ...automationDecision(command, now, {
        ...settings,
        autoPrepareCave: policy.caveEnabled,
        autoPrepareDodge: policy.dodgeEnabled,
        warningSeconds: policy.warningSeconds,
        dodgeLeadSeconds: policy.dodgeLeadSeconds
      }),
      policy
    };
  }

  function groupThreats(commands, gapSeconds = 300) {
    const gapMs = Math.max(0, number(gapSeconds, 300)) * 1_000;
    const groups = new Map();
    [...commands]
      .sort((a, b) => a.arrivalAt - b.arrivalAt)
      .forEach((command) => {
        const targetKey = String(command.targetTownId || command.target || 'unknown');
        const key = `${command.type}:${targetKey}`;
        const incidents = groups.get(key) || [];
        const current = incidents.at(-1);
        if (!current || command.arrivalAt - current.lastArrivalAt > gapMs) {
          incidents.push({
            id: `incident:${key}:${command.id}`,
            type: command.type,
            target: command.target,
            targetTownId: command.targetTownId,
            origin: command.origin,
            originTownId: command.originTownId,
            playerId: command.playerId,
            playerName: command.playerName,
            arrivalAt: command.arrivalAt,
            lastArrivalAt: command.arrivalAt,
            detectedAt: command.detectedAt,
            synthetic: command.synthetic,
            commands: [command],
            origins: [command.origin],
            originLabels: [formatCommandOrigin(command)],
            count: 1
          });
          groups.set(key, incidents);
          return;
        }
        current.commands.push(command);
        current.lastArrivalAt = command.arrivalAt;
        current.origins = [...new Set([...current.origins, command.origin])];
        current.originLabels = [
          ...new Set([...current.originLabels, formatCommandOrigin(command)])
        ];
        current.count = current.commands.length;
        current.synthetic = current.commands.every((item) => item.synthetic);
        current.origin = current.origins.length === 1
          ? current.origins[0]
          : `${current.origins.length} origens`;
        current.playerName = current.originLabels.length === 1
          ? command.playerName
          : '';
      });
    return [...groups.values()]
      .flat()
      .sort((a, b) => a.arrivalAt - b.arrivalAt);
  }

  function groupReactions(commands) {
    return groupThreats(commands, Number.MAX_SAFE_INTEGER / 1_000);
  }

  function formatDuration(totalSeconds) {
    const safe = Math.max(0, Math.floor(number(totalSeconds)));
    const hours = Math.floor(safe / 3_600);
    const minutes = Math.floor((safe % 3_600) / 60);
    const seconds = safe % 60;
    const tail = `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    return hours ? `${hours}h ${tail}` : tail;
  }

  function formatClock(timestamp) {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleTimeString('pt-PT', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function clampPanelPosition(x, y, viewportWidth, viewportHeight, panelWidth = 360, panelHeight = 240) {
    return {
      x: Math.max(0, Math.min(number(x), Math.max(0, number(viewportWidth) - panelWidth))),
      y: Math.max(0, Math.min(number(y), Math.max(0, number(viewportHeight) - panelHeight)))
    };
  }

  function numericInputValue(value) {
    const digits = String(value ?? '').replace(/[^\d-]/g, '');
    return number(digits);
  }

  function normalizeTownLabel(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('pt');
  }

  function buildMapTownPayload(townId, town, townName = '') {
    return {
      id: Number(townId),
      x: town?.getIslandCoordinateX?.() ?? town?.attributes?.island_x,
      y: town?.getIslandCoordinateY?.() ?? town?.attributes?.island_y,
      name: townName || town?.getName?.() || town?.attributes?.name || ''
    };
  }

  function isOwnMovement(command, ownTownIds, ownPlayerId = '') {
    if (command.synthetic) return false;
    const ownPlayer = String(ownPlayerId || '');
    return Boolean(
      (command.originTownId && ownTownIds.has(String(command.originTownId)))
      || (
        !command.originTownId
        && ownPlayer
        && command.playerId
        && String(command.playerId) === ownPlayer
      )
    );
  }

  const Core = {
    VERSION,
    DEFAULTS,
    canonicalType,
    normalizeCommand,
    assessThreat,
    calculateCaveDeposit,
    calculateDodgeAt,
    parseDurationSeconds,
    calculateLuckScenario,
    formatDuration,
    timestampMs,
    clampPanelPosition,
    extractTownResources,
    numericInputValue,
    normalizeTownLabel,
    playerNameFromOriginLink,
    formatCommandOrigin,
    buildMapTownPayload,
    isOwnMovement,
    automationDecision,
    resolveTownPolicy,
    policyDecision,
    groupThreats,
    groupReactions,
    selectSafeDestination,
    compareReactionCandidates,
    nextAutomationFailureState,
    automationHealth,
    analyzePreflight,
    caveExecutionDecision,
    supportExecutionDecision,
    calculateSupportSelection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  }

  if (typeof window === 'undefined' || !window.document) return;

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const state = {
    settings: load(STORAGE_KEY, DEFAULTS),
    logs: load(LOG_KEY, []),
    actions: load(ACTION_KEY, []),
    seen: new Set(load(SEEN_KEY, [])),
    commands: [],
    incidents: [],
    reactions: [],
    syntheticCommands: [],
    towns: [],
    townsById: new Map(),
    currentTown: null,
    timer: null,
    clockTimer: null,
    observer: null,
    dock: null,
    launcher: null,
    root: null,
    drag: null,
    suppressLauncherClick: false,
    diagnostic: null,
    preflight: {
      passed: false,
      errors: [],
      warnings: [],
      score: 0,
      at: 0
    },
    validation: {
      kind: '',
      status: 'idle',
      message: 'Ainda não foi executado um teste assistido.',
      at: 0
    },
    automation: {
      armedUntil: 0,
      busy: false,
      handled: new Map(),
      consecutiveFailures: 0,
      breakerOpen: false,
      breakerReason: '',
      lastScanAt: 0,
      lastAutomationAt: 0,
      lastSuccessAt: 0
    },
    execution: {
      caveArmedUntil: 0,
      spentSilver: 0,
      confirmations: 0,
      lastTownId: '',
      lastAmount: 0,
      lastAt: 0,
      supportArmedUntil: 0,
      supportCommandsSent: 0,
      supportLastTownId: '',
      supportLastTargetId: '',
      supportLastUnits: 0,
      supportLastAt: 0
    },
    scrollByTab: {
      threats: 0,
      cave: 0,
      luck: 0,
      settings: 0,
      policies: 0,
      actions: 0,
      logs: 0,
      diagnostic: 0
    }
  };

  state.settings = { ...DEFAULTS, ...state.settings };
  if (!state.settings.townPolicies || typeof state.settings.townPolicies !== 'object') {
    state.settings.townPolicies = {};
  }
  if (!Array.isArray(state.actions)) state.actions = [];

  function load(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('[GA] Não foi possível guardar dados.', error);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function log(kind, message, details = {}) {
    state.logs.unshift({
      id: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      kind,
      message,
      details
    });
    state.logs = state.logs.slice(0, MAX_LOGS);
    save(LOG_KEY, state.logs);
  }

  function modelAttributes(model) {
    if (!model) return null;
    if (model.attributes) return model;
    if (typeof model.toJSON === 'function') {
      return { id: model.id, attributes: model.toJSON() };
    }
    return model;
  }

  function collectModels(value, output, visited, depth = 0) {
    if (!value || depth > 5 || visited.has(value)) return;
    if (typeof value === 'object') visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => collectModels(item, output, visited, depth + 1));
      return;
    }

    if (Array.isArray(value.models)) {
      value.models.forEach((model) => output.push(modelAttributes(model)));
      return;
    }

    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => {
        if (/command|movement/i.test(key)) {
          collectModels(child, output, visited, depth + 1);
        }
      });
    }
  }

  function readGameCommands() {
    const output = [];
    try {
      const movements = page.MM?.getModels?.()?.MovementsUnits;
      if (movements && typeof movements === 'object') {
        Object.values(movements).forEach((model) => output.push(modelAttributes(model)));
      }
      if (!output.length) {
        const collection = page.MM?.getOnlyCollectionByName?.('MovementsUnits');
        collection?.models?.forEach((model) => output.push(modelAttributes(model)));
      }
    } catch (error) {
      console.debug('[GA] Movimentos globais ainda indisponíveis.', error);
    }

    if (output.length) {
      const now = gameNowMs();
      return output
        .map((raw) => normalizeCommand(raw))
        .filter((command) => (
          command.arrivalAt > now - 30_000
          && ['attack', 'spy', 'support'].includes(command.type)
        ));
    }

    try {
      const collections = page.MM?.getCollections?.();
      collectModels(collections, output, new Set());
    } catch (error) {
      console.debug('[GA] Modelos de comandos ainda indisponíveis.', error);
    }

    const now = gameNowMs();
    return output
      .map((raw) => normalizeCommand(raw))
      .filter((command) => (
        command.arrivalAt > now - 30_000
        && ['attack', 'spy', 'support'].includes(command.type)
      ));
  }

  function gameNowMs() {
    try {
      const server = page.Timestamp?.server?.();
      const parsed = timestampMs(server);
      if (parsed) return parsed;
    } catch {
      // Browser time is the safe fallback.
    }
    return Date.now();
  }

  function parseArrivalFromText(text) {
    const match = String(text).match(/(?:(\d{1,2})h\s*)?(\d{1,2})m\s*(\d{1,2})s/i)
      || String(text).match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) return 0;
    const hours = number(match[1]);
    const minutes = number(match[2]);
    const seconds = number(match[3]);
    return gameNowMs() + ((hours * 3_600) + (minutes * 60) + seconds) * 1_000;
  }

  function readDomCommands() {
    const selectors = [
      '#toolbar_activity_commands_list .command',
      '.activity.commands .command',
      '.command_list .command',
      '[data-command_id]'
    ];
    const nodes = [...document.querySelectorAll(selectors.join(','))];
    return nodes.map((node, index) => {
      const text = node.textContent || '';
      const classText = `${node.className} ${node.getAttribute('data-command_type') || ''} ${text}`;
      return normalizeCommand({
        id: node.getAttribute('data-command_id') || `dom:${index}:${text.slice(0, 50)}`,
        command_type: classText,
        arrival_at: parseArrivalFromText(text) || Date.now() + 3_600_000,
        origin_town_name: node.getAttribute('data-origin_town_name') || 'Origem não revelada',
        target_town_name: node.getAttribute('data-target_town_name') || readCurrentTown().name,
        target_town_id: node.getAttribute('data-target_town_id') || readCurrentTown().id
      });
    }).filter((command) => command.type !== 'unknown');
  }

  function normalizeTown(town, fallbackId = '') {
    const resources = extractTownResources(town);
    const espionageStorage = number(
      town?.getEspionageStorage?.()
      ?? town?.get?.('espionage_storage')
      ?? town?.attributes?.espionage_storage
      ?? 0
    );

    return {
      id: String(town?.getId?.() ?? town?.id ?? fallbackId ?? ''),
      name: String(
        town?.getName?.()
        ?? town?.get?.('name')
        ?? town?.attributes?.name
        ?? town?.name
        ?? `Cidade ${fallbackId || ''}`
      ).trim(),
      wood: resources.wood,
      stone: resources.stone,
      silver: resources.silver,
      caveSilver: espionageStorage
    };
  }

  function buildDiagnostic() {
    let movementModels = null;
    let currentRawTown = null;
    try {
      movementModels = page.MM?.getModels?.()?.MovementsUnits ?? null;
    } catch {
      movementModels = null;
    }
    try {
      currentRawTown = page.ITowns?.getCurrentTown?.() ?? null;
    } catch {
      currentRawTown = null;
    }
    const sampleMovement = movementModels && typeof movementModels === 'object'
      ? Object.values(movementModels)[0]?.attributes
      : null;
    const townResourceMethods = [
      typeof currentRawTown?.resources === 'function' ? 'resources()' : '',
      typeof currentRawTown?.getResources === 'function' ? 'getResources()' : '',
      typeof currentRawTown?.getResource === 'function' ? 'getResource()' : ''
    ].filter(Boolean);
    const townSwitchMethods = [
      typeof page.Layout?.townSwitch === 'function' ? 'Layout.townSwitch' : '',
      typeof page.Layout?.switchTown === 'function' ? 'Layout.switchTown' : '',
      typeof page.ITowns?.setCurrentTown === 'function' ? 'ITowns.setCurrentTown' : '',
      typeof page.ITowns?.switchTown === 'function' ? 'ITowns.switchTown' : ''
    ].filter(Boolean);
    const currentTownId = String(page.Game?.townId || state.currentTown?.id || '');
    const townSwitchDom = Boolean(currentTownId && findTownSwitchNode(
      currentTownId,
      state.currentTown?.name
    ));
    const townCycle = findNextTownNodes().length > 0;

    const health = automationHealth({
      enabled: state.settings.enabled,
      armedUntil: state.automation.armedUntil,
      busy: state.automation.busy,
      breakerOpen: state.automation.breakerOpen,
      consecutiveFailures: state.automation.consecutiveFailures,
      lastScanAt: state.automation.lastScanAt
    }, Date.now(), state.settings.watchdogStaleSeconds);

    const diagnostic = {
      version: VERSION,
      world: String(page.Game?.world_id || location.hostname),
      currentTownId,
      towns: state.towns.length,
      commands: state.commands.length,
      movementModels: movementModels && typeof movementModels === 'object'
        ? Object.keys(movementModels).length : 0,
      movementFields: sampleMovement ? Object.keys(sampleMovement).sort() : [],
      resourceMethods: townResourceMethods,
      townSwitchMethods,
      townSwitchDom,
      townCycle,
      layoutTownSwitch: townSwitchMethods.length > 0 || townSwitchDom || townCycle,
      mapJump: typeof page.WMap?.mapJump === 'function',
      caveBuilding: Boolean(document.querySelector('#building_hide, [data-building="hide"], .building_hide')),
      caveInput: Boolean(findCaveInput()),
      commandToolbar: Boolean(document.querySelector('#toolbar_activity_commands, .toolbar_activities .commands')),
      health,
      automationFailures: state.automation.consecutiveFailures,
      breakerOpen: state.automation.breakerOpen,
      breakerReason: state.automation.breakerReason,
      lastScanAt: state.automation.lastScanAt,
      lastAutomationAt: state.automation.lastAutomationAt,
      lastSuccessAt: state.automation.lastSuccessAt,
      caveExecutionArmed: isCaveExecutionArmed(),
      caveExecutionRemaining: caveExecutionRemainingSeconds(),
      caveSpentSilver: state.execution.spentSilver,
      caveConfirmations: state.execution.confirmations,
      caveLastAmount: state.execution.lastAmount,
      caveLastAt: state.execution.lastAt,
      supportExecutionArmed: isSupportExecutionArmed(),
      supportExecutionRemaining: supportExecutionRemainingSeconds(),
      supportCommandsSent: state.execution.supportCommandsSent,
      supportLastTownId: state.execution.supportLastTownId,
      supportLastTargetId: state.execution.supportLastTargetId,
      supportLastUnits: state.execution.supportLastUnits,
      supportLastAt: state.execution.supportLastAt,
      generatedAt: Date.now()
    };
    state.preflight = {
      ...analyzePreflight({
        towns: state.towns,
        settings: state.settings,
        capabilities: diagnostic,
        reactions: state.reactions
      }),
      at: Date.now()
    };
    diagnostic.preflight = state.preflight;
    return diagnostic;
  }

  function readCurrentTown() {
    let town;
    try {
      town = page.ITowns?.getCurrentTown?.();
    } catch {
      town = null;
    }
    const normalized = normalizeTown(town, page.Game?.townId ?? '');
    if (!normalized.name || /^Cidade\s*$/.test(normalized.name)) {
      normalized.name = String(
        page.Game?.townName
        ?? document.querySelector('#town_name')?.textContent
        ?? 'Cidade atual'
      ).trim();
    }
    return normalized;
  }

  function readAllTowns() {
    let source = null;
    try {
      source = page.ITowns?.towns ?? page.ITowns?.getTowns?.() ?? null;
    } catch {
      source = null;
    }

    const towns = [];
    if (Array.isArray(source)) {
      source.forEach((town, index) => towns.push(normalizeTown(town, town?.id ?? index)));
    } else if (source && typeof source === 'object') {
      Object.entries(source).forEach(([id, town]) => towns.push(normalizeTown(town, id)));
    }

    const valid = towns.filter((town) => town.id || town.name);
    if (!valid.length) valid.push(readCurrentTown());
    return [...new Map(valid.map((town) => [town.id || town.name, town])).values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  }

  function decorateCommands(commands) {
    return commands.map((command) => {
      const playerName = command.playerName || resolvePlayerName(command.playerId);
      const knownTown = state.townsById.get(String(command.targetTownId));
      if (knownTown) return { ...command, target: knownTown.name, playerName };
      const nameMatch = state.towns.find((town) => town.name === command.target);
      return nameMatch
        ? { ...command, targetTownId: nameMatch.id, playerName }
        : { ...command, playerName };
    });
  }

  function resolvePlayerName(playerId) {
    const wanted = String(playerId || '');
    if (!wanted) return '';
    try {
      const models = page.MM?.getModels?.() || {};
      const candidates = [
        models.Players,
        models.Player,
        models.PlayerProfile,
        page.MM?.getOnlyCollectionByName?.('Players'),
        page.MM?.getOnlyCollectionByName?.('Player')
      ];
      for (const source of candidates) {
        if (!source) continue;
        const values = Array.isArray(source.models)
          ? source.models
          : typeof source === 'object' ? Object.values(source) : [];
        for (const model of values) {
          const attributes = modelAttributes(model);
          const id = String(attributes.id ?? attributes.player_id ?? model?.id ?? '');
          if (id !== wanted) continue;
          const name = attributes.name
            ?? attributes.player_name
            ?? attributes.username
            ?? model?.getName?.();
          if (name) return String(name);
        }
      }
    } catch {
      // Player models are optional; the city name is still shown.
    }
    return '';
  }

  function dedupeCommands(commands) {
    const unique = new Map();
    commands.forEach((command) => {
      const key = command.id || `${command.type}:${command.origin}:${command.arrivalAt}`;
      if (!unique.has(key)) unique.set(key, command);
    });
    return [...unique.values()].sort((a, b) => a.arrivalAt - b.arrivalAt);
  }

  function scan({ render = true } = {}) {
    if (!state.settings.enabled) return;
    state.automation.lastScanAt = Date.now();
    state.towns = readAllTowns();
    state.townsById = new Map(state.towns.map((town) => [String(town.id), town]));
    state.currentTown = readCurrentTown();
    const models = readGameCommands();
    const fallback = models.length ? [] : readDomCommands();
    const ownTownIds = new Set(state.towns.map((town) => String(town.id)));
    const ownPlayerId = String(page.Game?.player_id || page.Game?.playerId || '');
    const now = gameNowMs();
    state.commands = decorateCommands(
      dedupeCommands([...models, ...fallback, ...state.syntheticCommands])
    )
      .filter((command) => (
        command.arrivalAt > now - 5_000
        && (command.synthetic || ownTownIds.has(String(command.targetTownId)))
        && !isOwnMovement(command, ownTownIds, ownPlayerId)
      ));
    state.incidents = groupThreats(state.commands, state.settings.waveGapSeconds);
    state.reactions = groupReactions(state.commands);
    state.diagnostic = buildDiagnostic();

    state.commands.forEach((command) => {
      if (state.seen.has(command.id)) return;
      state.seen.add(command.id);
      const assessment = assessThreat(command, now, state.settings);
      log('threat', `${labelType(command.type)} detetado para ${command.target}`, {
        command,
        assessment
      });
    });

    const seen = [...state.seen].slice(-500);
    save(SEEN_KEY, seen);
    syncActionCenter(now);
    if (render) renderPanel();
    void runAutomation();
  }

  function labelType(type) {
    return type === 'spy' ? 'Espionagem'
      : type === 'attack' ? 'Ataque'
        : type === 'support' ? 'Apoio' : 'Comando';
  }

  function formatCommandOrigin(command) {
    const origin = String(command?.origin || 'Origem desconhecida');
    const playerName = String(command?.playerName || '').trim();
    return playerName && normalizeTownLabel(playerName) !== normalizeTownLabel(origin)
      ? `${origin} (${playerName})`
      : origin;
  }

  function labelRisk(level) {
    return {
      critical: 'Crítico',
      high: 'Alto',
      medium: 'Médio',
      low: 'Baixo'
    }[level] || level;
  }

  function recommendation(command, assessment) {
    const policy = resolveTownPolicy(command.targetTownId, state.settings);
    if (command.type === 'spy') {
      if (!policy.caveEnabled) return 'Preparação automática da gruta desativada nesta cidade.';
      return assessment.seconds <= policy.warningSeconds
        ? 'Reforça a gruta imediatamente e confirma a reserva de prata.'
        : 'Confirma a prata guardada e acompanha a aproximação.';
    }
    if (command.type === 'attack') {
      if (!policy.dodgeEnabled) return 'Preparação automática do desvio desativada nesta cidade.';
      const dodgeAt = calculateDodgeAt(command.arrivalAt, policy.dodgeLeadSeconds);
      return gameNowMs() >= dodgeAt
        ? 'Janela de desvio aberta: prepara a retirada das tropas.'
        : `Preparar desvio às ${formatClock(dodgeAt)}.`;
    }
    return 'Confirma a origem e a capacidade disponível na cidade.';
  }

  function automationKey(command, action) {
    return `${action}:town:${command.targetTownId || command.id}`;
  }

  function actionLabel(status) {
    return {
      waiting: 'À espera',
      ready: 'Pronta',
      running: 'Em curso',
      success: 'Preparada',
      error: 'Falhou',
      skipped: 'Ignorada',
      blocked: 'Bloqueada',
      expired: 'Expirada',
      executed: 'Executada'
    }[status] || status;
  }

  function priorityLabel(priority) {
    return {
      high: 'Alta',
      normal: 'Normal',
      low: 'Baixa'
    }[priority] || 'Normal';
  }

  function upsertAction(command, action, status, message = '') {
    const id = automationKey(command, action);
    const existing = state.actions.find((item) => item.id === id);
    const next = {
      id,
      commandId: command.id,
      commandIds: command.commands?.map((item) => item.id) || [command.id],
      action,
      type: command.type,
      target: command.target,
      targetTownId: command.targetTownId,
      arrivalAt: command.arrivalAt,
      lastArrivalAt: command.lastArrivalAt || command.arrivalAt,
      waveCount: command.count || 1,
      originCount: command.origins?.length || 1,
      priority: resolveTownPolicy(command.targetTownId, state.settings).priority,
      status,
      message,
      updatedAt: Date.now()
    };
    if (existing
      && existing.status === next.status
      && existing.message === next.message
      && existing.arrivalAt === next.arrivalAt
      && existing.waveCount === next.waveCount
      && existing.lastArrivalAt === next.lastArrivalAt) return existing;
    state.actions = [
      next,
      ...state.actions.filter((item) => item.id !== id)
    ].slice(0, 100);
    save(ACTION_KEY, state.actions);
    return next;
  }

  function updateTownActions(action, townId, status, message) {
    const incident = state.reactions.find((item) => (
      String(item.targetTownId) === String(townId)
      && (action === 'cave' ? item.type === 'spy' : item.type === 'attack')
    ));
    if (incident) upsertAction(incident, action, status, message);
  }

  function syncActionCenter(now = gameNowMs()) {
    const activeIds = new Set();
    state.reactions.forEach((command) => {
      const decision = policyDecision(command, now, state.settings);
      if (!decision.action) return;
      const id = automationKey(command, decision.action);
      activeIds.add(id);
      const handled = state.automation.handled.get(id);
      const existing = state.actions.find((item) => item.id === id);
      const terminalStatus = existing
        && ['success', 'executed', 'error', 'skipped', 'blocked'].includes(existing.status)
        ? existing.status
        : '';
      const safeChoice = decision.action === 'dodge' ? chooseSafeTown(command) : null;
      const safeUnavailable = decision.action === 'dodge' && !safeChoice.townId;
      const status = handled?.status
        || terminalStatus
        || (decision.reason === 'disabled' || safeUnavailable
          ? 'blocked'
          : decision.due ? 'ready' : 'waiting');
      const destination = decision.action === 'dodge'
        ? state.townsById.get(safeChoice.townId)?.name || 'cidade segura não definida'
        : command.target;
      const message = decision.reason === 'disabled'
        ? `Regra de ${decision.action === 'cave' ? 'gruta' : 'desvio'} desativada nesta cidade.`
        : safeUnavailable
          ? 'Não existe uma cidade segura disponível. Verifica destinos e bloqueios.'
        : terminalStatus
        ? existing.message
        : decision.action === 'dodge'
          ? `Desvio para ${destination}${safeChoice.usedFallback ? ' (alternativa)' : ''}.`
          : `Preparação da gruta de ${command.target}.`;
      upsertAction(
        command,
        decision.action,
        status,
        message
      );
    });
    state.actions.forEach((action) => {
      if (!activeIds.has(action.id)
        && ['waiting', 'ready', 'running'].includes(action.status)) {
        action.status = 'expired';
        action.updatedAt = Date.now();
      }
    });
    save(ACTION_KEY, state.actions);
  }

  function resetActiveActions() {
    const activeActionIds = new Set(state.reactions.flatMap((incident) => {
      const decision = policyDecision(incident, gameNowMs(), state.settings);
      return decision.action ? [automationKey(incident, decision.action)] : [];
    }));
    state.actions = state.actions.map((action) => (
      activeActionIds.has(action.id)
        ? { ...action, status: 'waiting', updatedAt: Date.now() }
        : action
    ));
    save(ACTION_KEY, state.actions);
  }

  function threatenedAttackTownIds() {
    return state.reactions
      .filter((reaction) => reaction.type === 'attack')
      .map((reaction) => String(reaction.targetTownId));
  }

  function blockedSafeTownIds() {
    return state.towns
      .filter((town) => !resolveTownPolicy(town.id, state.settings).canReceiveDodge)
      .map((town) => String(town.id));
  }

  function chooseSafeTown(command, preferredOverride = '') {
    const policy = resolveTownPolicy(command.targetTownId, state.settings);
    return selectSafeDestination({
      threatenedTownId: command.targetTownId,
      preferredTownId: preferredOverride || policy.safeTownId,
      fallbackTownIds: [
        policy.fallbackSafeTownId,
        state.settings.dodgeFallbackTownId
      ].filter(Boolean),
      availableTowns: state.towns,
      blockedTownIds: blockedSafeTownIds(),
      threatenedTownIds: threatenedAttackTownIds(),
      allowAnyFallback: Boolean(state.settings.autoSelectFallback)
    });
  }

  function automationRemainingSeconds(now = gameNowMs()) {
    return Math.max(0, Math.ceil((state.automation.armedUntil - now) / 1_000));
  }

  function isAutomationArmed(now = gameNowMs()) {
    return automationRemainingSeconds(now) > 0;
  }

  function caveExecutionRemainingSeconds(now = gameNowMs()) {
    return Math.max(0, Math.ceil((state.execution.caveArmedUntil - now) / 1_000));
  }

  function isCaveExecutionArmed(now = gameNowMs()) {
    return caveExecutionRemainingSeconds(now) > 0;
  }

  function supportExecutionRemainingSeconds(now = gameNowMs()) {
    return Math.max(0, Math.ceil((state.execution.supportArmedUntil - now) / 1_000));
  }

  function isSupportExecutionArmed(now = gameNowMs()) {
    return supportExecutionRemainingSeconds(now) > 0;
  }

  function modeText(now = gameNowMs()) {
    if (state.automation.breakerOpen) return 'PROTEÇÃO ATIVADA — auto-preparação bloqueada';
    if (state.settings.simulation) return 'MODO SIMULAÇÃO — nenhuma ação real';
    if (isSupportExecutionArmed(now)) {
      return `ENVIO DE APOIO ARMADO — ${formatDuration(supportExecutionRemainingSeconds(now))}`;
    }
    if (isCaveExecutionArmed(now)) {
      return `EXECUÇÃO DA GRUTA ARMADA — ${formatDuration(caveExecutionRemainingSeconds(now))}`;
    }
    if (isAutomationArmed(now)) {
      return `AUTO-PREPARAÇÃO ARMADA — ${formatDuration(automationRemainingSeconds(now))}`;
    }
    return 'MODO ASSISTIDO — confirmação obrigatória';
  }

  function caveSnapshots() {
    return (state.towns.length ? state.towns : readAllTowns()).map((town) => ({
      ...town,
      deposit: calculateCaveDeposit({
        availableSilver: town.silver,
        storedSilver: town.caveSilver,
        reserve: state.settings.caveReserve,
        target: state.settings.caveTarget
      })
    }));
  }

  function injectStyles() {
    if (document.getElementById('ga-styles')) return;
    const style = document.createElement('style');
    style.id = 'ga-styles';
    style.textContent = `
      #ga-dock{position:fixed;right:12px;top:148px;z-index:100001;width:410px;display:flex;align-items:flex-start;justify-content:flex-end;gap:6px;pointer-events:auto}
      #ga-dock.ga-collapsed{width:44px;pointer-events:none}
      #ga-dock.ga-launcher-left{flex-direction:row-reverse}
      #ga-launcher{position:relative;flex:0 0 44px;margin-top:8px;z-index:2;width:44px;height:44px;border:2px solid #d8a93d;border-radius:50%;background:linear-gradient(#173b50,#0b2433);color:#f6d477;font:700 14px Georgia,serif;box-shadow:0 3px 12px #000a;cursor:grab;pointer-events:auto;touch-action:none;user-select:none}
      #ga-launcher:active{cursor:grabbing}
      #ga-launcher[data-alert="true"]{animation:ga-pulse 1.1s infinite;background:linear-gradient(#7b201e,#3e1110)}
      #ga-panel{position:relative;flex:0 0 360px;width:360px;max-height:calc(100vh - 16px);display:flex;flex-direction:column;color:#ecdfbd;background:#102832f2;border:2px solid #b88a35;border-radius:7px;box-shadow:0 8px 30px #000b;font:13px Arial,sans-serif;overflow:hidden;backdrop-filter:blur(4px)}
      #ga-panel.ga-hidden{display:none}
      #ga-panel *{box-sizing:border-box}
      .ga-head{display:flex;align-items:center;gap:9px;padding:9px 11px;background:linear-gradient(90deg,#1c4a5c,#102c3c);border-bottom:1px solid #b88a35;cursor:move;user-select:none;touch-action:none}
      .ga-title{font:700 16px Georgia,serif;color:#f5d67e;flex:1}.ga-version{font-size:10px;opacity:.65}.ga-icon-btn{border:0;background:transparent;color:#e9cf8b;font-size:18px;cursor:pointer}
      .ga-head,.ga-mode,.ga-tabs,.ga-footer{flex:0 0 auto}
      .ga-mode{padding:6px 10px;text-align:center;font-weight:700;background:#173f31;color:#9ce2b4;border-bottom:1px solid #365b4b}.ga-mode.sim{background:#4a3d18;color:#ffe396}.ga-mode.armed{background:#5a251c;color:#ffd2a0}.ga-mode.blocked{background:#651b1b;color:#ffd0d0}
      .ga-tabs{display:grid;grid-template-columns:repeat(4,1fr);background:#0b202a}.ga-tab{padding:7px 1px;border:0;border-bottom:2px solid transparent;background:transparent;color:#cbbd9b;font-size:9px;cursor:pointer}.ga-tab.active{color:#ffd978;border-color:#d5a635;background:#173440}
      .ga-content{padding:10px;overflow-x:hidden;overflow-y:auto;min-height:0;flex:1 1 auto;overscroll-behavior:contain;scrollbar-gutter:stable;touch-action:pan-y}.ga-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:9px}.ga-stat{padding:7px;text-align:center;background:#071a22;border:1px solid #315160;border-radius:4px}.ga-stat strong{display:block;font-size:18px;color:#f5d16e}.ga-stat span{font-size:10px;opacity:.75}
      .ga-empty{padding:25px 12px;text-align:center;color:#bfb596;border:1px dashed #4b6370;border-radius:5px}.ga-card{margin:0 0 8px;padding:9px;background:#0b1f28;border-left:4px solid #668391;border-radius:4px}.ga-card.high{border-color:#eb9a34}.ga-card.critical{border-color:#e34d42;background:#30191b}.ga-card.medium{border-color:#e4c55c}.ga-card-top{display:flex;gap:6px;align-items:center}.ga-card-top strong{flex:1;color:#fff0bb}.ga-badge{padding:2px 6px;border-radius:10px;background:#263f49;font-size:10px}.ga-countdown{font:700 14px monospace;color:#fff}.ga-route{margin:6px 0;color:#bfcdd0}.ga-advice{color:#ead79f;font-size:12px}.ga-actions{display:flex;gap:6px;margin-top:8px}
      .ga-btn{padding:7px 9px;border:1px solid #b18434;border-radius:4px;background:linear-gradient(#d6ad55,#96702d);color:#1e1608;font-weight:700;cursor:pointer}.ga-btn.secondary{background:#173b49;color:#e8d8aa;border-color:#527180}.ga-btn.danger{background:#7c2923;color:#fff0df;border-color:#b54a42}.ga-btn:disabled{opacity:.45;cursor:not-allowed}
      .ga-section{margin-bottom:10px;padding:9px;background:#0b1f28;border:1px solid #2e4a57;border-radius:5px}.ga-section h3{margin:0 0 8px;color:#f4d276;font:700 14px Georgia,serif}.ga-row{display:flex;justify-content:space-between;gap:10px;padding:4px 0}.ga-row strong{color:#fff0bd}.ga-field{display:grid;grid-template-columns:1fr 120px;align-items:center;gap:8px;margin:8px 0}.ga-field input[type="number"],.ga-field select{width:100%;padding:5px;background:#071820;color:#fff;border:1px solid #516b75;border-radius:3px}.ga-check{display:flex;align-items:center;gap:8px;margin:8px 0}.ga-log{padding:7px 0;border-bottom:1px solid #29424c}.ga-log small{display:block;color:#8fa8b0;margin-top:3px}.ga-footer{padding:7px 10px;background:#091b23;border-top:1px solid #2a4652;color:#8da3aa;font-size:10px}.ga-status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#6ed28a;margin-right:5px}.ga-status-dot.off{background:#d46a5f}
      .ga-city{margin-bottom:8px;padding:9px;background:#0b1f28;border:1px solid #2e4a57;border-radius:5px}.ga-city.current{border-color:#b88a35}.ga-city-head{display:flex;align-items:center;gap:6px;margin-bottom:5px}.ga-city-head strong{flex:1;color:#f4d276}.ga-current{font-size:9px;padding:2px 5px;border-radius:8px;background:#785d25;color:#ffecb5}
      .ga-ok{color:#7ee29b}.ga-fail{color:#ef7d72}.ga-code{padding:7px;background:#06151c;border:1px solid #29434e;border-radius:4px;color:#b8d5df;font:10px monospace;word-break:break-word}
      .ga-toast{position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:100010;padding:10px 16px;background:#112b36;color:#ffe3a0;border:1px solid #d2a144;border-radius:5px;box-shadow:0 4px 16px #000a}
      @keyframes ga-pulse{50%{box-shadow:0 0 0 8px #e84e412b,0 3px 12px #000a}}
      @media(max-width:800px){#ga-dock{width:calc(100vw - 8px)}#ga-panel{flex-basis:min(360px,calc(100vw - 58px));width:min(360px,calc(100vw - 58px));max-height:calc(100vh - 16px)}}
    `;
    document.head.appendChild(style);
  }

  function createShell() {
    injectStyles();
    if (!document.getElementById('ga-dock')) {
      state.dock = document.createElement('div');
      state.dock.id = 'ga-dock';
      document.body.appendChild(state.dock);
    } else {
      state.dock = document.getElementById('ga-dock');
    }

    if (!document.getElementById('ga-panel')) {
      state.root = document.createElement('aside');
      state.root.id = 'ga-panel';
      state.root.addEventListener('click', handlePanelClick);
      state.root.addEventListener('change', handlePanelChange);
      state.root.addEventListener('pointerdown', handleDragStart);
      state.root.addEventListener('scroll', handlePanelScroll, true);
      state.dock.appendChild(state.root);
    } else {
      state.root = document.getElementById('ga-panel');
      if (state.root.parentElement !== state.dock) state.dock.appendChild(state.root);
    }

    if (!document.getElementById('ga-launcher')) {
      const launcher = document.createElement('button');
      launcher.id = 'ga-launcher';
      launcher.type = 'button';
      launcher.textContent = 'GA';
      launcher.title = 'Grepolis Assistant';
      launcher.addEventListener('pointerdown', handleLauncherDragStart);
      launcher.addEventListener('click', (event) => {
        if (state.suppressLauncherClick) {
          state.suppressLauncherClick = false;
          event.preventDefault();
          return;
        }
        togglePanel();
      });
      state.dock.appendChild(launcher);
      state.launcher = launcher;
    } else {
      state.launcher = document.getElementById('ga-launcher');
      if (state.launcher.parentElement !== state.dock) state.dock.appendChild(state.launcher);
    }
    applyPanelPosition();
  }

  function applyPanelPosition() {
    if (!state.root || !state.dock) return;
    state.dock.classList.toggle('ga-collapsed', state.settings.collapsed);
    state.dock.classList.toggle('ga-launcher-left', state.settings.launcherSide === 'left');
    if (state.settings.panelX === null || state.settings.panelY === null) {
      state.dock.style.left = '';
      state.dock.style.right = '12px';
      state.dock.style.top = '148px';
      state.root.style.maxHeight = `${Math.max(180, window.innerHeight - 156)}px`;
      return;
    }
    const position = clampPanelPosition(
      state.settings.panelX,
      state.settings.panelY,
      window.innerWidth,
      window.innerHeight,
      state.dock.offsetWidth || 410,
      Math.min(state.root.offsetHeight || 240, window.innerHeight - 8)
    );
    state.dock.style.left = `${position.x}px`;
    state.dock.style.top = `${position.y}px`;
    state.dock.style.right = 'auto';
    state.root.style.maxHeight = `${Math.max(180, window.innerHeight - position.y - 8)}px`;
  }

  function togglePanel() {
    const launcherRect = state.launcher.getBoundingClientRect();
    const dockRect = state.dock.getBoundingClientRect();
    if (!state.settings.collapsed) {
      state.settings.collapsed = true;
      state.settings.panelX = launcherRect.left;
      state.settings.panelY = dockRect.top;
    } else {
      state.settings.collapsed = false;
      const openWidth = 410;
      if (launcherRect.left + openWidth <= window.innerWidth) {
        state.settings.launcherSide = 'left';
        state.settings.panelX = launcherRect.left;
      } else {
        state.settings.launcherSide = 'right';
        state.settings.panelX = launcherRect.left - (openWidth - launcherRect.width);
      }
      state.settings.panelY = dockRect.top;
    }
    save(STORAGE_KEY, state.settings);
    renderPanel();
  }

  function handleDragStart(event) {
    if (!event.target.closest('.ga-head') || event.target.closest('button')) return;
    beginDrag(event);
  }

  function handleLauncherDragStart(event) {
    beginDrag(event);
  }

  function beginDrag(event) {
    const rect = state.dock.getBoundingClientRect();
    state.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      fromLauncher: event.currentTarget?.id === 'ga-launcher',
      moved: false
    };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function handleDragMove(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    const position = clampPanelPosition(
      event.clientX - state.drag.offsetX,
      event.clientY - state.drag.offsetY,
      window.innerWidth,
      window.innerHeight,
      state.dock.offsetWidth || 410,
      Math.min(state.root.offsetHeight || 240, window.innerHeight - 8)
    );
    if (Math.abs(event.clientX - state.drag.startX) > 3
      || Math.abs(event.clientY - state.drag.startY) > 3) {
      state.drag.moved = true;
      if (state.drag.fromLauncher) state.suppressLauncherClick = true;
    }
    state.settings.panelX = position.x;
    state.settings.panelY = position.y;
    applyPanelPosition();
  }

  function handleDragEnd(event) {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    const shouldReleaseClick = state.drag.fromLauncher && state.drag.moved;
    state.drag = null;
    save(STORAGE_KEY, state.settings);
    if (shouldReleaseClick) {
      setTimeout(() => {
        state.suppressLauncherClick = false;
      }, 150);
    }
  }

  function handlePanelWheel(event) {
    const content = event.target instanceof Element
      ? event.target.closest('.ga-content')
      : null;
    if (!content) return;
    const deltaY = number(event.deltaY, -number(event.wheelDelta));
    const deltaX = number(event.deltaX);
    content.scrollTop += deltaY;
    content.scrollLeft += deltaX;
    state.scrollByTab[state.settings.activeTab] = content.scrollTop;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function handlePanelScroll(event) {
    if (!event.target.classList?.contains('ga-content')) return;
    state.scrollByTab[state.settings.activeTab] = event.target.scrollTop;
  }

  function rememberCurrentScroll() {
    const content = state.root?.querySelector('.ga-content');
    if (!content) return;
    const renderedTab = state.root.querySelector('.ga-tab.active')?.dataset.tab
      || state.settings.activeTab;
    state.scrollByTab[renderedTab] = content.scrollTop;
  }

  function restoreCurrentScroll() {
    const content = state.root?.querySelector('.ga-content');
    if (!content) return;
    const wanted = number(state.scrollByTab[state.settings.activeTab]);
    content.scrollTop = wanted;
    requestAnimationFrame(() => {
      const current = state.root?.querySelector('.ga-content');
      if (current) current.scrollTop = wanted;
    });
  }

  function renderPanel() {
    createShell();
    rememberCurrentScroll();
    const urgent = state.commands.filter((command) => (
      assessThreat(command, gameNowMs(), state.settings).level === 'critical'
    )).length;
    state.launcher.dataset.alert = String(urgent > 0);
    state.root.classList.toggle('ga-hidden', state.settings.collapsed);
    state.dock.classList.toggle('ga-collapsed', state.settings.collapsed);
    if (state.settings.collapsed) return;

    state.root.innerHTML = `
      <div class="ga-head">
        <span aria-hidden="true">🛡️</span>
        <div class="ga-title">Grepolis Assistant <span class="ga-version">v${VERSION}</span></div>
        <button class="ga-icon-btn" data-action="refresh" title="Atualizar">↻</button>
        <button class="ga-icon-btn" data-action="collapse" title="Minimizar">×</button>
      </div>
      <div class="ga-mode ${state.automation.breakerOpen ? 'blocked' : state.settings.simulation ? 'sim' : isAutomationArmed() || isCaveExecutionArmed() || isSupportExecutionArmed() ? 'armed' : ''}">
        ${modeText()}
      </div>
      <nav class="ga-tabs">
        ${tabButton('threats', 'Ameaças')}
        ${tabButton('cave', 'Gruta')}
        ${tabButton('luck', 'Sorte')}
        ${tabButton('actions', 'Ações')}
        ${tabButton('policies', 'Políticas')}
        ${tabButton('settings', 'Definições')}
        ${tabButton('logs', 'Registo')}
        ${tabButton('diagnostic', 'Diagnóstico')}
      </nav>
      <div class="ga-content">${renderActiveTab()}</div>
      <div class="ga-footer">
        <span class="ga-status-dot ${state.settings.enabled ? '' : 'off'}"></span>
        ${state.settings.enabled ? 'Monitorização ativa' : 'Monitorização pausada'}
        · ${state.towns.length} ${state.towns.length === 1 ? 'cidade' : 'cidades'} monitorizadas
      </div>
    `;
    applyPanelPosition();
    restoreCurrentScroll();
  }

  function tabButton(id, label) {
    return `<button class="ga-tab ${state.settings.activeTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
  }

  function renderActiveTab() {
    if (state.settings.activeTab === 'cave') return renderCave();
    if (state.settings.activeTab === 'luck') return renderLuck();
    if (state.settings.activeTab === 'actions') return renderActions();
    if (state.settings.activeTab === 'policies') return renderPolicies();
    if (state.settings.activeTab === 'settings') return renderSettings();
    if (state.settings.activeTab === 'logs') return renderLogs();
    if (state.settings.activeTab === 'diagnostic') return renderDiagnostic();
    return renderThreats();
  }

  function renderThreats() {
    const counts = state.commands.reduce((result, command) => {
      result[command.type] = (result[command.type] || 0) + 1;
      return result;
    }, {});
    const affectedCities = new Set(
      state.commands.map((command) => command.targetTownId || command.target)
    ).size;
    const cards = state.incidents.map((command) => {
      const assessment = assessThreat(command, gameNowMs(), state.settings);
      const policy = resolveTownPolicy(command.targetTownId, state.settings);
      const spanSeconds = Math.max(0, Math.round(
        (command.lastArrivalAt - command.arrivalAt) / 1_000
      ));
      return `
        <article class="ga-card ${assessment.level}" data-incident-id="${escapeHtml(command.id)}">
          <div class="ga-card-top">
            <strong>${escapeHtml(labelType(command.type))}${command.count > 1 ? ` · ${command.count} ondas` : ''}${command.synthetic ? ' · teste' : ''}</strong>
            <span class="ga-badge ga-priority">${priorityLabel(policy.priority)}</span>
            <span class="ga-badge ga-risk">${labelRisk(assessment.level)}</span>
            <span class="ga-countdown" data-arrival-at="${command.arrivalAt}">${formatDuration(assessment.seconds)}</span>
          </div>
          <div class="ga-route">${escapeHtml(
            command.originLabels?.length === 1
              ? command.originLabels[0]
              : command.originLabels?.join(', ') || formatCommandOrigin(command)
          )} → ${escapeHtml(command.target)}</div>
          ${command.count > 1 ? `<div class="ga-advice">${command.origins.length} ${command.origins.length === 1 ? 'origem' : 'origens'} · janela de ${formatDuration(spanSeconds)}</div>` : ''}
          <div class="ga-advice" data-command-advice="${escapeHtml(command.id)}">${escapeHtml(recommendation(command, assessment))}</div>
          <div class="ga-actions">
            ${command.type === 'spy' ? `<button class="ga-btn" data-action="prepare-cave" data-town-id="${escapeHtml(command.targetTownId)}">Preparar gruta</button>` : ''}
            ${command.type === 'attack' ? `<button class="ga-btn" data-action="prepare-dodge" data-id="${escapeHtml(command.commands[0].id)}">Preparar desvio</button>` : ''}
            <button class="ga-btn secondary" data-action="select-town" data-town-id="${escapeHtml(command.targetTownId)}">Selecionar cidade</button>
            ${command.synthetic ? `<button class="ga-btn secondary" data-action="remove-incident-demo" data-ids="${escapeHtml(command.commands.map((item) => item.id).join(','))}">Remover teste</button>` : ''}
          </div>
        </article>
      `;
    }).join('');

    return `
      <div class="ga-summary">
        <div class="ga-stat"><strong>${counts.attack || 0}</strong><span>ATAQUES</span></div>
        <div class="ga-stat"><strong>${counts.spy || 0}</strong><span>ESPIONAGENS</span></div>
        <div class="ga-stat"><strong>${affectedCities}</strong><span>CIDADES EM RISCO</span></div>
      </div>
      ${cards || '<div class="ga-empty">Nenhuma ameaça detetada.<br>O painel continuará a observar.</div>'}
      <div class="ga-actions">
        <button class="ga-btn secondary" data-action="demo-attack">Testar ataque</button>
        <button class="ga-btn secondary" data-action="demo-wave">Testar onda</button>
        <button class="ga-btn secondary" data-action="demo-spy">Testar espionagem</button>
      </div>
    `;
  }

  function updateLiveTimes() {
    const now = gameNowMs();
    if (state.automation.armedUntil && !isAutomationArmed(now)) {
      disarmAutomation('tempo expirado');
      return;
    }
    if (state.execution.caveArmedUntil && !isCaveExecutionArmed(now)) {
      disarmCaveExecution('tempo expirado');
      return;
    }
    if (state.execution.supportArmedUntil && !isSupportExecutionArmed(now)) {
      disarmSupportExecution('tempo expirado');
      return;
    }
    const health = automationHealth({
      enabled: state.settings.enabled,
      armedUntil: state.automation.armedUntil,
      busy: state.automation.busy,
      breakerOpen: state.automation.breakerOpen,
      consecutiveFailures: state.automation.consecutiveFailures,
      lastScanAt: state.automation.lastScanAt
    }, Date.now(), state.settings.watchdogStaleSeconds);
    if (isAutomationArmed(now)
      && health.status === 'warning'
      && health.label === 'Leitura atrasada'
      && state.automation.lastScanAt) {
      state.automation.breakerOpen = true;
      state.automation.breakerReason = `A leitura do jogo ficou ${health.scanAgeSeconds}s sem atualizar.`;
      disarmAutomation('watchdog sem leitura atualizada', false);
      disarmCaveExecution('watchdog sem leitura atualizada', false);
      disarmSupportExecution('watchdog sem leitura atualizada', false);
      log('automation', 'Watchdog interrompeu a auto-preparação.', {
        scanAgeSeconds: health.scanAgeSeconds
      });
      renderPanel();
      return;
    }
    const mode = state.root?.querySelector('.ga-mode');
    if (mode) mode.textContent = modeText(now);
    void runAutomation();
    if (!state.root || state.settings.collapsed) return;
    state.root.querySelectorAll('.ga-action-countdown[data-arrival-at]').forEach((node) => {
      node.textContent = formatDuration((number(node.dataset.arrivalAt) - now) / 1_000);
    });
    if (state.settings.activeTab !== 'threats') return;
    let urgent = 0;
    state.incidents.forEach((command) => {
      const card = [...state.root.querySelectorAll('.ga-card[data-incident-id]')]
        .find((node) => node.dataset.incidentId === command.id);
      if (!card) return;
      const assessment = assessThreat(command, now, state.settings);
      urgent += assessment.level === 'critical' ? 1 : 0;
      card.classList.remove('critical', 'high', 'medium', 'low');
      card.classList.add(assessment.level);
      const countdown = card.querySelector('.ga-countdown');
      if (countdown) countdown.textContent = formatDuration(assessment.seconds);
      const riskBadge = card.querySelector('.ga-risk');
      if (riskBadge) riskBadge.textContent = labelRisk(assessment.level);
      const advice = card.querySelector('[data-command-advice]');
      if (advice) advice.textContent = recommendation(command, assessment);
    });
    if (state.launcher) state.launcher.dataset.alert = String(urgent > 0);
  }

  function renderCave() {
    const caves = caveSnapshots();
    const currentId = String(state.currentTown?.id || '');
    const totalDeposit = caves.reduce((sum, cave) => sum + cave.deposit, 0);
    return `
      <section class="ga-section">
        <h3>Resumo de todas as cidades</h3>
        <div class="ga-row"><span>Cidades monitorizadas</span><strong>${caves.length}</strong></div>
        <div class="ga-row"><span>Depósito total sugerido</span><strong>${totalDeposit.toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Reserva mínima</span><strong>${state.settings.caveReserve.toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Objetivo da gruta</span><strong>${state.settings.caveTarget.toLocaleString('pt-PT')}</strong></div>
      </section>
      ${caves.map((cave) => `
        <section class="ga-city ${String(cave.id) === currentId ? 'current' : ''}">
          <div class="ga-city-head">
            <strong>${escapeHtml(cave.name)}</strong>
            ${String(cave.id) === currentId ? '<span class="ga-current">SELECIONADA</span>' : ''}
          </div>
          <div class="ga-row"><span>Prata disponível</span><strong>${cave.silver.toLocaleString('pt-PT')}</strong></div>
          <div class="ga-row"><span>Prata na gruta</span><strong>${cave.caveSilver.toLocaleString('pt-PT')}</strong></div>
          <div class="ga-row"><span>Depositar</span><strong>${cave.deposit.toLocaleString('pt-PT')}</strong></div>
          <div class="ga-actions">
            <button class="ga-btn" data-action="prepare-cave" data-town-id="${escapeHtml(cave.id)}">Preparar</button>
            <button class="ga-btn secondary" data-action="select-town" data-town-id="${escapeHtml(cave.id)}">Selecionar</button>
          </div>
        </section>
      `).join('')}
      <p>Os valores são calculados para todas as cidades carregadas na conta. Só há confirmação automática quando a opção e o armamento separado da execução estiverem ativos.</p>
    `;
  }

  function renderLuck() {
    const result = calculateLuckScenario({
      attackStrength: state.settings.luckAttackStrength,
      defenseStrength: state.settings.luckDefenseStrength,
      morale: state.settings.luckMorale,
      attackBonus: state.settings.luckAttackBonus,
      defenseBonus: state.settings.luckDefenseBonus,
      selectedLuck: state.settings.luckSelected
    });
    const signed = (value, digits = 1) => {
      if (!Number.isFinite(value)) return '∞';
      const rounded = Math.abs(value) < 0.05 ? 0 : value;
      return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}%`;
    };
    const status = {
      guaranteed: {
        label: 'Vantagem mesmo com −30%',
        className: 'ga-ok'
      },
      possible: {
        label: 'O resultado depende da sorte',
        className: ''
      },
      impossible: {
        label: 'Insuficiente mesmo com +30%',
        className: 'ga-fail'
      }
    }[result.status];
    const required = !Number.isFinite(result.requiredLuck)
      ? 'Impossível sem força de ataque'
      : result.requiredLuck <= -30
        ? '≤ −30%'
        : result.requiredLuck > 30
          ? `>${signed(30, 0)} (necessário ${signed(result.requiredLuck)})`
          : signed(result.requiredLuck);

    return `
      <section class="ga-section">
        <h3>Calculadora de sorte</h3>
        ${numberField('luckAttackStrength', 'Força total de ataque', state.settings.luckAttackStrength, 1_000)}
        ${numberField('luckDefenseStrength', 'Força total de defesa', state.settings.luckDefenseStrength, 1_000)}
        ${boundedNumberField('luckMorale', 'Moral (%)', state.settings.luckMorale, 0, 100, 1)}
        ${numberField('luckAttackBonus', 'Bónus de ataque (%)', state.settings.luckAttackBonus, 1)}
        ${numberField('luckDefenseBonus', 'Bónus de defesa (%)', state.settings.luckDefenseBonus, 1)}
        ${boundedNumberField('luckSelected', 'Sorte a analisar (%)', state.settings.luckSelected, -30, 30, 1)}
      </section>
      <section class="ga-section">
        <h3>Margem do ataque</h3>
        <div class="ga-row"><span>Conclusão</span><strong class="${status.className}" data-luck-status="${result.status}">${status.label}</strong></div>
        <div class="ga-row"><span>Sorte mínima</span><strong data-luck-required="${Number.isFinite(result.requiredLuck) ? result.requiredLuck.toFixed(4) : 'infinity'}">${required}</strong></div>
        <div class="ga-row"><span>Ataque na sorte escolhida</span><strong>${Math.round(result.effectiveAttack).toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Defesa efetiva</span><strong>${Math.round(result.effectiveDefense).toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Relação ataque/defesa</span><strong class="${result.favorable ? 'ga-ok' : 'ga-fail'}" data-luck-selected-result="${result.favorable ? 'favorable' : 'unfavorable'}">${Number.isFinite(result.ratio) ? result.ratio.toFixed(3) : '∞'}×</strong></div>
        <div class="ga-row"><span>Margem absoluta</span><strong class="${result.margin >= 0 ? 'ga-ok' : 'ga-fail'}">${result.margin >= 0 ? '+' : ''}${Math.round(result.margin).toLocaleString('pt-PT')}</strong></div>
      </section>
      <div class="ga-summary">
        ${result.scenarios.map((scenario) => `
          <div class="ga-stat">
            <strong class="${scenario.favorable ? 'ga-ok' : 'ga-fail'}">${scenario.luck > 0 ? '+' : ''}${scenario.luck}%</strong>
            <span>${Math.round(scenario.attack).toLocaleString('pt-PT')} · ${Number.isFinite(scenario.ratio) ? scenario.ratio.toFixed(2) : '∞'}×</span>
          </div>
        `).join('')}
      </div>
      <section class="ga-section">
        <h3>Como usar</h3>
        <p>Introduz as forças agregadas finais do simulador do jogo. O cálculo aplica moral, bónus e a variação de sorte entre −30% e +30%.</p>
        <p>Não estima baixas nem substitui o simulador: tipos de arma, muralha, investigação, deuses, heróis e outros modificadores devem estar refletidos nos valores introduzidos.</p>
      </section>
    `;
  }

  function renderActions() {
    const active = state.actions.filter((action) => (
      ['waiting', 'ready', 'running'].includes(action.status)
    ));
    const completed = state.actions.filter((action) => (
      !['waiting', 'ready', 'running'].includes(action.status)
    )).slice(0, 20);
    const renderAction = (action) => `
      <article class="ga-card ${action.status === 'error' || action.status === 'blocked' ? 'critical' : action.status === 'ready' ? 'high' : ''}">
        <div class="ga-card-top">
          <strong>${action.action === 'cave' ? 'Gruta' : 'Desvio'} · ${escapeHtml(action.target)}${action.waveCount > 1 ? ` · ${action.waveCount} ondas` : ''}</strong>
          <span class="ga-badge">${priorityLabel(action.priority)}</span>
          <span class="ga-badge">${escapeHtml(actionLabel(action.status))}</span>
          ${action.arrivalAt > gameNowMs() ? `<span class="ga-countdown ga-action-countdown" data-arrival-at="${action.arrivalAt}">${formatDuration((action.arrivalAt - gameNowMs()) / 1_000)}</span>` : ''}
        </div>
        <div class="ga-advice">${escapeHtml(action.message)}</div>
        ${action.waveCount > 1 ? `<div class="ga-advice">${action.originCount} ${action.originCount === 1 ? 'origem' : 'origens'} · última chegada ${formatClock(action.lastArrivalAt)}</div>` : ''}
        ${['waiting', 'ready', 'error', 'blocked'].includes(action.status) ? `
          <div class="ga-actions">
            <button class="ga-btn" data-action="${action.action === 'cave' ? 'prepare-cave' : 'prepare-dodge'}" ${action.action === 'cave' ? `data-town-id="${escapeHtml(action.targetTownId)}"` : `data-id="${escapeHtml(action.commandId)}"`}>Preparar agora</button>
          </div>
        ` : ''}
      </article>
    `;
    return `
      <section class="ga-section">
        <h3>Centro de ações</h3>
        <div class="ga-row"><span>Pendentes</span><strong>${active.length}</strong></div>
        <div class="ga-row"><span>Histórico guardado</span><strong>${state.actions.length}</strong></div>
      </section>
      ${active.map(renderAction).join('') || '<div class="ga-empty">Nenhuma ação pendente.</div>'}
      ${completed.length ? `
        <section class="ga-section"><h3>Histórico recente</h3></section>
        ${completed.map(renderAction).join('')}
      ` : ''}
      <button class="ga-btn danger" data-action="clear-actions">Limpar histórico concluído</button>
    `;
  }

  function renderPolicies() {
    return `
      <section class="ga-section">
        <h3>Políticas defensivas por cidade</h3>
        <p>As opções abaixo substituem as regras globais. Uma cidade segura nunca pode ser a própria cidade ameaçada.</p>
      </section>
      ${state.towns.map((town) => {
        const policy = resolveTownPolicy(town.id, state.settings);
        const override = state.settings.townPolicies?.[String(town.id)] || {};
        const globalSafeTown = state.townsById.get(String(state.settings.dodgeTargetTownId))?.name;
        const globalFallbackTown = state.townsById.get(String(state.settings.dodgeFallbackTownId))?.name;
        return `
          <section class="ga-city">
            <div class="ga-city-head"><strong>${escapeHtml(town.name)}</strong></div>
            <label class="ga-check">
              <input type="checkbox" data-policy-town="${escapeHtml(town.id)}" data-policy-field="caveEnabled" ${policy.caveEnabled ? 'checked' : ''}>
              Preparar gruta perante espionagem
            </label>
            <label class="ga-check">
              <input type="checkbox" data-policy-town="${escapeHtml(town.id)}" data-policy-field="dodgeEnabled" ${policy.dodgeEnabled ? 'checked' : ''}>
              Preparar desvio perante ataque
            </label>
            <label class="ga-check">
              <input type="checkbox" data-policy-town="${escapeHtml(town.id)}" data-policy-field="canReceiveDodge" ${policy.canReceiveDodge ? 'checked' : ''}>
              Pode receber tropas desviadas
            </label>
            <label class="ga-field">
              <span>Prioridade</span>
              <select data-policy-town="${escapeHtml(town.id)}" data-policy-field="priority">
                <option value="high" ${policy.priority === 'high' ? 'selected' : ''}>Alta</option>
                <option value="normal" ${policy.priority === 'normal' ? 'selected' : ''}>Normal</option>
                <option value="low" ${policy.priority === 'low' ? 'selected' : ''}>Baixa</option>
              </select>
            </label>
            <label class="ga-field">
              <span>Cidade segura</span>
              <select data-policy-town="${escapeHtml(town.id)}" data-policy-field="safeTownId">
                <option value="" ${override.safeTownId ? '' : 'selected'}>Global${globalSafeTown ? `: ${escapeHtml(globalSafeTown)}` : ''}</option>
                ${state.towns
                  .filter((candidate) => String(candidate.id) !== String(town.id))
                  .map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${String(candidate.id) === String(override.safeTownId || '') ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="ga-field">
              <span>Alternativa</span>
              <select data-policy-town="${escapeHtml(town.id)}" data-policy-field="fallbackSafeTownId">
                <option value="" ${override.fallbackSafeTownId ? '' : 'selected'}>Global${globalFallbackTown ? `: ${escapeHtml(globalFallbackTown)}` : ''}</option>
                ${state.towns
                  .filter((candidate) => String(candidate.id) !== String(town.id))
                  .map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${String(candidate.id) === String(override.fallbackSafeTownId || '') ? 'selected' : ''}>${escapeHtml(candidate.name)}</option>`)
                  .join('')}
              </select>
            </label>
            <button class="ga-btn secondary" data-action="reset-town-policy" data-town-id="${escapeHtml(town.id)}">Repor regra global</button>
          </section>
        `;
      }).join('')}
      <button class="ga-btn danger" data-action="reset-all-policies">Repor todas as políticas</button>
    `;
  }

  function renderSettings() {
    const armed = isAutomationArmed();
    return `
      <section class="ga-section">
        <h3>Operação</h3>
        ${checkField('enabled', 'Monitorização ativa', state.settings.enabled)}
        ${checkField('simulation', 'Modo de simulação', state.settings.simulation)}
      </section>
      <section class="ga-section">
        <h3>Auto-preparação controlada</h3>
        ${checkField('autoPrepareCave', 'Preparar gruta perante espionagem', state.settings.autoPrepareCave)}
        ${checkField('autoPrepareDodge', 'Preparar desvio na janela definida', state.settings.autoPrepareDodge)}
        ${checkField('autoSelectFallback', 'Escolher alternativa automaticamente', state.settings.autoSelectFallback)}
        ${numberField('automationArmMinutes', 'Tempo armado (min.)', state.settings.automationArmMinutes, 5)}
        ${numberField('automationFailureLimit', 'Parar após falhas', state.settings.automationFailureLimit, 1)}
        ${numberField('watchdogStaleSeconds', 'Leitura atrasada após (seg.)', state.settings.watchdogStaleSeconds, 5)}
        <div class="ga-row"><span>Estado</span><strong class="${armed ? 'ga-ok' : ''}">${armed ? `Armada por ${formatDuration(automationRemainingSeconds())}` : 'Desarmada'}</strong></div>
        <div class="ga-actions">
          <button class="ga-btn ${armed ? 'danger' : ''}" data-action="${armed ? 'disarm-automation' : 'arm-automation'}">${armed ? 'Desarmar' : 'Armar auto-preparação'}</button>
        </div>
        <p>Quando armada, abre e preenche automaticamente a gruta ou prepara o menu de desvio. As ações finais exigem os armamentos separados abaixo.</p>
      </section>
      <section class="ga-section">
        <h3>Execução controlada da gruta</h3>
        ${checkField('autoConfirmCave', 'Confirmar depósitos automaticamente', state.settings.autoConfirmCave)}
        ${numberField('caveConfirmMax', 'Máximo por depósito', state.settings.caveConfirmMax, 500)}
        ${numberField('caveSessionBudget', 'Orçamento por sessão', state.settings.caveSessionBudget, 1_000)}
        ${numberField('executionArmMinutes', 'Tempo de execução (min.)', state.settings.executionArmMinutes, 1)}
        <div class="ga-row"><span>Estado</span><strong class="${isCaveExecutionArmed() ? 'ga-fail' : ''}">${isCaveExecutionArmed() ? `Armada por ${formatDuration(caveExecutionRemainingSeconds())}` : 'Desarmada'}</strong></div>
        <div class="ga-row"><span>Gasto nesta sessão</span><strong>${state.execution.spentSilver.toLocaleString('pt-PT')} / ${number(state.settings.caveSessionBudget).toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Depósitos confirmados</span><strong>${state.execution.confirmations}</strong></div>
        <div class="ga-actions">
          <button class="ga-btn ${isCaveExecutionArmed() ? 'danger' : ''}" data-action="${isCaveExecutionArmed() ? 'disarm-cave-execution' : 'arm-cave-execution'}">${isCaveExecutionArmed() ? 'Desarmar execução' : 'Armar execução da gruta'}</button>
        </div>
        <p>Este armamento é separado, não é guardado e permite gastar prata. Não concede autorização para enviar tropas.</p>
      </section>
      <section class="ga-section">
        <h3>Execução controlada do desvio</h3>
        ${checkField('autoSendSupport', 'Enviar apoio automaticamente', state.settings.autoSendSupport)}
        ${numberField('supportSessionLimit', 'Máximo de apoios por sessão', state.settings.supportSessionLimit, 1)}
        ${numberField('supportMinLeadSeconds', 'Margem mínima (seg.)', state.settings.supportMinLeadSeconds, 5)}
        ${numberField('supportExecutionArmMinutes', 'Tempo de execução (min.)', state.settings.supportExecutionArmMinutes, 1)}
        ${boundedNumberField('supportSendPercent', 'Tropas a enviar (%)', state.settings.supportSendPercent, 1, 100, 5)}
        ${numberField('supportReservePerUnit', 'Reserva por tipo de unidade', state.settings.supportReservePerUnit, 1)}
        ${numberField('supportMinimumTotal', 'Mínimo total para enviar', state.settings.supportMinimumTotal, 1)}
        ${numberField('supportArrivalBufferSeconds', 'Chegar antes do ataque (seg.)', state.settings.supportArrivalBufferSeconds, 5)}
        ${checkField('supportRequireTravelTime', 'Bloquear se a duração não for detetada', state.settings.supportRequireTravelTime)}
        <div class="ga-row"><span>Estado</span><strong class="${isSupportExecutionArmed() ? 'ga-fail' : ''}">${isSupportExecutionArmed() ? `Armado por ${formatDuration(supportExecutionRemainingSeconds())}` : 'Desarmado'}</strong></div>
        <div class="ga-row"><span>Apoios enviados</span><strong>${state.execution.supportCommandsSent} / ${state.settings.supportSessionLimit}</strong></div>
        <div class="ga-actions">
          <button class="ga-btn ${isSupportExecutionArmed() ? 'danger' : ''}" data-action="${isSupportExecutionArmed() ? 'disarm-support-execution' : 'arm-support-execution'}">${isSupportExecutionArmed() ? 'Desarmar apoios' : 'Armar envio de apoios'}</button>
        </div>
        <p>Aplica percentagem e reserva, lê a duração da viagem e exige que o apoio chegue antes do ataque com a margem configurada. Envia apenas através de Apoiar; nunca usa Atacar.</p>
      </section>
      <section class="ga-section">
        <h3>Limites</h3>
        ${numberField('warningSeconds', 'Alerta urgente (seg.)', state.settings.warningSeconds, 30)}
        ${numberField('dodgeLeadSeconds', 'Desviar antes (seg.)', state.settings.dodgeLeadSeconds, 10)}
        ${numberField('waveGapSeconds', 'Separar ondas após (seg.)', state.settings.waveGapSeconds, 30)}
        ${numberField('caveReserve', 'Reserva de prata', state.settings.caveReserve, 500)}
        ${numberField('caveTarget', 'Objetivo da gruta', state.settings.caveTarget, 1_000)}
        ${townSelectField('dodgeTargetTownId', 'Cidade segura', state.settings.dodgeTargetTownId)}
        ${townSelectField('dodgeFallbackTownId', 'Cidade alternativa', state.settings.dodgeFallbackTownId)}
      </section>
      <button class="ga-btn secondary" data-action="reset-position">Repor posição do painel</button>
      <button class="ga-btn danger" data-action="clear-logs">Limpar registo</button>
    `;
  }

  function checkField(name, label, checked) {
    return `<label class="ga-check"><input type="checkbox" data-setting="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
  }

  function numberField(name, label, value, step) {
    return `<label class="ga-field"><span>${label}</span><input type="number" min="0" step="${step}" value="${value}" data-setting="${name}"></label>`;
  }

  function boundedNumberField(name, label, value, min, max, step) {
    return `<label class="ga-field"><span>${label}</span><input type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-setting="${name}"></label>`;
  }

  function townSelectField(name, label, selected) {
    return `<label class="ga-field"><span>${label}</span><select data-setting="${name}">
      <option value="">Escolher…</option>
      ${state.towns.map((town) => `<option value="${escapeHtml(town.id)}" ${String(town.id) === String(selected) ? 'selected' : ''}>${escapeHtml(town.name)}</option>`).join('')}
    </select></label>`;
  }

  function renderLogs() {
    if (!state.logs.length) return '<div class="ga-empty">Ainda não existem eventos registados.</div>';
    return state.logs.slice(0, 60).map((entry) => `
      <div class="ga-log">
        ${escapeHtml(entry.message)}
        <small>${new Date(entry.at).toLocaleString('pt-PT')}</small>
      </div>
    `).join('');
  }

  function renderDiagnostic() {
    const diagnostic = buildDiagnostic();
    state.diagnostic = diagnostic;
    const status = (value) => `<strong class="${value ? 'ga-ok' : 'ga-fail'}">${value ? 'OK' : 'Indisponível'}</strong>`;
    const validationLabels = {
      idle: 'Por testar',
      running: 'Em curso',
      success: 'Confirmado',
      error: 'Falhou'
    };
    const validationClass = state.validation.status === 'success'
      ? 'ga-ok'
      : state.validation.status === 'error'
        ? 'ga-fail'
        : '';
    const healthClass = diagnostic.health.status === 'blocked'
      ? 'ga-fail'
      : diagnostic.health.status === 'warning'
        ? ''
        : 'ga-ok';
    const preflight = diagnostic.preflight || state.preflight;
    return `
      <section class="ga-section">
        <h3>Pré-verificação</h3>
        <div class="ga-row"><span>Resultado</span><strong class="${preflight.passed ? 'ga-ok' : 'ga-fail'}">${preflight.passed ? 'Pronta para armar' : 'Bloqueada'}</strong></div>
        <div class="ga-row"><span>Pontuação</span><strong>${preflight.score}/100</strong></div>
        <div class="ga-row"><span>Erros</span><strong class="${preflight.errors.length ? 'ga-fail' : 'ga-ok'}">${preflight.errors.length}</strong></div>
        <div class="ga-row"><span>Avisos</span><strong>${preflight.warnings.length}</strong></div>
        ${preflight.errors.map((issue) => `<div class="ga-log ga-fail">✕ ${escapeHtml(issue.message)}</div>`).join('')}
        ${preflight.warnings.map((issue) => `<div class="ga-log">⚠ ${escapeHtml(issue.message)}</div>`).join('')}
        <div class="ga-actions">
          <button class="ga-btn secondary" data-action="run-preflight">Executar pré-verificação</button>
        </div>
      </section>
      <section class="ga-section">
        <h3>Saúde operacional</h3>
        <div class="ga-row"><span>Estado</span><strong class="${healthClass}">${escapeHtml(diagnostic.health.label)}</strong></div>
        <div class="ga-row"><span>Última leitura</span><strong>${diagnostic.health.scanAgeSeconds === null ? 'Nunca' : `${diagnostic.health.scanAgeSeconds}s`}</strong></div>
        <div class="ga-row"><span>Falhas consecutivas</span><strong>${diagnostic.automationFailures}/${state.settings.automationFailureLimit}</strong></div>
        <div class="ga-row"><span>Disjuntor</span><strong class="${diagnostic.breakerOpen ? 'ga-fail' : 'ga-ok'}">${diagnostic.breakerOpen ? 'Ativado' : 'Normal'}</strong></div>
        ${diagnostic.breakerReason ? `<div>${escapeHtml(diagnostic.breakerReason)}</div>` : ''}
        ${diagnostic.lastSuccessAt ? `<small>Último sucesso: ${new Date(diagnostic.lastSuccessAt).toLocaleString('pt-PT')}</small>` : ''}
        <div class="ga-actions">
          <button class="ga-btn secondary" data-action="reset-breaker" ${diagnostic.breakerOpen || diagnostic.automationFailures ? '' : 'disabled'}>Repor proteção</button>
          ${state.settings.simulation ? '<button class="ga-btn secondary" data-action="demo-failure">Simular falha</button>' : ''}
        </div>
      </section>
      <section class="ga-section">
        <h3>Execução da gruta</h3>
        <div class="ga-row"><span>Estado</span><strong class="${diagnostic.caveExecutionArmed ? 'ga-fail' : ''}">${diagnostic.caveExecutionArmed ? `Armada · ${formatDuration(diagnostic.caveExecutionRemaining)}` : 'Desarmada'}</strong></div>
        <div class="ga-row"><span>Gasto da sessão</span><strong>${diagnostic.caveSpentSilver.toLocaleString('pt-PT')}</strong></div>
        <div class="ga-row"><span>Confirmações</span><strong>${diagnostic.caveConfirmations}</strong></div>
        ${diagnostic.caveLastAt ? `<small>Último depósito: ${diagnostic.caveLastAmount.toLocaleString('pt-PT')} em ${new Date(diagnostic.caveLastAt).toLocaleString('pt-PT')}</small>` : ''}
      </section>
      <section class="ga-section">
        <h3>Execução do desvio</h3>
        <div class="ga-row"><span>Estado</span><strong class="${diagnostic.supportExecutionArmed ? 'ga-fail' : ''}">${diagnostic.supportExecutionArmed ? `Armado · ${formatDuration(diagnostic.supportExecutionRemaining)}` : 'Desarmado'}</strong></div>
        <div class="ga-row"><span>Apoios enviados</span><strong>${diagnostic.supportCommandsSent}/${state.settings.supportSessionLimit}</strong></div>
        ${diagnostic.supportLastAt ? `<small>Último apoio: ${diagnostic.supportLastUnits.toLocaleString('pt-PT')} unidades de ${escapeHtml(diagnostic.supportLastTownId)} para ${escapeHtml(diagnostic.supportLastTargetId)} em ${new Date(diagnostic.supportLastAt).toLocaleString('pt-PT')}</small>` : ''}
      </section>
      <section class="ga-section">
        <h3>Integração com o jogo</h3>
        <div class="ga-row"><span>Mundo</span><strong>${escapeHtml(diagnostic.world)}</strong></div>
        <div class="ga-row"><span>Cidades</span><strong>${diagnostic.towns}</strong></div>
        <div class="ga-row"><span>Movimentos globais</span><strong>${diagnostic.movementModels}</strong></div>
        <div class="ga-row"><span>Troca de cidade</span>${status(diagnostic.layoutTownSwitch)}</div>
        <div class="ga-code">${escapeHtml(
          [
            ...diagnostic.townSwitchMethods,
            diagnostic.townSwitchDom ? 'DOM da lista de cidades' : '',
            diagnostic.townCycle ? 'Seta seguinte/anterior' : ''
          ]
            .filter(Boolean)
            .join(', ') || 'Nenhum método detetado.'
        )}</div>
        <div class="ga-row"><span>Salto no mapa</span>${status(diagnostic.mapJump)}</div>
        <div class="ga-row"><span>Edifício da gruta</span>${status(diagnostic.caveBuilding)}</div>
        <div class="ga-row"><span>Campo da gruta aberto</span>${status(diagnostic.caveInput)}</div>
      </section>
      <section class="ga-section">
        <h3>Última validação assistida</h3>
        <div class="ga-row"><span>Estado</span><strong class="${validationClass}">${validationLabels[state.validation.status] || state.validation.status}</strong></div>
        <div>${escapeHtml(state.validation.message)}</div>
        ${state.validation.at ? `<small>${new Date(state.validation.at).toLocaleString('pt-PT')}</small>` : ''}
      </section>
      <section class="ga-section">
        <h3>Leitura</h3>
        <div class="ga-row"><span>Métodos de recursos</span><strong>${escapeHtml(diagnostic.resourceMethods.join(', ') || 'nenhum')}</strong></div>
        <div class="ga-code">${escapeHtml(diagnostic.movementFields.join(', ') || 'Abra/receba um comando para listar os campos.')}</div>
      </section>
      <button class="ga-btn secondary" data-action="refresh-diagnostic">Atualizar diagnóstico</button>
    `;
  }

  function handlePanelClick(event) {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) {
      rememberCurrentScroll();
      state.settings.activeTab = tab;
      save(STORAGE_KEY, state.settings);
      renderPanel();
      return;
    }

    const actionNode = event.target.closest('[data-action]');
    if (!actionNode) return;
    const action = actionNode.dataset.action;
    if (action === 'collapse') {
      togglePanel();
    } else if (action === 'refresh') {
      scan();
      toast('Dados atualizados.');
    } else if (action === 'demo-attack') {
      addDemo('attack');
    } else if (action === 'demo-spy') {
      addDemo('spy');
    } else if (action === 'demo-wave') {
      addDemoWave();
    } else if (action === 'remove-demo') {
      state.syntheticCommands = state.syntheticCommands.filter((item) => item.id !== actionNode.dataset.id);
      scan();
    } else if (action === 'remove-incident-demo') {
      const ids = new Set(String(actionNode.dataset.ids || '').split(',').filter(Boolean));
      state.syntheticCommands = state.syntheticCommands.filter((item) => !ids.has(item.id));
      scan();
    } else if (action === 'select-town') {
      selectTownAssisted(actionNode.dataset.townId);
    } else if (action === 'prepare-cave') {
      prepareCave(actionNode.dataset.townId);
    } else if (action === 'prepare-dodge') {
      prepareDodge(actionNode.dataset.id);
    } else if (action === 'arm-automation') {
      armAutomation();
    } else if (action === 'disarm-automation') {
      disarmAutomation('manual', false);
      disarmCaveExecution('auto-preparação desarmada', false);
      disarmSupportExecution('auto-preparação desarmada', false);
      renderPanel();
    } else if (action === 'arm-cave-execution') {
      armCaveExecution();
    } else if (action === 'disarm-cave-execution') {
      disarmCaveExecution('manual');
    } else if (action === 'arm-support-execution') {
      armSupportExecution();
    } else if (action === 'disarm-support-execution') {
      disarmSupportExecution('manual');
    } else if (action === 'reset-breaker') {
      resetCircuitBreaker();
    } else if (action === 'run-preflight') {
      runPreflight(true);
    } else if (action === 'demo-failure') {
      registerAutomationOutcome(false, 'Falha sintética para validar o disjuntor.');
      state.diagnostic = buildDiagnostic();
      renderPanel();
    } else if (action === 'clear-actions') {
      state.actions = state.actions.filter((item) => (
        ['waiting', 'ready', 'running'].includes(item.status)
      ));
      save(ACTION_KEY, state.actions);
      renderPanel();
    } else if (action === 'reset-town-policy') {
      const townId = String(actionNode.dataset.townId || '');
      delete state.settings.townPolicies[townId];
      state.automation.handled.clear();
      resetActiveActions();
      save(STORAGE_KEY, state.settings);
      scan();
    } else if (action === 'reset-all-policies') {
      state.settings.townPolicies = {};
      state.automation.handled.clear();
      resetActiveActions();
      save(STORAGE_KEY, state.settings);
      scan();
    } else if (action === 'refresh-diagnostic') {
      scan();
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast('Diagnóstico atualizado.');
    } else if (action === 'reset-position') {
      state.settings.panelX = null;
      state.settings.panelY = null;
      state.settings.launcherSide = 'right';
      save(STORAGE_KEY, state.settings);
      applyPanelPosition();
    } else if (action === 'clear-logs') {
      state.logs = [];
      save(LOG_KEY, state.logs);
      renderPanel();
    }
  }

  function handlePanelChange(event) {
    const policyTownId = event.target.dataset.policyTown;
    const policyField = event.target.dataset.policyField;
    if (policyTownId && policyField) {
      const existing = state.settings.townPolicies?.[String(policyTownId)] || {};
      const value = event.target.type === 'checkbox'
        ? event.target.checked
        : event.target.value;
      state.settings.townPolicies = {
        ...state.settings.townPolicies,
        [String(policyTownId)]: {
          ...existing,
          [policyField]: value
        }
      };
      state.automation.handled.clear();
      resetActiveActions();
      save(STORAGE_KEY, state.settings);
      log('settings', `Política de ${policyTownId} alterada: ${policyField}`, { value });
      scan();
      return;
    }
    const name = event.target.dataset.setting;
    if (!name) return;
    let value = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.tagName === 'SELECT'
        ? event.target.value
        : number(event.target.value);
    if (event.target.type !== 'checkbox' && event.target.tagName !== 'SELECT') {
      if (name === 'luckSelected') value = Math.max(-30, Math.min(30, value));
      else if (name === 'luckMorale') value = Math.max(0, Math.min(100, value));
      else if (name === 'supportSendPercent') value = Math.max(1, Math.min(100, value));
      else value = Math.max(0, value);
    }
    state.settings[name] = value;
    if (name === 'simulation') {
      disarmAutomation('alteração de modo', false);
      disarmCaveExecution('alteração de modo', false);
      disarmSupportExecution('alteração de modo', false);
    }
    if (name === 'autoConfirmCave' && !value) {
      disarmCaveExecution('confirmação automática desativada', false);
    }
    if (name === 'autoSendSupport' && !value) {
      disarmSupportExecution('envio automático de apoios desativado', false);
    }
    if ([
      'autoPrepareCave',
      'autoPrepareDodge',
      'dodgeTargetTownId',
      'dodgeFallbackTownId',
      'autoSelectFallback',
      'warningSeconds',
      'dodgeLeadSeconds',
      'waveGapSeconds',
      'caveReserve',
      'caveTarget',
      'autoConfirmCave',
      'caveConfirmMax',
      'caveSessionBudget',
      'executionArmMinutes',
      'autoSendSupport',
      'supportSessionLimit',
      'supportMinLeadSeconds',
      'supportExecutionArmMinutes',
      'supportSendPercent',
      'supportReservePerUnit',
      'supportMinimumTotal',
      'supportArrivalBufferSeconds',
      'supportRequireTravelTime'
    ].includes(name)) {
      state.automation.handled.clear();
      resetActiveActions();
    }
    save(STORAGE_KEY, state.settings);
    log('settings', `Definição alterada: ${name}`, { value });
    schedule();
    renderPanel();
  }

  function addDemo(type) {
    const id = `demo:${type}:${Date.now()}`;
    const seconds = type === 'spy'
      ? Math.max(15, Math.min(60, number(state.settings.warningSeconds, 300) - 10))
      : Math.max(15, number(state.settings.dodgeLeadSeconds, 90) - 10);
    state.syntheticCommands.push(normalizeCommand({
      id,
      command_type: type,
      arrival_at: gameNowMs() + seconds * 1_000,
      origin_town_name: 'Cidade de teste',
      target_town_name: state.currentTown?.name || 'Castle Black',
      target_town_id: state.currentTown?.id || '',
      synthetic: true
    }, gameNowMs()));
    state.seen.delete(id);
    scan();
  }

  function addDemoWave() {
    const now = gameNowMs();
    const targetTownId = state.currentTown?.id || '';
    const targetTownName = state.currentTown?.name || 'Castle Black';
    [45, 75, 120].forEach((seconds, index) => {
      const id = `demo:wave:${now}:${index}`;
      state.syntheticCommands.push(normalizeCommand({
        id,
        command_type: 'attack',
        arrival_at: now + seconds * 1_000,
        origin_town_name: index === 2 ? 'Segunda origem de teste' : 'Primeira origem de teste',
        target_town_name: targetTownName,
        target_town_id: targetTownId,
        synthetic: true
      }, now));
      state.seen.delete(id);
    });
    scan();
  }

  function waitFor(check, timeout = 5_000, interval = 100) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        let result = null;
        try {
          result = check();
        } catch {
          result = null;
        }
        if (result) {
          resolve(result);
          return;
        }
        if (Date.now() - started >= timeout) {
          reject(new Error('Tempo de espera excedido.'));
          return;
        }
        setTimeout(poll, interval);
      };
      poll();
    });
  }

  function rawTown(townId) {
    return page.ITowns?.getTown?.(townId)
      ?? page.ITowns?.towns?.[townId]
      ?? page.ITowns?.towns?.[String(townId)]
      ?? null;
  }

  function currentTownId() {
    try {
      const town = page.ITowns?.getCurrentTown?.();
      return String(town?.id ?? town?.getId?.() ?? page.Game?.townId ?? '');
    } catch {
      return String(page.Game?.townId ?? '');
    }
  }

  function modelCurrentTownName() {
    try {
      const town = page.ITowns?.getCurrentTown?.();
      return String(
        town?.getName?.()
        ?? town?.get?.('name')
        ?? town?.attributes?.name
        ?? page.Game?.townName
        ?? ''
      ).trim();
    } catch {
      return String(page.Game?.townName ?? '').trim();
    }
  }

  function visibleTownNameNodes() {
    const node = document.querySelector(CURRENT_TOWN_NAME_SELECTOR);
    return visible(node) ? [node] : [];
  }

  function caveWindowTownNames() {
    const titleSelectors = [
      '.ui-dialog-title',
      '.window_title',
      '.window_title_text',
      '.classic_window .title'
    ];
    return titleSelectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter(visible)
      .map((node) => node.textContent.match(/\(([^()]+)\)\s*$/)?.[1] || '')
      .filter(Boolean);
  }

  function currentTownSignals() {
    let rawTown = null;
    try {
      rawTown = page.ITowns?.getCurrentTown?.() ?? null;
    } catch {
      rawTown = null;
    }
    const ids = [
      rawTown?.id,
      rawTown?.getId?.(),
      page.Game?.townId,
      page.Game?.town_id
    ]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(String);
    const names = [
      rawTown?.getName?.(),
      rawTown?.get?.('name'),
      rawTown?.attributes?.name,
      page.Game?.townName,
      page.Game?.town_name,
      ...visibleTownNameNodes().map((node) => node.textContent),
      ...caveWindowTownNames()
    ]
      .map(normalizeTownLabel)
      .filter(Boolean);
    return {
      ids: [...new Set(ids)],
      names: [...new Set(names)]
    };
  }

  function currentTownName() {
    return modelCurrentTownName()
      || visibleTownNameNodes().map((node) => node.textContent.trim()).find(Boolean)
      || caveWindowTownNames()[0]
      || '';
  }

  function currentTownSignature() {
    const signals = currentTownSignals();
    return `${signals.ids.sort().join('|')}::${signals.names.sort().join('|')}`;
  }

  function setValidation(kind, status, message) {
    state.validation = {
      kind,
      status,
      message,
      at: Date.now()
    };
    if (state.settings.activeTab === 'diagnostic') renderPanel();
  }

  function escapedSelectorValue(value) {
    const text = String(value ?? '');
    return globalThis.CSS?.escape
      ? globalThis.CSS.escape(text)
      : text.replace(/["\\]/g, '\\$&');
  }

  function townListRoots() {
    const root = document.querySelector('#town_groups_list');
    return root && !root.closest('#ga-dock') ? [root] : [];
  }

  function findTownSwitchNode(townId, townName = '') {
    const wanted = escapedSelectorValue(townId);
    const roots = townListRoots();
    const scopedSelectors = [
      `[data-townid="${wanted}"]`,
      `[data-town_id="${wanted}"]`,
      `[data-town-id="${wanted}"]`,
      `#town_${wanted}`
    ];
    let nodes = roots.flatMap((root) => [...root.querySelectorAll(scopedSelectors.join(','))]);
    if (!nodes.length && townName) {
      const normalizedName = normalizeTownLabel(townName);
      nodes = [...document.querySelectorAll(TOWN_LIST_SPAN_SELECTOR)]
        .filter((node) => (
          !node.closest('#ga-dock')
          && normalizeTownLabel(node.textContent) === normalizedName
        ));
    }
    const node = nodes.find((candidate) => candidate.getClientRects().length > 0) || nodes[0];
    return node || null;
  }

  function visible(node) {
    return Boolean(node && !node.closest('#ga-dock') && node.getClientRects().length);
  }

  function findTownNameNode() {
    const named = visibleTownNameNodes()[0];
    return named || null;
  }

  function findNextTownNodes() {
    const next = document.querySelector(NEXT_TOWN_SELECTOR);
    const previous = document.querySelector(PREV_TOWN_SELECTOR);
    return [next, previous].filter(visible);
  }

  function townMatches(townId, townName = '') {
    const signals = currentTownSignals();
    const wantedId = String(townId ?? '');
    const wantedName = normalizeTownLabel(townName);
    return Boolean(
      (wantedId && signals.ids.includes(wantedId))
      || (wantedName && signals.names.includes(wantedName))
    );
  }

  async function clickUntilTownChanges(node, beforeSignature) {
    node.click();
    try {
      await waitFor(() => currentTownSignature() !== beforeSignature, 1_800, 100);
      return true;
    } catch {
      return false;
    }
  }

  async function cycleToTown(townId, townName = '') {
    const maxSteps = Math.max(2, state.towns.length + 1);

    for (let step = 0; step < maxSteps; step += 1) {
      if (townMatches(townId, townName)) return true;
      const candidates = findNextTownNodes();
      if (!candidates.length) return false;

      let changed = false;
      for (const candidate of candidates) {
        const beforeSignature = currentTownSignature();
        if (await clickUntilTownChanges(candidate, beforeSignature)) {
          changed = true;
          break;
        }
      }
      if (!changed) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return townMatches(townId, townName);
  }

  async function openTownList() {
    if (townListRoots().some((node) => node.getClientRects().length > 0)) return;
    const trigger = document.querySelector(TOWN_DROPDOWN_SELECTOR);
    trigger?.click();
    try {
      await waitFor(() => (
        townListRoots().some((node) => node.getClientRects().length > 0)
      ), 2_000, 100);
    } catch {
      // The exact arrow fallback remains available if the dropdown did not open.
    }
  }

  async function tryTownSwitch(owner, method, wanted) {
    try {
      method.call(owner, wanted);
      await waitFor(() => currentTownId() === wanted, 2_500);
      return true;
    } catch {
      return false;
    }
  }

  async function switchTown(townId) {
    const wanted = String(townId || '');
    if (!wanted) throw new Error('Cidade sem identificador.');
    const wantedTown = state.townsById.get(wanted);
    if (townMatches(wanted, wantedTown?.name)) return readCurrentTown();

    const methods = [
      page.Layout && typeof page.Layout.townSwitch === 'function'
        ? [page.Layout, page.Layout.townSwitch] : null,
      page.Layout && typeof page.Layout.switchTown === 'function'
        ? [page.Layout, page.Layout.switchTown] : null,
      page.ITowns && typeof page.ITowns.setCurrentTown === 'function'
        ? [page.ITowns, page.ITowns.setCurrentTown] : null,
      page.ITowns && typeof page.ITowns.switchTown === 'function'
        ? [page.ITowns, page.ITowns.switchTown] : null
    ].filter(Boolean);

    for (const [owner, method] of methods) {
      if (await tryTownSwitch(owner, method, wanted)) break;
    }

    if (!townMatches(wanted, wantedTown?.name)) {
      await openTownList();
      const node = findTownSwitchNode(wanted, wantedTown?.name);
      if (node) {
        node.click();
        try {
          await waitFor(() => townMatches(wanted, wantedTown?.name), 4_000, 100);
        } catch {
          // Fall through to the exact next/previous arrows.
        }
      }
      if (!townMatches(wanted, wantedTown?.name)
        && !await cycleToTown(wanted, wantedTown?.name)) {
        const signals = currentTownSignals();
        throw new Error(
          `Não consegui selecionar ${wantedTown?.name || wanted}. Atual: ${signals.names.join(', ') || signals.ids.join(', ') || 'desconhecida'}.`
        );
      }
    }

    await waitFor(() => (
      townMatches(wanted, wantedTown?.name)
    ), 7_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    state.currentTown = readCurrentTown();
    return state.currentTown;
  }

  async function selectTownAssisted(townId) {
    if (state.settings.simulation) {
      log('simulation', `Simulação: selecionar cidade ${townId}`);
      toast('Simulação: a cidade não foi alterada.');
      return;
    }

    try {
      setValidation('town', 'running', 'A selecionar a cidade pedida.');
      const town = await switchTown(townId);
      scan();
      log('action', `Cidade selecionada: ${town.name}`, { townId });
      setValidation('town', 'success', `Troca de cidade confirmada: ${town.name}.`);
      toast(`${town.name} selecionada.`);
    } catch (error) {
      log('error', 'Falha ao selecionar cidade', { townId, error: error.message });
      setValidation('town', 'error', `Troca de cidade falhou: ${error.message}`);
      toast(`Não consegui selecionar a cidade: ${error.message}`);
    }
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    );
    if (descriptor?.set) descriptor.set.call(input, String(value));
    else input.value = String(value);
    const EventCtor = input.ownerDocument?.defaultView?.Event || Event;
    input.dispatchEvent(new EventCtor('input', { bubbles: true }));
    input.dispatchEvent(new EventCtor('change', { bubbles: true }));
    input.dispatchEvent(new EventCtor('keyup', { bubbles: true }));
    try {
      page.$?.(input)
        ?.val?.(value)
        ?.trigger?.('input')
        ?.trigger?.('change')
        ?.trigger?.('keyup');
    } catch {
      // Native events above are enough on clients without jQuery.
    }
  }

  function findCaveWindow() {
    const selectors = [
      '.js-window-main-container.classic_window.hide',
      '.classic_window.hide',
      '.window_type_hide',
      '[data-window_type="hide"]',
      '[data-window-type="hide"]'
    ];
    return selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find(visible) || null;
  }

  function findCaveInput() {
    const selectors = [
      '#hide_order_input',
      'input[name="iron"]',
      '.hide_order_input input',
      '.order_count input',
      'input.amount',
      'input[type="number"]',
      'input[type="text"]',
      'input:not([type])'
    ];
    const caveWindow = findCaveWindow();
    const roots = caveWindow
      ? [caveWindow]
      : [...document.querySelectorAll('#building_hide, .building_hide')].filter(visible);
    const candidates = roots.flatMap((root) => (
      selectors.flatMap((selector) => [...root.querySelectorAll(selector)])
    ));
    return [...new Set(candidates)].find((input) => (
      visible(input)
      && !input.disabled
      && !input.readOnly
      && input.type !== 'hidden'
      && !input.closest('#ga-dock')
    )) || null;
  }

  function findCaveConfirmButton() {
    const caveWindow = findCaveWindow();
    if (!caveWindow) return null;
    const selectors = [
      '.confirm_deposit',
      '.order_count button',
      '.btn_confirm',
      'button[type="submit"]'
    ];
    return selectors
      .flatMap((selector) => [...caveWindow.querySelectorAll(selector)])
      .find((button) => (
        visible(button)
        && !button.disabled
        && !button.closest('#ga-dock')
      )) || null;
  }

  async function executeCaveDeposit({ town, input, deposit }) {
    const decision = caveExecutionDecision({
      enabled: state.settings.autoConfirmCave,
      armed: isCaveExecutionArmed(),
      simulation: state.settings.simulation,
      amount: deposit,
      maxPerDeposit: state.settings.caveConfirmMax,
      spentInSession: state.execution.spentSilver,
      sessionBudget: state.settings.caveSessionBudget
    });
    if (!decision.allowed) return { finalized: false, reason: decision.reason };

    const button = findCaveConfirmButton();
    if (!button) return { finalized: false, reason: 'confirm-button-missing' };
    const caveWindow = findCaveWindow();
    const beforeSummary = caveWindow?.textContent || '';
    button.click();
    await waitFor(() => (
      !findCaveWindow()
      || numericInputValue(input.value) !== deposit
      || (findCaveWindow()?.textContent || '') !== beforeSummary
      || button.disabled
    ), 6_000, 100);

    state.execution.spentSilver += deposit;
    state.execution.confirmations += 1;
    state.execution.lastTownId = String(town.id);
    state.execution.lastAmount = deposit;
    state.execution.lastAt = Date.now();
    if (state.execution.spentSilver >= number(state.settings.caveSessionBudget)) {
      disarmCaveExecution('orçamento da sessão esgotado', false);
    }
    log('execution', `Depósito automático confirmado em ${town.name}.`, {
      townId: town.id,
      deposit,
      spentInSession: state.execution.spentSilver,
      sessionBudget: state.settings.caveSessionBudget
    });
    return { finalized: true, reason: 'executed' };
  }

  async function prepareCave(townId, { allowFinalize = false } = {}) {
    const town = state.townsById.get(String(townId)) || state.currentTown;
    if (!town) {
      toast('Não consegui identificar a cidade da gruta.');
      return false;
    }
    const deposit = calculateCaveDeposit({
      availableSilver: town.silver,
      storedSilver: town.caveSilver,
      reserve: state.settings.caveReserve,
      target: state.settings.caveTarget
    });
    if (deposit <= 0) {
      toast(`${town.name}: não há depósito sugerido.`);
      return false;
    }
    if (state.settings.simulation) {
      log('simulation', `Simulação: preparar ${deposit} de prata em ${town.name}`);
      toast(`Simulação: seriam preenchidos ${deposit.toLocaleString('pt-PT')} em ${town.name}.`);
      return true;
    }

    try {
      setValidation('cave', 'running', `A preparar a gruta de ${town.name}, sem depositar.`);
      await switchTown(town.id);
      let input = findCaveInput();
      if (!input) {
        const building = await waitFor(() => document.querySelector(
          '#building_hide, [data-building="hide"], .building_hide, .building.hide'
        ), 4_000);
        building.click();
        input = await waitFor(() => findCaveInput(), 6_000);
      }
      setInputValue(input, deposit);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (numericInputValue(input.value) !== deposit) {
        throw new Error(
          `O campo abriu, mas ficou com ${numericInputValue(input.value).toLocaleString('pt-PT')} em vez de ${deposit.toLocaleString('pt-PT')}.`
        );
      }
      const execution = allowFinalize
        ? await executeCaveDeposit({ town, input, deposit })
        : { finalized: false, reason: 'preparation-only' };
      log('action', `Gruta preparada em ${town.name}`, {
        townId: town.id,
        deposit,
        finalized: execution.finalized,
        executionReason: execution.reason
      });
      setValidation(
        'cave',
        'success',
        execution.finalized
          ? `Depósito confirmado em ${town.name}: ${deposit.toLocaleString('pt-PT')} enviados para a gruta.`
          : `Gruta confirmada em ${town.name}: ${deposit.toLocaleString('pt-PT')} preenchidos; depósito não enviado.`
      );
      updateTownActions(
        'cave',
        town.id,
        execution.finalized ? 'executed' : 'success',
        execution.finalized
          ? `${deposit.toLocaleString('pt-PT')} depositados automaticamente na gruta.`
          : 'Gruta preenchida; depósito ainda não confirmado.'
      );
      toast(
        execution.finalized
          ? `${deposit.toLocaleString('pt-PT')} depositados automaticamente em ${town.name}.`
          : `${deposit.toLocaleString('pt-PT')} preenchidos. Confirma o depósito na janela da gruta.`
      );
      scan();
      return {
        success: true,
        finalized: execution.finalized,
        reason: execution.reason
      };
    } catch (error) {
      log('error', `Falha ao preparar a gruta de ${town.name}`, { error: error.message });
      setValidation('cave', 'error', `Teste da gruta falhou em ${town.name}: ${error.message}`);
      updateTownActions('cave', town.id, 'error', error.message);
      toast(`Não consegui preparar a gruta: ${error.message}`);
      return false;
    }
  }

  function findSupportAction(menu) {
    if (!menu) return null;
    const selectors = [
      '#support',
      '.support',
      '[data-action="support"]',
      '[data-command-type="support"]',
      'button',
      'a'
    ];
    return [...new Set(selectors.flatMap((selector) => (
      [...menu.querySelectorAll(selector)]
    )))].find((node) => (
      visible(node)
      && /apoiar|apoio|support/i.test(node.textContent || node.getAttribute('title') || '')
      && !/atacar|attack/i.test(node.textContent || '')
    )) || null;
  }

  function findSupportCommandWindow() {
    const selectors = [
      '.command_window.support',
      '.window_type_support',
      '[data-command-type="support"]',
      '.classic_window',
      '.js-window-main-container'
    ];
    return selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((node) => (
        visible(node)
        && /apoiar|apoio|support/i.test(node.textContent || '')
        && !/atacar|attack/i.test(
          node.querySelector('h1,h2,h3,.window_title,.window_title_text')?.textContent || ''
        )
      )) || null;
  }

  function supportUnitInputs(commandWindow) {
    const selectors = [
      '.unit_input input',
      '.unit input',
      '[data-unit] input',
      'input[name^="unit"]'
    ];
    return [...new Set(selectors.flatMap((selector) => (
      [...commandWindow.querySelectorAll(selector)]
    )))].filter((input) => (
      visible(input)
      && !input.disabled
      && !input.readOnly
      && input.type !== 'hidden'
    ));
  }

  async function selectSupportUnits(commandWindow) {
    const inputs = supportUnitInputs(commandWindow);
    const available = inputs.map((input) => ({
      name: input.name || input.closest('[data-unit]')?.dataset.unit || '',
      available: number(
        input.dataset.max
        ?? input.max
        ?? input.closest('[data-max]')?.dataset.max
        ?? 0
      )
    }));
    const selection = calculateSupportSelection(
      available,
      state.settings.supportSendPercent,
      state.settings.supportReservePerUnit
    );
    inputs.forEach((input, index) => {
      setInputValue(input, selection.units[index]?.selected || 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return selection;
  }

  function findSupportSendButton(commandWindow) {
    const selectors = [
      '.send_command',
      '.btn_send',
      '[data-action="send"]',
      'button[type="submit"]',
      'button'
    ];
    return [...new Set(selectors.flatMap((selector) => (
      [...commandWindow.querySelectorAll(selector)]
    )))].find((button) => (
      visible(button)
      && !button.disabled
      && /enviar|send|apoiar|support/i.test(button.textContent || button.getAttribute('title') || '')
    )) || null;
  }

  function readSupportTravelSeconds(commandWindow) {
    const selectors = [
      '.way_duration',
      '.travel_duration',
      '.duration',
      '[data-duration]',
      '[data-travel-time]',
      '.arrival_time'
    ];
    for (const selector of selectors) {
      for (const node of commandWindow.querySelectorAll(selector)) {
        const direct = node.dataset.duration
          ?? node.dataset.travelTime
          ?? node.getAttribute('data-duration')
          ?? node.getAttribute('data-travel-time');
        if (direct !== null && direct !== undefined && direct !== '') {
          const numeric = number(direct, Number.NaN);
          if (Number.isFinite(numeric) && numeric >= 0) return numeric;
        }
        const parsed = parseDurationSeconds(
          node.textContent || node.getAttribute('title') || ''
        );
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }

  async function executeSupportCommand({ command, menu, safeTown }) {
    const supportAction = findSupportAction(menu);
    if (!supportAction) return { finalized: false, reason: 'support-action-missing' };
    supportAction.click();
    const commandWindow = await waitFor(() => findSupportCommandWindow(), 5_000, 100);
    const selection = await selectSupportUnits(commandWindow);
    const selectedUnits = selection.selectedTotal;
    const travelSeconds = readSupportTravelSeconds(commandWindow);
    const secondsUntilArrival = Math.floor((command.arrivalAt - gameNowMs()) / 1_000);
    const decision = supportExecutionDecision({
      enabled: state.settings.autoSendSupport,
      armed: isSupportExecutionArmed(),
      simulation: state.settings.simulation,
      synthetic: command.synthetic,
      secondsUntilArrival,
      minLeadSeconds: state.settings.supportMinLeadSeconds,
      sentInSession: state.execution.supportCommandsSent,
      sessionLimit: state.settings.supportSessionLimit,
      selectedUnits,
      travelSeconds,
      arrivalBufferSeconds: state.settings.supportArrivalBufferSeconds,
      requireTravelTime: state.settings.supportRequireTravelTime
    });
    if (decision.allowed
      && selectedUnits < Math.max(1, number(state.settings.supportMinimumTotal, 1))) {
      return {
        finalized: false,
        reason: 'below-minimum-total',
        selectedUnits,
        selection
      };
    }
    if (!decision.allowed) {
      return { finalized: false, reason: decision.reason, selectedUnits, selection };
    }

    const sendButton = findSupportSendButton(commandWindow);
    if (!sendButton) return { finalized: false, reason: 'send-button-missing', selectedUnits };
    sendButton.click();
    await waitFor(() => (
      !document.documentElement.contains(commandWindow)
      || sendButton.disabled
      || !visible(commandWindow)
    ), 6_000, 100);

    state.execution.supportCommandsSent += 1;
    state.execution.supportLastTownId = String(command.targetTownId);
    state.execution.supportLastTargetId = String(safeTown.id);
    state.execution.supportLastUnits = selectedUnits;
    state.execution.supportLastAt = Date.now();
    if (state.execution.supportCommandsSent >= number(state.settings.supportSessionLimit)) {
      disarmSupportExecution('limite da sessão atingido', false);
    }
    log('execution', `Apoio automático enviado: ${command.target} → ${safeTown.name}.`, {
      commandId: command.id,
      selectedUnits,
      availableUnits: selection.availableTotal,
      sendPercent: selection.percent,
      reservePerUnit: selection.reservePerUnit,
      travelSeconds,
      secondsUntilArrival,
      arrivalBufferSeconds: state.settings.supportArrivalBufferSeconds,
      sentInSession: state.execution.supportCommandsSent
    });
    return { finalized: true, reason: 'executed', selectedUnits, selection };
  }

  async function prepareDodge(
    commandId,
    safeTownOverride = '',
    { allowFinalize = false } = {}
  ) {
    const command = state.commands.find((item) => item.id === commandId);
    if (!command) {
      toast('O ataque já não está disponível.');
      return false;
    }
    const incident = state.reactions.find((item) => (
      item.type === 'attack'
      && item.commands.some((candidate) => candidate.id === command.id)
    )) || command;
    const policy = resolveTownPolicy(command.targetTownId, state.settings);
    const safeChoice = chooseSafeTown(command, safeTownOverride);
    const safeTownId = safeChoice.townId;
    const usedFallback = Boolean(safeTownId && safeTownId !== policy.safeTownId);
    if (!safeTownId) {
      state.settings.activeTab = 'policies';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast('Não existe uma cidade segura disponível para este desvio.');
      return false;
    }
    const safeTown = state.townsById.get(safeTownId);
    if (!safeTown) {
      toast('A cidade segura configurada já não existe.');
      return false;
    }
    if (state.settings.simulation) {
      log('simulation', `Simulação: preparar desvio de ${command.target} para ${safeTown.name}`);
      toast(`Simulação: selecionaria ${command.target} e abriria ${safeTown.name} no mapa.`);
      return true;
    }

    try {
      setValidation('dodge', 'running', `A preparar o desvio de ${command.target}, sem enviar tropas.`);
      await switchTown(command.targetTownId);
      const model = rawTown(safeTownId);
      if (!model) throw new Error('Modelo da cidade segura indisponível.');
      if (typeof page.WMap?.mapJump !== 'function') {
        throw new Error('Salto no mapa indisponível.');
      }
      page.WMap.mapJump(model, true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const menu = await openTownContextMenu(safeTownId, model, safeTown.name);
      const execution = allowFinalize
        ? await executeSupportCommand({ command, menu, safeTown })
        : { finalized: false, reason: 'preparation-only', selectedUnits: 0 };
      if (allowFinalize
        && !execution.finalized
        && [
          'support-action-missing',
          'send-button-missing',
          'no-units',
          'below-minimum-total',
          'travel-time-unknown',
          'arrival-too-late'
        ].includes(execution.reason)) {
        throw new Error(`Execução do apoio falhou: ${execution.reason}.`);
      }

      log('action', `${execution.finalized ? 'Desvio executado' : 'Desvio preparado'}: ${command.target} → ${safeTown.name}`, {
        commandId,
        threatenedTownId: command.targetTownId,
        safeTownId,
        finalized: execution.finalized,
        executionReason: execution.reason,
        selectedUnits: execution.selectedUnits
      });
      setValidation(
        'dodge',
        'success',
        execution.finalized
          ? `Apoio enviado: ${command.target} → ${safeTown.name}, com ${execution.selectedUnits.toLocaleString('pt-PT')} unidades selecionadas.`
          : `Desvio confirmado: ${command.target} selecionada e menu de ${safeTown.name} aberto${usedFallback ? ' como alternativa' : ''}; tropas não enviadas.`
      );
      upsertAction(
        incident,
        'dodge',
        execution.finalized ? 'executed' : 'success',
        execution.finalized
          ? `Apoio enviado automaticamente para ${safeTown.name}.`
          : `Menu de ${safeTown.name} aberto${usedFallback ? ' como alternativa' : ''}; tropas ainda não enviadas.`
      );
      toast(
        execution.finalized
          ? `Apoio enviado automaticamente para ${safeTown.name}.`
          : `Cidade ameaçada selecionada. Escolhe Apoiar ${safeTown.name} e confirma o envio.`
      );
      return {
        success: true,
        finalized: execution.finalized,
        reason: execution.reason
      };
    } catch (error) {
      log('error', 'Falha ao preparar o desvio', { commandId, error: error.message });
      setValidation('dodge', 'error', `Teste do desvio falhou: ${error.message}`);
      upsertAction(incident, 'dodge', 'error', error.message);
      toast(`Não consegui preparar o desvio: ${error.message}`);
      return false;
    }
  }

  function armAutomation() {
    if (state.automation.breakerOpen) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast('A proteção está ativada. Revê o diagnóstico e repõe o disjuntor.');
      return;
    }
    const preflight = runPreflight(false);
    if (!preflight.passed) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast(`Pré-verificação bloqueou o armamento: ${preflight.errors.length} erro(s).`);
      return;
    }
    const minutes = Math.max(1, number(state.settings.automationArmMinutes, 30));
    state.automation.armedUntil = gameNowMs() + minutes * 60_000;
    state.automation.handled.clear();
    resetActiveActions();
    log('automation', `Auto-preparação armada durante ${minutes} minutos.`);
    renderPanel();
    void runAutomation();
  }

  function armCaveExecution() {
    if (state.settings.simulation) {
      toast('Desativa o modo de simulação antes de armar a execução da gruta.');
      return;
    }
    if (!state.settings.autoConfirmCave) {
      toast('Ativa primeiro a opção de confirmar depósitos automaticamente.');
      return;
    }
    if (state.automation.breakerOpen) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast('A proteção está ativada. Repõe o disjuntor antes de armar a execução.');
      return;
    }
    const preflight = runPreflight(false);
    if (!preflight.passed) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast(`A execução da gruta foi bloqueada: ${preflight.errors.length} erro(s).`);
      return;
    }
    state.execution.caveArmedUntil = gameNowMs()
      + Math.max(1, number(state.settings.executionArmMinutes, 10)) * 60_000;
    state.execution.spentSilver = 0;
    state.execution.confirmations = 0;
    state.execution.lastTownId = '';
    state.execution.lastAmount = 0;
    state.execution.lastAt = 0;
    log('execution', 'Execução automática da gruta armada.', {
      minutes: state.settings.executionArmMinutes,
      maxPerDeposit: state.settings.caveConfirmMax,
      sessionBudget: state.settings.caveSessionBudget
    });
    renderPanel();
    toast('Execução da gruta armada. Mantém a página aberta e monitorizada.');
  }

  function disarmCaveExecution(reason = 'manual', render = true) {
    const wasArmed = state.execution.caveArmedUntil > 0;
    state.execution.caveArmedUntil = 0;
    if (wasArmed) log('execution', `Execução da gruta desarmada: ${reason}.`);
    if (render && state.root) renderPanel();
  }

  function armSupportExecution() {
    if (state.settings.simulation) {
      toast('Desativa o modo de simulação antes de armar o envio de apoios.');
      return;
    }
    if (!state.settings.autoSendSupport) {
      toast('Ativa primeiro a opção de enviar apoio automaticamente.');
      return;
    }
    if (state.automation.breakerOpen) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast('A proteção está ativada. Repõe o disjuntor antes de armar apoios.');
      return;
    }
    const preflight = runPreflight(false);
    if (!preflight.passed) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast(`O envio de apoios foi bloqueado: ${preflight.errors.length} erro(s).`);
      return;
    }
    state.execution.supportArmedUntil = gameNowMs()
      + Math.max(1, number(state.settings.supportExecutionArmMinutes, 10)) * 60_000;
    state.execution.supportCommandsSent = 0;
    state.execution.supportLastTownId = '';
    state.execution.supportLastTargetId = '';
    state.execution.supportLastUnits = 0;
    state.execution.supportLastAt = 0;
    log('execution', 'Envio automático de apoios armado.', {
      minutes: state.settings.supportExecutionArmMinutes,
      sessionLimit: state.settings.supportSessionLimit,
      minLeadSeconds: state.settings.supportMinLeadSeconds
    });
    renderPanel();
    toast('Envio de apoios armado. Apenas a ação Apoiar será utilizada.');
  }

  function disarmSupportExecution(reason = 'manual', render = true) {
    const wasArmed = state.execution.supportArmedUntil > 0;
    state.execution.supportArmedUntil = 0;
    if (wasArmed) log('execution', `Envio de apoios desarmado: ${reason}.`);
    if (render && state.root) renderPanel();
  }

  function runPreflight(showResult = true) {
    state.diagnostic = buildDiagnostic();
    const preflight = state.diagnostic.preflight;
    log(
      'preflight',
      preflight.passed
        ? `Pré-verificação concluída: ${preflight.score}/100.`
        : `Pré-verificação bloqueada: ${preflight.errors.length} erro(s), ${preflight.warnings.length} aviso(s).`,
      preflight
    );
    if (showResult) {
      state.settings.activeTab = 'diagnostic';
      save(STORAGE_KEY, state.settings);
      renderPanel();
      toast(
        preflight.passed
          ? `Pré-verificação aprovada: ${preflight.score}/100.`
          : `Pré-verificação encontrou ${preflight.errors.length} erro(s).`
      );
    }
    return preflight;
  }

  function resetCircuitBreaker() {
    state.automation.consecutiveFailures = 0;
    state.automation.breakerOpen = false;
    state.automation.breakerReason = '';
    state.automation.handled.clear();
    resetActiveActions();
    state.diagnostic = buildDiagnostic();
    log('automation', 'Proteção operacional reposta manualmente.');
    renderPanel();
    toast('Proteção reposta. A auto-preparação continua desarmada.');
  }

  function registerAutomationOutcome(success, message = '') {
    const next = nextAutomationFailureState(
      success,
      state.automation.consecutiveFailures,
      state.settings.automationFailureLimit
    );
    state.automation.consecutiveFailures = next.consecutiveFailures;
    state.automation.lastAutomationAt = Date.now();
    if (success) {
      state.automation.lastSuccessAt = Date.now();
      state.automation.breakerReason = '';
      return;
    }
    if (next.breakerOpen) {
      state.automation.breakerOpen = true;
      state.automation.breakerReason = message
        || `${next.consecutiveFailures} falhas consecutivas na auto-preparação.`;
      disarmAutomation('proteção por falhas repetidas', false);
      disarmCaveExecution('proteção por falhas repetidas', false);
      disarmSupportExecution('proteção por falhas repetidas', false);
      log('automation', 'Disjuntor de segurança ativado.', {
        failures: next.consecutiveFailures,
        reason: state.automation.breakerReason
      });
      toast('Auto-preparação interrompida após falhas repetidas.');
    }
  }

  function disarmAutomation(reason = 'manual', render = true) {
    const wasArmed = state.automation.armedUntil > 0;
    state.automation.armedUntil = 0;
    if (wasArmed) log('automation', `Auto-preparação desarmada: ${reason}.`);
    if (render && state.root) renderPanel();
  }

  async function runAutomation() {
    const now = gameNowMs();
    if (state.automation.breakerOpen
      || !state.settings.enabled
      || state.automation.busy
      || !isAutomationArmed(now)) return;

    const activeKeys = new Set();
    const candidates = state.reactions
      .map((command) => {
        const decision = policyDecision(command, now, state.settings);
        const key = automationKey(command, decision.action);
        if (decision.action) activeKeys.add(key);
        return { command, decision, key };
      })
      .filter(({ decision, key }) => (
        decision.due
        && decision.action
        && !state.automation.handled.has(key)
      ))
      .sort(compareReactionCandidates);

    for (const key of state.automation.handled.keys()) {
      if (!activeKeys.has(key)) state.automation.handled.delete(key);
    }
    const candidate = candidates[0];
    if (!candidate) return;

    const { command, decision, key } = candidate;
    if (decision.action === 'cave') {
      const town = state.townsById.get(String(command.targetTownId));
      if (!town) {
        state.automation.handled.set(key, { status: 'blocked', at: now });
        upsertAction(command, decision.action, 'blocked', 'Cidade ameaçada indisponível.');
        log('automation', `Auto-preparação ignorada: cidade ${command.target} indisponível.`);
        return;
      }
      const deposit = calculateCaveDeposit({
        availableSilver: town.silver,
        storedSilver: town.caveSilver,
        reserve: state.settings.caveReserve,
        target: state.settings.caveTarget
      });
      if (deposit <= 0) {
        state.automation.handled.set(key, { status: 'skipped', at: now });
        upsertAction(command, decision.action, 'skipped', 'A gruta já cumpre o objetivo ou não há prata disponível.');
        log('automation', `Gruta de ${town.name} sem depósito necessário.`);
        return;
      }
    }
    const safeChoice = decision.action === 'dodge' ? chooseSafeTown(command) : null;
    if (decision.action === 'dodge' && !safeChoice.townId) {
      state.automation.handled.set(key, { status: 'blocked', at: now });
      upsertAction(
        command,
        decision.action,
        'blocked',
        'Não existe uma cidade segura disponível. Verifica destinos e bloqueios.'
      );
      log('automation', `Desvio de ${command.target} bloqueado: nenhum destino seguro disponível.`);
      return;
    }

    state.automation.busy = true;
    upsertAction(command, decision.action, 'running', 'Preparação automática em curso.');
    log('automation', `Auto-preparação iniciada: ${labelType(command.type)} para ${command.target}.`);
    try {
      const result = decision.action === 'cave'
        ? await prepareCave(command.targetTownId, {
          allowFinalize: isCaveExecutionArmed() && !command.synthetic
        })
        : await prepareDodge(command.commands[0].id, safeChoice.townId, {
          allowFinalize: isSupportExecutionArmed() && !command.synthetic
        });
      const success = typeof result === 'object' ? result.success : result;
      const finalized = Boolean(typeof result === 'object' && result.finalized);
      registerAutomationOutcome(
        success,
        `Falha ao preparar ${labelType(command.type).toLowerCase()} para ${command.target}.`
      );
      state.automation.handled.set(key, {
        status: success ? 'success' : 'error',
        at: gameNowMs()
      });
      upsertAction(
        command,
        decision.action,
        success ? finalized ? 'executed' : 'success' : 'error',
        success
          ? finalized
            ? decision.action === 'cave'
              ? 'Depósito confirmado automaticamente dentro dos limites da sessão.'
              : 'Apoio enviado automaticamente dentro dos limites da sessão.'
            : 'Preparação concluída; a ação final continua por confirmar.'
          : 'A preparação falhou; é necessária intervenção manual.'
      );
      log(
        'automation',
        success
          ? `Auto-preparação concluída para ${command.target}.`
          : `Auto-preparação falhou para ${command.target}; intervenção manual necessária.`
      );
    } catch (error) {
      registerAutomationOutcome(false, error.message);
      state.automation.handled.set(key, {
        status: 'error',
        at: gameNowMs()
      });
      upsertAction(command, decision.action, 'error', error.message);
      log('error', 'Erro inesperado na auto-preparação.', {
        error: error.message,
        commandId: command.id
      });
    } finally {
      state.automation.busy = false;
      if (state.root) renderPanel();
    }
  }

  async function openTownContextMenu(townId, model, townName) {
    const fragment = model?.getLinkFragment?.();
    if (fragment) {
      const link = document.createElement('a');
      link.className = 'gp_town_link';
      link.href = fragment;
      link.dataset.townId = String(townId);
      link.textContent = townName;
      link.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden';
      document.body.appendChild(link);
      try {
        link.click();
        const menu = await waitFor(() => {
          const context = document.querySelector('#context_menu');
          return visible(context) ? context : null;
        }, 2_500);
        return menu;
      } catch {
        // Fall back to the map event used by clients without gp_town_link handling.
      } finally {
        link.remove();
      }
    }

    const clickEvent = page.GameEvents?.map?.town?.click;
    const observer = page.$?.Observer;
    if (!clickEvent || typeof observer !== 'function') {
      throw new Error('Não consegui abrir o menu contextual da cidade segura.');
    }
    observer(clickEvent).publish(buildMapTownPayload(townId, model, townName));
    return waitFor(() => {
      const menu = document.querySelector('#context_menu');
      return visible(menu) ? menu : null;
    }, 4_000);
  }

  function toast(message) {
    document.querySelector('.ga-toast')?.remove();
    const node = document.createElement('div');
    node.className = 'ga-toast';
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 2_800);
  }

  function schedule() {
    clearInterval(state.timer);
    if (state.settings.enabled) {
      state.timer = setInterval(() => scan(), Math.max(2_000, state.settings.scanInterval));
    }
  }

  function scheduleClock() {
    clearInterval(state.clockTimer);
    updateLiveTimes();
    state.clockTimer = setInterval(updateLiveTimes, 1_000);
  }

  function observe() {
    state.observer?.disconnect();
    let pending;
    state.observer = new MutationObserver((mutations) => {
      const onlyAssistant = mutations.every((mutation) => (
        mutation.target instanceof Element
        && Boolean(mutation.target.closest('#ga-dock, .ga-toast'))
      ));
      if (onlyAssistant) return;
      clearTimeout(pending);
      pending = setTimeout(() => scan(), 700);
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-command_id']
    });
  }

  function boot() {
    if (page.__grepolisAssistantLoaded) return;
    page.__grepolisAssistantLoaded = VERSION;
    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
    window.addEventListener('pointercancel', handleDragEnd);
    window.addEventListener('resize', applyPanelPosition);
    document.addEventListener('wheel', handlePanelWheel, { capture: true, passive: false });
    createShell();
    scan();
    schedule();
    scheduleClock();
    observe();
    log('system', `Grepolis Assistant v${VERSION} iniciado`, {
      world: page.Game?.world_id || location.hostname,
      simulation: state.settings.simulation
    });
    console.info(`[GA] Grepolis Assistant v${VERSION} iniciado.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}());
