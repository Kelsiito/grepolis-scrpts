// ==UserScript==
// @name         Grepolis Fakes PT
// @namespace    https://grepolis.com/
// @version      1.4.0
// @description  Divide uma ofensiva terrestre em três fakes e um ataque real.
// @author       unknown
// @match        https://*.grepolis.com/game/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisFakesFactory() {
  'use strict';

  const uw = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const BUTTON_CLASS = 'grepolis-fakes-button';
  const VERSION = '1.4.0';
  const ATTACK_ROOT_SELECTORS = [
    '.attack_support_window.attack',
    '.attack_support_window',
    '.command_window.attack',
    '.town_info_attack',
    '[class*="attack_support"]',
    '.gpwindow_content',
    '.window_content'
  ];
  const SEND_SELECTORS = [
    '#btn_attack_town',
    '.send_command',
    '.btn_attack',
    '.attack_button',
    'button[type="submit"]',
    '.button_new[type="submit"]'
  ];
  const MAIN_UNITS = new Set(['slinger', 'hoplite', 'rider', 'chariot']);
  const EXCLUDED_FROM_MINIMUM = new Set(['militia']);
  let sending = false;

  function asInteger(value) {
    const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function unitName(input) {
    const holder = input?.closest?.('[data-unit], [data-unit_id], [data-unit-id], .unit_input, .unit');
    const raw = input?.dataset?.unit
      || input?.dataset?.unitId
      || holder?.dataset?.unit
      || holder?.dataset?.unitId
      || input?.name
      || input?.id
      || '';
    const normalized = String(raw)
      .toLowerCase()
      .replace(/^(?:input[_-])?(?:unit[_-])?/, '')
      .replace(/[_-]input$/, '');
    if (unitData(normalized).population || unitData(normalized).pop) return normalized;

    const classText = `${input?.className || ''} ${holder?.className || ''}`.toLowerCase();
    const knownNames = Object.keys(uw.GameData?.units || {});
    return knownNames.find((name) => new RegExp(`(?:^|\\s|_)${name}(?:$|\\s|_)`).test(classText))
      || normalized;
  }

  function unitData(name) {
    return uw.GameData?.units?.[name] || {};
  }

  function unitPopulation(name) {
    return Math.max(1, asInteger(unitData(name).population || unitData(name).pop || 1));
  }

  function availableCount(input) {
    const holder = input.closest?.('[data-max]');
    const container = input.closest?.('.unit_container');
    const candidates = [
      input.dataset?.max,
      input.getAttribute?.('max'),
      holder?.dataset?.max,
      container?.querySelector?.('[data-unit_count]')?.dataset?.unit_count,
      input.closest?.('.unit')?.querySelector?.('.amount, .unit_amount, .value')?.textContent
    ];
    for (const candidate of candidates) {
      const value = asInteger(candidate);
      if (value || String(candidate || '').trim() === '0') return value;
    }
    return asInteger(input.value);
  }

  function collectUnits(root) {
    const byName = new Map();
    root.querySelectorAll(
      'input.unit_input, input[name*="unit"], [data-unit] input, [data-unit_id] input, [data-unit-id] input, .unit_input input'
    ).forEach((input) => {
      const name = unitName(input);
      if (!name || byName.has(name)) return;
      byName.set(name, {
        name,
        input,
        available: availableCount(input),
        population: unitPopulation(name)
      });
    });
    return [...byName.values()];
  }

  function readDisplayedMinimum(root) {
    const direct = root.querySelector(
      '[data-min-population], .attack_min_population, .minimum_population, .min_population'
    );
    if (direct) {
      const value = asInteger(direct.dataset?.minPopulation || direct.textContent);
      if (value) return value;
    }
    const text = root.textContent || '';
    const match = text.match(/(?:m[ií]nim[oa]|minimum)[^\d]{0,30}(\d[\d .]*)[^\n]{0,20}(?:pop|habit)/i);
    return match ? asInteger(match[1]) : 0;
  }

  function calculateMinimumPopulation(units, displayedMinimum = 0, totalMilitaryPopulation = 0) {
    if (displayedMinimum > 0) return Math.ceil(displayedMinimum);
    const availablePopulation = units
      .filter((unit) => !EXCLUDED_FROM_MINIMUM.has(unit.name))
      .reduce((sum, unit) => sum + unit.available * unit.population, 0);
    return Math.ceil(Math.max(availablePopulation, totalMilitaryPopulation) * 0.03);
  }

  function populationFromUnitBag(bag) {
    if (!bag || typeof bag !== 'object') return 0;
    return Object.entries(bag).reduce((sum, [name, count]) => {
      if (EXCLUDED_FROM_MINIMUM.has(name) || !unitData(name).population) return sum;
      return sum + asInteger(count) * unitPopulation(name);
    }, 0);
  }

  function collectionModels(name) {
    return uw.MM?.getOnlyCollectionByName?.(name)?.models || [];
  }

  function totalMilitaryPopulation(originTownId) {
    const townId = String(originTownId);
    let total = 0;

    collectionModels('Units').forEach((model) => {
      const attrs = model?.attributes || model || {};
      if (String(attrs.home_town_id) === townId) total += populationFromUnitBag(attrs);
    });

    collectionModels('MovementsUnits').forEach((model) => {
      const attrs = model?.attributes || model || {};
      const origin = attrs.origin_town_id ?? attrs.home_town_id ?? attrs.town_id;
      if (String(origin) !== townId) return;
      total += populationFromUnitBag(attrs.units || attrs.unit_counts || attrs);
    });

    collectionModels('UnitOrder').forEach((model) => {
      const attrs = model?.attributes || model || {};
      if (String(attrs.town_id ?? attrs.home_town_id) !== townId) return;
      const name = attrs.unit_type || attrs.unit_id || attrs.type;
      const count = attrs.units_left ?? attrs.count ?? attrs.amount ?? attrs.units_total;
      if (name && unitData(name).population) total += asInteger(count) * unitPopulation(name);
    });

    return total;
  }

  function chooseMainUnit(units) {
    return units
      .filter((unit) => MAIN_UNITS.has(unit.name) && unit.available > 0)
      .sort((left, right) => right.available - left.available || left.name.localeCompare(right.name))[0] || null;
  }

  function randomRealPosition(random = Math.random) {
    return Math.min(3, Math.max(0, Math.floor(random() * 4)));
  }

  function buildAttackBatch({
    mainName,
    mainAvailable,
    mainPopulation,
    offensiveUnits = [],
    catapults,
    minimumPopulation,
    realPosition
  }) {
    const catapultPopulation = unitPopulation('catapult');
    if (catapults < 4) throw new Error('São necessárias pelo menos 4 catapultas: 3 fakes + ataque real.');
    const requiredMainPerFake = Math.max(
      0,
      Math.ceil((minimumPopulation - catapultPopulation) / mainPopulation)
    );
    const fakeMainTotal = requiredMainPerFake * 3;
    if (mainAvailable <= fakeMainTotal) {
      throw new Error(`Tropas insuficientes. Cada fake precisa de ${requiredMainPerFake} ${mainName}.`);
    }
    const fake = { [mainName]: requiredMainPerFake, catapult: 1 };
    const real = {};
    offensiveUnits.forEach((unit) => {
      if (MAIN_UNITS.has(unit.name) && unit.available > 0) real[unit.name] = unit.available;
    });
    real[mainName] = mainAvailable - fakeMainTotal;
    real.catapult = catapults - 3;
    return Array.from({ length: 4 }, (_, index) => index === realPosition ? real : { ...fake });
  }

  function findSendButton(root) {
    for (const selector of SEND_SELECTORS) {
      const button = root.querySelector(selector);
      if (button && !button.classList.contains(BUTTON_CLASS)) return button;
    }
    const byText = [...root.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
      .find((element) => /^(atacar|attack)$/i.test(String(element.textContent || element.value || '').trim()));
    if (byText && !byText.classList.contains(BUTTON_CLASS)) return byText;
    return null;
  }

  function setInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function zeroInputs(units) {
    units.forEach((unit) => setInput(unit.input, 0));
  }

  function attackWindow(root) {
    const content = root.closest('.gpwindow_content');
    const windowId = asInteger(content?.id?.replace('gpwnd_', ''));
    const manager = uw.GPWindowMgr;
    return manager?.getWindowById?.(windowId) || manager?.GetByID?.(windowId) || null;
  }

  function attackMetadata(root) {
    const targetMatch = String(root.className || '').match(/attack_support_tab_target_(\d+)/);
    const targetId = asInteger(targetMatch?.[1]);
    const type = root.querySelector('.attack_type.checked')?.dataset?.attack || 'attack';
    const strategies = [...root.querySelectorAll('.attack_strategy.checked')]
      .map((element) => element.dataset.attack)
      .filter(Boolean);
    const power = root.querySelector('#spells_1')?.dataset?.attack;
    if (!targetId) throw new Error('ID da cidade-alvo não encontrado.');
    return { targetId, type, strategies, power };
  }

  function sendNativeRequest(wnd, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Grepolis não confirmou o envio em 15 segundos.'));
      }, 15_000);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        callback(value);
      };
      wnd.ajaxRequestPost(wnd.getController?.() || 'town_info', 'send_units', payload, {
        success: (response) => finish(resolve, response),
        error: (...args) => {
          const candidates = args.flatMap((value) => [
            value,
            value?.responseJSON,
            value?.json,
            value?.error,
            value?.message,
            value?.error?.message
          ]).filter(Boolean);
          const detailValue = candidates.find((value) => typeof value === 'string')
            || candidates.find((value) => typeof value === 'object');
          let detail = '';
          if (typeof detailValue === 'string') detail = detailValue;
          else if (detailValue) {
            try { detail = JSON.stringify(detailValue); } catch (_) { detail = String(detailValue); }
          }
          finish(reject, new Error(detail ? `Grepolis rejeitou: ${detail}` : 'Grepolis rejeitou o ataque.'));
        }
      });
    });
  }

  async function sendAttackBatch(root, batch) {
    const wnd = attackWindow(root);
    if (!wnd?.ajaxRequestPost) throw new Error('Controlador nativo da janela não encontrado.');
    const metadata = attackMetadata(root);
    let sent = 0;
    for (const composition of batch) {
      const payload = {
        ...composition,
        id: metadata.targetId,
        type: metadata.type
      };
      if (metadata.strategies.length) payload.attacking_strategy = metadata.strategies;
      if (metadata.power && metadata.power !== 'no_power') payload.power_id = metadata.power;
      try {
        await sendNativeRequest(wnd, payload);
        sent += 1;
        uw.$?.Observer?.(uw.GameEvents?.command?.send_unit)?.publish?.({
          sending_type: payload.type,
          target_id: metadata.targetId,
          params: payload
        });
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      } catch (error) {
        throw new Error(`${sent}/4 enviados. ${error.message}`);
      }
    }
    return sent;
  }

  function notify(message, type = 'error') {
    const notifier = uw.HumanMessage;
    if (type === 'success' && typeof notifier?.success === 'function') notifier.success(message);
    else if (typeof notifier?.error === 'function') notifier.error(message);
    else window.alert(message);
  }

  async function runBatch(root, button) {
    if (sending) return;
    sending = true;
    button.disabled = true;
    try {
      const units = collectUnits(root);
      const catapult = units.find((unit) => unit.name === 'catapult');
      const main = chooseMainUnit(units);
      if (!catapult || catapult.available < 4) {
        throw new Error('São necessárias pelo menos 4 catapultas disponíveis.');
      }
      if (!main) throw new Error('Tropa principal não encontrada: fundibulários, hoplitas, cavaleiros ou carros.');

      const originTownId = uw.Game?.townId;
      const militaryPopulation = totalMilitaryPopulation(originTownId);
      const minimumPopulation = calculateMinimumPopulation(
        units,
        readDisplayedMinimum(root),
        militaryPopulation
      );
      // Ordem pedida: fake, fake, real, fake.
      const realPosition = 2;
      let batch = buildAttackBatch({
        mainName: main.name,
        mainAvailable: main.available,
        mainPopulation: main.population,
        offensiveUnits: units,
        catapults: catapult.available,
        minimumPopulation,
        realPosition
      });

      button.title = `v${VERSION} | mínimo ${minimumPopulation} pop | ${batch[0][main.name]} ${main.name} + 1 cata`;
      try {
        await sendAttackBatch(root, batch);
      } catch (error) {
        const officialMinimum = String(error.message).match(
          /0\/4 enviados[\s\S]*?pelo menos por\s+(\d+)\s+habitantes/i
        );
        if (!officialMinimum) throw error;
        const correctedMinimum = asInteger(officialMinimum[1]);
        batch = buildAttackBatch({
          mainName: main.name,
          mainAvailable: main.available,
          mainPopulation: main.population,
          offensiveUnits: units,
          catapults: catapult.available,
          minimumPopulation: correctedMinimum,
          realPosition
        });
        button.title = `v${VERSION} | mínimo oficial ${correctedMinimum} pop | ${batch[0][main.name]} ${main.name} + 1 cata`;
        await sendAttackBatch(root, batch);
      }
      zeroInputs(units);
      notify(`4 ataques enviados. Real na posição ${realPosition + 1}.`, 'success');
      button.disabled = false;
      sending = false;
    } catch (error) {
      notify(`Fakes: ${error.message}`);
      button.disabled = false;
      sending = false;
    }
  }

  function looksLikeAttackWindow(root) {
    if (!root || !root.querySelector) return false;
    const classes = String(root.className || '').toLowerCase();
    const text = String(root.textContent || '').toLowerCase();
    return classes.includes('attack') || /\batacar\b|\battack\b/.test(text);
  }

  function findColonizerAnchor(root, sendButton) {
    const runtimeButton = root.querySelector('#btn_runtime');
    if (runtimeButton) return runtimeButton;
    const explicit = root.querySelector(
      '.colonize, .colonization, '
      + '[class*="coloniz"], [class*="colonis"], [class*="colon_ship"]'
    );
    if (explicit) return explicit.closest('a, button') || explicit;

    const sendRect = sendButton.getBoundingClientRect();
    return [...root.querySelectorAll('a, button')]
      .filter((element) => {
        if (element === sendButton || element.classList.contains(BUTTON_CLASS)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0
          && rect.width <= 48
          && Math.abs(rect.top - sendRect.top) <= 12
          && rect.left > sendRect.right;
      })
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left)[0]
      || null;
  }

  function placeButton(root, sendButton, button) {
    const colonizer = findColonizerAnchor(root, sendButton);
    const anchor = colonizer || sendButton;
    if (button.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', button);
  }

  function addButton(root) {
    if (!looksLikeAttackWindow(root)) return;
    const sendButton = findSendButton(root);
    const catapultInput = collectUnits(root).find((unit) => unit.name === 'catapult');
    if (!sendButton || !catapultInput) return;

    const existing = root.querySelector(`.${BUTTON_CLASS}`);
    if (existing) {
      placeButton(root, sendButton, existing);
      return;
    }

    const button = document.createElement('div');
    button.className = `${BUTTON_CLASS} button_new`;
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('name', 'Fakes');
    button.title = `Grepolis Fakes v${VERSION}`;
    button.innerHTML = '<div class="left"></div><div class="right"></div>'
      + '<div class="caption js-caption"><span>Fakes</span><div class="effect js-effect"></div></div>';
    button.style.marginLeft = '6px';
    button.addEventListener('click', () => runBatch(root, button));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') runBatch(root, button);
    });
    placeButton(root, sendButton, button);
  }

  function scan() {
    ATTACK_ROOT_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach(addButton);
    });
  }

  if (typeof document !== 'undefined') {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }

  const Core = {
    calculateMinimumPopulation,
    chooseMainUnit,
    randomRealPosition,
    buildAttackBatch
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window !== 'undefined') window.GrepolisFakesCore = Core;
})();
