// ==UserScript==
// @name         Grepolis Profile Spam PT
// @namespace    https://grepolis.com/
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-spam.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-spam.user.js
// @version      1.0.5
// @description  Envia ataques mínimos, em fila, a partir do perfil de outro jogador.
// @author       unknwon
// @match        https://*.grepolis.com/game/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function grepolisProfileSpamFactory() {
  'use strict';

  const page = typeof unsafeWindow === 'undefined' ? globalThis : unsafeWindow;
  const VERSION = '1.0.5';
  const CONTROL_CLASS = 'gps-controls';
  const SEND_DELAY_MS = 450;
  const PROFILE_SELECTORS = [
    '.player_info', '.player_profile', '.gpwindow_content.player',
    '.gpwindow_content [class*="player_info"]', '.gpwindow_content [class*="player_profile"]',
    '.gpwindow_content'
  ];
  const state = { running: false, stopRequested: false, remaining: 0, root: null };

  function integer(value) {
    const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function attributes(model) {
    return model?.attributes || model || {};
  }

  function unitPopulation(name, unitData = {}) {
    return Math.max(1, integer(unitData?.[name]?.population ?? unitData?.[name]?.pop ?? 1));
  }

  function isNaval(name, unitData = {}) {
    const data = unitData?.[name] || {};
    return Boolean(data.is_naval ?? data.naval ?? data.isNaval)
      || /^(?:small_transporter|big_transporter|bireme|attack_ship|demolition_ship|colonize_ship|sea_monster)$/.test(name);
  }

  function isFlying(name, unitData = {}) {
    const data = unitData?.[name] || {};
    return Boolean(data.flying ?? data.is_flying ?? data.isFlying);
  }

  function transportCapacity(name, unitData = {}) {
    return integer(unitData?.[name]?.capacity ?? unitData?.[name]?.transport_capacity ?? 0);
  }

  function bagPopulation(units = {}, unitData = {}) {
    return Object.entries(units).reduce(
      (sum, [name, count]) => sum + integer(count) * unitPopulation(name, unitData), 0
    );
  }

  function calculateMinimumPopulation(units = {}, unitData = {}, officialMinimum = 0, militaryPopulation = 0) {
    if (integer(officialMinimum)) return integer(officialMinimum);
    const basis = Math.max(bagPopulation(units, unitData), integer(militaryPopulation));
    return Math.max(1, Math.ceil(basis * 0.03));
  }

  function selectAttackableUnits(units = {}, unitData = {}) {
    const selected = {};
    const land = [];
    let capacity = 0;
    Object.entries(units).forEach(([name, rawCount]) => {
      const count = integer(rawCount);
      const data = unitData?.[name] || {};
      if (!count || name === 'militia' || name === 'colonize_ship' || /hero/i.test(name)) return;
      if (data.can_attack === false || data.attackable === false) return;
      const perShip = transportCapacity(name, unitData);
      if (perShip) {
        selected[name] = count;
        capacity += count * perShip;
      } else if (isNaval(name, unitData) || isFlying(name, unitData)) {
        selected[name] = count;
      } else {
        land.push({ name, count, population: unitPopulation(name, unitData) });
      }
    });
    land.sort((left, right) => left.population - right.population || left.name.localeCompare(right.name));
    let used = 0;
    land.forEach((unit) => {
      const allowed = Math.min(unit.count, Math.floor((capacity - used) / unit.population));
      if (allowed > 0) {
        selected[unit.name] = allowed;
        used += allowed * unit.population;
      }
    });
    return selected;
  }

  function transportUsage(units = {}, unitData = {}) {
    let required = 0;
    let available = 0;
    Object.entries(units).forEach(([name, rawCount]) => {
      const count = integer(rawCount);
      const capacity = transportCapacity(name, unitData);
      if (capacity) available += count * capacity;
      else if (!isNaval(name, unitData) && !isFlying(name, unitData)) {
        required += count * unitPopulation(name, unitData);
      }
    });
    return { required, available, valid: required <= available };
  }

  function distributeUnits(units = {}, commandCount = 1) {
    const count = Math.max(1, integer(commandCount));
    const bags = Array.from({ length: count }, () => ({}));
    Object.entries(units).forEach(([name, rawAmount]) => {
      const amount = integer(rawAmount);
      const base = Math.floor(amount / count);
      const remainder = amount % count;
      bags.forEach((bag, index) => {
        const value = base + (index < remainder ? 1 : 0);
        if (value) bag[name] = value;
      });
    });
    return bags;
  }

  function buildTownBatches(units = {}, unitData = {}, minimumPopulation = 1) {
    const chosen = selectAttackableUnits(units, unitData);
    const total = bagPopulation(chosen, unitData);
    let count = Math.floor(total / Math.max(1, integer(minimumPopulation)));
    while (count > 0) {
      const bags = distributeUnits(chosen, count);
      if (bags.every((bag) => (
        bagPopulation(bag, unitData) >= minimumPopulation && transportUsage(bag, unitData).valid
      ))) return bags;
      count -= 1;
    }
    return [];
  }

  function roundRobinTargets(commandCount, targets = []) {
    if (!targets.length) return [];
    return Array.from({ length: Math.max(0, integer(commandCount)) }, (_, index) => targets[index % targets.length]);
  }

  function buildAttackQueue(origins = [], targets = [], unitData = {}) {
    if (!targets.length) return [];
    const perOrigin = origins.map((origin) => {
      const selected = selectAttackableUnits(origin.units, unitData);
      const minimum = calculateMinimumPopulation(
        selected, unitData, origin.minimumPopulation, origin.militaryPopulation
      );
      return buildTownBatches(origin.units, unitData, minimum).map((units) => ({
        originTownId: String(origin.id), originTownName: origin.name, minimum, units
      }));
    });
    const queue = [];
    let targetIndex = 0;
    let depth = 0;
    while (perOrigin.some((batches) => depth < batches.length)) {
      perOrigin.forEach((batches) => {
        if (!batches[depth]) return;
        queue.push({ ...batches[depth], target: targets[targetIndex % targets.length] });
        targetIndex += 1;
      });
      depth += 1;
    }
    return queue;
  }

  function buildPayload(job) {
    return {
      id: integer(job.target.id),
      town_id: integer(job.originTownId),
      type: 'attack',
      nl_init: true,
      ...job.units
    };
  }

  function collection(name) {
    try {
      const direct = page.MM?.getModels?.()?.[name];
      if (direct && typeof direct === 'object') return Object.values(direct).map(attributes);
      return (page.MM?.getOnlyCollectionByName?.(name)?.models || []).map(attributes);
    } catch { return []; }
  }

  function ownTowns() {
    let source = null;
    try { source = page.ITowns?.towns ?? page.ITowns?.getTowns?.(); } catch { source = null; }
    const rows = Array.isArray(source) ? source : Object.values(source || {});
    return rows.map((town) => {
      const data = attributes(town);
      const id = String(town?.getId?.() ?? town?.id ?? data.id ?? data.town_id ?? '');
      const name = String(town?.getName?.() ?? town?.name ?? data.name ?? `Cidade ${id}`);
      let units = {};
      try { units = town?.units?.() ?? town?.getUnits?.() ?? data.units ?? {}; } catch { units = {}; }
      return { id, name, units: attributes(units) };
    }).filter((town) => town.id);
  }

  function groups() {
    const memberships = [...collection('TownGroupTown'), ...collection('TownGroupTowns')];
    const names = [...collection('TownGroup'), ...collection('TownGroups')];
    const byId = new Map(names.map((group) => [String(group.id ?? group.group_id), String(group.name ?? group.title ?? 'Grupo')]));
    const result = new Map();
    memberships.forEach((membership) => {
      const groupId = String(membership.group_id ?? membership.town_group_id ?? '');
      const townId = String(membership.town_id ?? membership.id ?? '');
      if (!groupId || !townId || groupId === '-1') return;
      if (!result.has(groupId)) result.set(groupId, { id: groupId, name: byId.get(groupId) || `Grupo ${groupId}`, townIds: [] });
      result.get(groupId).townIds.push(townId);
    });
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  }

  function administratorActive() {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      page.Game?.premium_features?.curator,
      page.Game?.premium_features?.administrator,
      page.PremiumFeatures?.curator,
      page.PremiumFeatures?.administrator
    ];
    const model = collection('PremiumFeatures').find((item) => /curator|administrator/i.test(String(item.feature ?? item.type ?? item.id)));
    candidates.push(model?.active, model?.expires_at, model?.end_at);
    return candidates.some((value) => value === true || value === 1 || integer(value) > now);
  }

  function unitModelsForTown(townId) {
    const output = {};
    collection('Units').forEach((row) => {
      if (String(row.town_id ?? row.home_town_id ?? '') !== String(townId)) return;
      Object.entries(row).forEach(([name, value]) => {
        if (page.GameData?.units?.[name]) output[name] = integer(value);
      });
    });
    return output;
  }

  function movingMilitaryPopulation(townId) {
    return collection('MovementsUnits').reduce((sum, row) => {
      if (String(row.origin_town_id ?? row.home_town_id ?? '') !== String(townId)) return sum;
      return sum + bagPopulation(row.units ?? row.unit_counts ?? {}, page.GameData?.units || {});
    }, 0);
  }

  function profilePlayer(root) {
    const holder = root.closest?.('[data-player_id], [data-player-id]') || root;
    const link = root.querySelector('.gp_player_link, a[href*="player_id"], a[href*="player/"]');
    const href = link?.getAttribute('href') || '';
    const match = href.match(/(?:player_id[=\/]|player\/|[?&]id=)(\d+)/);
    const id = String(holder?.dataset?.playerId || root.dataset?.playerId || link?.dataset?.playerId
      || link?.getAttribute?.('data-playerid') || match?.[1] || '');
    const windowTitle = root.closest('.ui-dialog, .gpwindow')?.querySelector('.ui-dialog-title, .gpwindow_title')?.textContent
      || root.parentElement?.querySelector?.('.ui-dialog-title, .gpwindow_title')?.textContent || '';
    const titleName = String(windowTitle).match(/(?:Perfil do utilizador|Player profile)\s*-\s*(.+)$/i)?.[1];
    const name = String(root.querySelector('#player_info h3, .player_name, .player_name_link, .gp_player_link, h3')?.textContent
      || link?.textContent || titleName || '').trim();
    return { id, name };
  }

  function decodeTownLink(value) {
    const encoded = String(value || '').replace(/^#/, '');
    if (!encoded) return null;
    try {
      const json = typeof atob === 'function'
        ? decodeURIComponent([...atob(encoded)].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
        : Buffer.from(encoded, 'base64').toString('utf8');
      const data = JSON.parse(json);
      if (data?.tp !== 'town' || !integer(data.id)) return null;
      return { id: String(integer(data.id)), name: String(data.name || '') };
    } catch { return null; }
  }

  function targetTowns(root) {
    const result = new Map();
    root.querySelectorAll('.gp_town_link, [data-town_id], [data-town-id], [data-townid], a[href*="town_id"], a[href*="town/"]').forEach((node) => {
      const href = node.getAttribute?.('href') || '';
      const match = href.match(/(?:town_id[=\/]|town\/)(\d+)/);
      const onclickMatch = String(node.getAttribute?.('onclick') || '').match(/(?:town_id|id)\D{0,8}(\d+)/i);
      const decoded = decodeTownLink(href);
      const id = String(node.dataset?.townId || node.getAttribute?.('data-townid') || match?.[1]
        || onclickMatch?.[1] || decoded?.id || '');
      const name = String(node.dataset?.townName || node.textContent || decoded?.name || '').replace(/\s+/g, ' ').trim();
      if (id && name) result.set(id, { id, name });
    });
    return [...result.values()];
  }

  function looksLikeProfile(root) {
    if (!root?.querySelector) return false;
    const text = String(root.textContent || '');
    const playerMarker = root.querySelector('#player_info h3, .player_name, .player_name_link, .gp_player_link, [data-player_id], [data-player-id]');
    const townMarker = root.querySelector('.gp_town_link, [data-town_id], [data-town-id], [data-townid], a[href*="town_id"]');
    return Boolean(playerMarker) && Boolean(townMarker) && /Cidades|Towns/i.test(text);
  }

  function activeProfileRoot(root) {
    if (!looksLikeProfile(root)) return false;
    const dialog = root.closest?.('.ui-dialog, .js-window-main-container');
    if (!dialog) return true;
    if (dialog.classList.contains('minimized')) return false;
    const title = String(dialog.querySelector('.ui-dialog-title, .gpwindow_title')?.textContent || '');
    return /^(?:Perfil do utilizador|Player profile)\s*-/i.test(title.trim());
  }

  function profileRoots() {
    const roots = new Set();
    PROFILE_SELECTORS.forEach((selector) => document.querySelectorAll(selector).forEach((node) => roots.add(node)));
    document.querySelectorAll('.gpwindow_content').forEach((node) => { if (looksLikeProfile(node)) roots.add(node); });
    const matches = [...roots].filter(activeProfileRoot);
    return matches.filter((node) => !matches.some((parent) => parent !== node && parent.contains(node)));
  }

  function anchorFor(root) {
    return root.querySelector('#player_info, .player_info_content, .player_info_left, .left_side, .player_data, .player_info .left')
      || root.querySelector('.player_name, .player_name_link, .gp_player_link')?.closest('.player_info, .player_profile, .game_header, .left')
      || root.querySelector('.player_name, .player_name_link, .gp_player_link')?.parentElement
      || root;
  }

  function notify(message, success = false) {
    const api = page.HumanMessage;
    if (success && typeof api?.success === 'function') api.success(message);
    else if (typeof api?.error === 'function') api.error(message);
    else console[success ? 'info' : 'error'](`[Spam] ${message}`);
  }

  function ajaxPost(controller, action, data) {
    return new Promise((resolve, reject) => {
      const fn = page.gpAjax?.ajaxPost;
      if (typeof fn !== 'function') return reject(new Error('gpAjax.ajaxPost indisponível.'));
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Grepolis não confirmou em 15 segundos.')), 15000);
      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else if (response?.success === false || response?.json?.success === false || response?.error) {
          reject(new Error('Grepolis rejeitou o ataque.'));
        } else resolve(response);
      }
      try {
        const request = fn.call(page.gpAjax, controller, action, data, false, (response) => finish(null, response));
        if (request?.then) request.then((response) => finish(null, response), (error) => finish(error));
        else if (request?.fail) request.fail((error) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  function setButton(button) {
    const caption = button.querySelector('span');
    caption.textContent = state.running ? (state.stopRequested ? 'A parar…' : `Spam (${state.remaining})`) : 'Spam';
    button.classList.toggle('gps-active', state.running && !state.stopRequested);
  }

  function selectedOrigins(controls) {
    const towns = ownTowns();
    const selected = controls.querySelector('.gps-source')?.dataset.value || '';
    if (controls.querySelector('.gps-mode')?.value === 'group') {
      const group = groups().find((item) => item.id === selected);
      const ids = new Set(group?.townIds || []);
      return towns.filter((town) => ids.has(town.id));
    }
    return towns.filter((town) => town.id === selected);
  }

  function hydrateOrigins(origins) {
    return origins.map((town) => {
      const units = Object.keys(town.units || {}).length ? town.units : unitModelsForTown(town.id);
      const availablePopulation = bagPopulation(units, page.GameData?.units || {});
      return {
        ...town,
        units,
        militaryPopulation: availablePopulation + movingMilitaryPopulation(town.id)
      };
    });
  }

  function originInventorySignature(origins) {
    return origins.map((origin) => `${origin.id}:${Object.entries(origin.units || {})
      .filter(([, count]) => integer(count) > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}=${integer(count)}`).join(',')}`).sort().join('|');
  }

  function refreshOptions(controls) {
    const mode = controls.querySelector('.gps-mode');
    const source = controls.querySelector('.gps-source');
    const trigger = source.querySelector('.gps-source-trigger');
    const menu = source.querySelector('.gps-source-menu');
    const groupMode = mode.value === 'group';
    const rows = groupMode ? groups() : ownTowns();
    menu.innerHTML = '';
    rows.forEach((row, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'gps-source-option';
      option.dataset.value = row.id;
      option.textContent = row.name;
      if (index === 0) option.classList.add('gps-selected');
      option.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        source.dataset.value = row.id;
        trigger.textContent = row.name;
        menu.hidden = true;
        menu.querySelectorAll('.gps-selected').forEach((node) => node.classList.remove('gps-selected'));
        option.classList.add('gps-selected');
      });
      menu.append(option);
    });
    source.dataset.value = rows[0]?.id || '';
    trigger.textContent = rows[0]?.name || 'Sem opções';
    trigger.disabled = !rows.length;
    menu.hidden = true;
  }

  async function run(root, controls, button) {
    if (state.running) {
      state.stopRequested = true;
      setButton(button);
      return;
    }
    const player = profilePlayer(root);
    if (player.id && String(player.id) === String(page.Game?.player_id ?? page.Game?.playerId ?? '')) {
      notify('Perfil próprio bloqueado.');
      return;
    }
    const targets = targetTowns(root);
    if (!targets.length) { notify('Perfil sem cidades-alvo identificáveis.'); return; }
    const origins = hydrateOrigins(selectedOrigins(controls));
    if (!origins.length) { notify('Cidade ou grupo vazio.'); return; }
    const initialQueue = buildAttackQueue(origins, targets, page.GameData?.units || {});
    if (!initialQueue.length) { notify('Sem tropas transportáveis suficientes para mínimo anti-fake.'); return; }

    state.running = true;
    state.stopRequested = false;
    state.remaining = initialQueue.length;
    state.root = root;
    setButton(button);
    const failedOrigins = new Set();
    const selectedOriginIds = new Set(origins.map((origin) => origin.id));
    let sent = 0;
    let passOrigins = origins;
    let previousSignature = originInventorySignature(passOrigins);
    for (let pass = 0; pass < 3 && !state.stopRequested; pass += 1) {
      const queue = pass === 0
        ? initialQueue
        : buildAttackQueue(passOrigins, targets, page.GameData?.units || {});
      if (!queue.length) break;
      state.remaining = queue.length;
      setButton(button);
      for (const job of queue) {
        if (state.stopRequested || !document.documentElement.contains(root)) break;
        if (failedOrigins.has(job.originTownId)) { state.remaining -= 1; setButton(button); continue; }
        try {
          await ajaxPost('town_info', 'send_units', buildPayload(job));
          sent += 1;
          page.$?.Observer?.(page.GameEvents?.command?.send_unit)?.publish?.({
            sending_type: 'attack', target_id: job.target.id, params: buildPayload(job)
          });
        } catch (error) {
          failedOrigins.add(job.originTownId);
          notify(`${job.originTownName}: ${error.message || error}`);
        }
        state.remaining -= 1;
        setButton(button);
        if (!state.stopRequested) await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
      }
      if (state.stopRequested || pass === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
      passOrigins = hydrateOrigins(ownTowns().filter((town) => (
        selectedOriginIds.has(town.id) && !failedOrigins.has(town.id)
      )));
      const signature = originInventorySignature(passOrigins);
      if (!signature || signature === previousSignature) break;
      previousSignature = signature;
    }
    const stopped = state.stopRequested;
    state.running = false;
    state.stopRequested = false;
    state.remaining = 0;
    state.root = null;
    setButton(button);
    notify(stopped ? `${sent} ataques enviados antes de parar.` : `${sent} ataques enviados.`, true);
  }

  function installStyles() {
    if (document.getElementById('gps-styles')) return;
    const style = document.createElement('style');
    style.id = 'gps-styles';
    style.textContent = `
      .gps-controls{display:flex;align-items:center;gap:4px;width:208px;min-height:34px;margin:7px 8px;padding:2px 0;box-sizing:border-box}
      .ui-dialog.minimized .gps-controls{display:none!important}
      .gps-controls select,.gps-source-trigger{height:25px;min-width:0;border:1px solid #7b511f;background:#f2d79b;color:#35210d;font:11px Arial}
      .gps-mode{width:62px}.gps-source{position:relative;width:88px}.gps-source-trigger{width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:0 16px 0 5px}
      .gps-source-menu{position:absolute;z-index:1000;top:25px;left:0;width:150px;max-height:125px;overflow-y:auto;border:1px solid #6f481b;background:#f2d79b;box-shadow:0 2px 5px #231204}
      .gps-source-menu[hidden]{display:none}.gps-source-option{display:block;width:100%;height:25px;padding:2px 6px;border:0;border-bottom:1px solid #c49b5c;background:#f2d79b;color:#35210d;text-align:left;font:11px Arial;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gps-source-option:hover,.gps-source-option.gps-selected{background:#d8b56f}.gps-spam{width:54px;margin:0!important}
      .gps-spam .caption{padding:0 4px!important}.gps-active .caption{color:#ffe170!important;text-shadow:0 0 3px #b40000}
    `;
    document.head.append(style);
  }

  function mount(root) {
    if (root.querySelector(`.${CONTROL_CLASS}`)) return;
    const player = profilePlayer(root);
    if (!player.id && !player.name) return;
    const controls = document.createElement('div');
    controls.className = CONTROL_CLASS;
    controls.innerHTML = `
      <select class="gps-mode" aria-label="Origem"><option value="town">Cidade</option><option value="group">Grupo</option></select>
      <div class="gps-source" data-value=""><button type="button" class="gps-source-trigger" aria-label="Cidade ou grupo">Sem opções</button><div class="gps-source-menu" hidden></div></div>
      <div class="gps-spam button_new" role="button" tabindex="0" title="Grepolis Profile Spam v${VERSION}"><div class="left"></div><div class="right"></div><div class="caption js-caption"><span>Spam</span><div class="effect js-effect"></div></div></div>`;
    const mode = controls.querySelector('.gps-mode');
    const groupOption = mode.querySelector('[value="group"]');
    if (!administratorActive()) {
      groupOption.disabled = true;
      groupOption.title = 'Requer Administrador activo.';
      mode.title = 'Grupos requerem Administrador activo.';
    }
    mode.addEventListener('change', () => refreshOptions(controls));
    const source = controls.querySelector('.gps-source');
    const trigger = source.querySelector('.gps-source-trigger');
    const menu = source.querySelector('.gps-source-menu');
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    controls.addEventListener('pointerdown', (event) => event.stopPropagation());
    controls.addEventListener('mousedown', (event) => event.stopPropagation());
    controls.addEventListener('click', (event) => event.stopPropagation());
    const button = controls.querySelector('.gps-spam');
    button.addEventListener('click', () => run(root, controls, button));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') run(root, controls, button);
    });
    anchorFor(root).append(controls);
    refreshOptions(controls);
  }

  function scan() {
    installStyles();
    document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((controls) => {
      const root = controls.closest('.gpwindow_content');
      if (!root || !activeProfileRoot(root)) controls.remove();
    });
    profileRoots().forEach(mount);
    if (state.running && state.root && !document.documentElement.contains(state.root)) state.stopRequested = true;
  }

  if (typeof document !== 'undefined') {
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    scan();
  }

  const Core = {
    calculateMinimumPopulation,
    selectAttackableUnits,
    transportUsage,
    distributeUnits,
    buildTownBatches,
    roundRobinTargets,
    buildAttackQueue,
    buildPayload,
    decodeTownLink
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window !== 'undefined') window.GrepolisSpamCore = Core;
})();
