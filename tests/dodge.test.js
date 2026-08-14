'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../grepolis-dodge.user.js');

test('calcula cancelamento para regressar um segundo depois do impacto', () => {
  const sentAt = Date.parse('2026-08-10T13:29:45.000Z');
  const impactAt = Date.parse('2026-08-10T13:30:45.000Z');
  assert.equal(
    Core.calculateCancelAt(sentAt, impactAt, 1_000),
    Date.parse('2026-08-10T13:30:15.500Z')
  );
});

test('agrupa ondas por cidade e separa intervalos superiores a cinco minutos', () => {
  const groups = Core.groupAttackWaves([
    { id: 'a', targetTownId: '1', arrivalAt: 1_000_000 },
    { id: 'b', targetTownId: '1', arrivalAt: 1_299_000 },
    { id: 'c', targetTownId: '2', arrivalAt: 1_100_000 },
    { id: 'd', targetTownId: '1', arrivalAt: 1_600_000 }
  ], 300);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].commandIds, ['a', 'b']);
  assert.equal(groups[0].lastArrivalAt, 1_299_000);
});

test('normaliza ataques e reconhece regressos', () => {
  const attack = Core.normalizeMovement({ attributes: {
    command_id: 77,
    type: 'attack',
    home_town_id: 10,
    target_town_id: 20,
    arrival_at: 2_000
  } });
  assert.equal(attack.id, '77');
  assert.equal(attack.originTownId, '10');
  assert.equal(attack.targetTownId, '20');
  assert.equal(attack.arrivalAt, 2_000_000);
  assert.equal(Core.normalizeMovement({ type: 'support', direction: 'returning' }).returning, true);
  assert.equal(Core.normalizeMovement({
    type: 'attack', home_town_id: 5185, target_town_id: 5185
  }).returning, true);
  assert.equal(Core.normalizeMovement({
    type: 'attack', home_town_id: 5185, target_town_id: 5197
  }).returning, false);
});

test('lê o mapa público do mundo e descodifica nomes', () => {
  const towns = Core.parseWorldTowns('1,9,Cidade+Um,488,554,3,12000\n2,7,S%C3%A3o+Dois,488,554,8,9000\n');
  assert.equal(towns.length, 2);
  assert.equal(towns[0].name, 'Cidade Um');
  assert.equal(towns[1].name, 'São Dois');
  assert.equal(Core.sameIsland(towns[1], 488, 554), true);
});

test('ordena destinos da mesma ilha pela proximidade de slot', () => {
  const result = Core.sortDestinations([
    { id: '1', islandSlot: 5 },
    { id: '2', islandSlot: 9 },
    { id: '3', islandSlot: 6 }
  ], { id: '1', islandSlot: 5 });
  assert.deepEqual(result.map((town) => town.id), ['3', '2']);
});

test('seleciona todas as unidades apoiáveis e exclui milícia', () => {
  assert.deepEqual(Core.buildSupportUnits({ json: { units: {
    sword: { count: 120 }, bireme: { count: 9 }, militia: { count: 30 }, slinger: 0
  } } }), { sword: 120, bireme: 9 });
  assert.deepEqual(Core.buildSupportPayload('10', '20', { sword: 120 }), {
    id: 20, type: 'support', town_id: 10, nl_init: true, sword: 120
  });
});

test('mantém um único apoio quando os transportes têm capacidade suficiente', () => {
  const result = Core.planSupportCommands(
    { slinger: 50, small_transporter: 10, bireme: 5 },
    {
      slinger: { population: 1 },
      small_transporter: { is_naval: true, capacity: 10 },
      bireme: { is_naval: true, capacity: 0 }
    }
  );
  assert.equal(result.split, false);
  assert.equal(result.requiredCapacity, 50);
  assert.equal(result.availableCapacity, 100);
  assert.deepEqual(result.plans, [{
    kind: 'mixed', units: { slinger: 50, small_transporter: 10, bireme: 5 }
  }]);
});

test('usa a capacidade definitiva apresentada pelo servidor', () => {
  assert.deepEqual(
    Core.extractSupportCapacity({ html: '<div>Capacidade: <b>1627</b> / <b>2304</b></div>' }),
    { requiredCapacity: 1627, availableCapacity: 2304 }
  );
  const result = Core.planSupportCommands(
    { slinger: 388, catapult: 5, attack_ship: 11, bireme: 144 },
    {},
    { requiredCapacity: 1627, availableCapacity: 2304 }
  );
  assert.equal(result.split, false);
  assert.equal(result.requiredCapacity, 1627);
  assert.equal(result.availableCapacity, 2304);
});

test('exclui destinos protegidos por modo de férias', () => {
  assert.equal(Core.supportDestinationUnavailable({ json: { vacation_mode: true } }), true);
  assert.equal(Core.supportDestinationUnavailable({ json: { player_in_vacation: 1 } }), true);
  assert.equal(Core.supportDestinationUnavailable({ html: '<div>O jogador está em modo de férias.</div>' }), true);
  assert.equal(Core.supportDestinationUnavailable({ json: { vacation_mode: false, success: true } }), false);
  assert.equal(Core.supportDestinationUnavailable({ json: { success: true } }), false);
});

test('divide tropas terrestres e frota quando a capacidade é insuficiente', () => {
  const result = Core.planSupportCommands(
    { slinger: 150, small_transporter: 10, bireme: 5 },
    {
      slinger: { population: 1 },
      small_transporter: { is_naval: true, capacity: 10 },
      bireme: { is_naval: true, capacity: 0 }
    }
  );
  assert.equal(result.split, true);
  assert.equal(result.requiredCapacity, 150);
  assert.equal(result.availableCapacity, 100);
  assert.deepEqual(result.plans, [
    { kind: 'land', units: { slinger: 150 } },
    { kind: 'naval', units: { small_transporter: 10, bireme: 5 } }
  ]);
});

test('valida janela de cancelamento e duração da viagem', () => {
  const base = { sentAt: 1_000_000, cancelAt: 1_030_000, outboundArrivalAt: 1_100_000 };
  assert.equal(Core.cancellationFeasibility(base).allowed, true);
  assert.equal(Core.cancellationFeasibility({ ...base, outboundArrivalAt: 1_034_000 }).reason, 'travel-too-short');
  assert.equal(Core.cancellationFeasibility({ ...base, cancelAt: 1_599_000 }).reason, 'cancel-window');
});

test('extrai duração de viagem da resposta Grepolis', () => {
  assert.equal(Core.extractTravelDurationMs({ json: { travel_duration: 125 } }), 125_000);
  assert.equal(Core.parseDurationMs('01:02:03'), 3_723_000);
});

test('o userscript é silencioso e usa apenas apoio e cancelamento', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /ajaxGet\('town_info', 'support'/);
  assert.match(source, /ajaxPost\('town_info', 'send_units'/);
  assert.match(source, /ajaxPost\('command_info', 'cancel_command'/);
  assert.doesNotMatch(source, /createElement|appendChild|HumanMessage|window\.alert|\.click\(/);
  assert.doesNotMatch(source, /type:\s*'attack'/);
});

test('a execução espera pelas APIs internas antes de recuperar movimentos', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /if \(!await waitForBindings\(\)\)/);
  assert.match(source, /candidate\.targetTownId === wave\.targetTownId/);
  assert.match(source, /wave\.firstArrivalAt <= candidate\.lastArrivalAt/);
});

test('um timeout de envio é reconciliado pelos movimentos antes de bloquear', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /let sendError = null;/);
  assert.match(source, /movement = await waitForCreatedSupport/);
  assert.match(source, /error: 'send-unconfirmed'/);
});

test('a duração da pré-validação não pode consumir a margem mínima', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /error: 'lead-expired-during-preview'/);
  assert.match(source, /if \(data\.type && data\.type !== 'support'\) continue;/);
});

test('preserva precisão em milissegundos nas chegadas', () => {
  const precise = Core.normalizeMovement({
    type: 'attack', arrival_at_ms: 1_725_000_045_300, started_at: 1_725_000_000
  });
  const rounded = Core.normalizeMovement({
    type: 'attack', arrival_at: 1_725_000_045, started_at: 1_725_000_000
  });
  assert.equal(precise.arrivalHasMilliseconds, true);
  assert.equal(rounded.arrivalHasMilliseconds, false);
  assert.equal(Core.timestampHasMilliseconds(1_725_000_045_000), true);
  assert.equal(Core.timestampHasMilliseconds(1_725_000_045), false);
});

test('identifica NC explícito independentemente do contexto de revolta', () => {
  const movement = Core.normalizeMovement({
    type: 'attack_takeover', command_id: 1, arrival_at: 2_000, started_at: 1_000,
    units: { colonize_ship: 1 }
  });
  assert.deepEqual(Core.classifyNcAttack(movement), {
    isNc: true, confidence: 'explicit', deltaMs: 0
  });
});

test('infere NC por duração mesmo sem revolta ativa', () => {
  const movement = Core.normalizeMovement({
    type: 'attack', arrival_at: 2_000, started_at: 1_000
  });
  assert.equal(Core.classifyNcAttack(movement, {
    expectedDurations: [1_006_000], revoltActive: true, toleranceMs: 10_000
  }).confidence, 'high');
  assert.equal(Core.classifyNcAttack(movement, {
    expectedDurations: [1_006_000], revoltActive: false, toleranceMs: 10_000
  }).confidence, 'timing-match');
});

test('calcula perfis de duração de NC para os bónus de velocidade', () => {
  const durations = Core.calculateNcDurations({
    distance: 100, unitSpeed: 2, colonySpeed: 3, modifiers: [1, 1.1, 1.15]
  });
  assert.equal(durations.length, 3);
  assert.ok(durations.every((duration) => duration > 0));
  assert.ok(durations[0] > durations[2]);
});

test('combina pesquisas, aceleração temporária e todas as quantidades de Sereias', () => {
  const modifiers = Core.buildNcSpeedModifiers();
  assert.ok(modifiers.includes(1));
  assert.ok(modifiers.includes(1.3));
  assert.ok(modifiers.includes(2)); // cinquenta Sereias sem outros bónus
  assert.ok(modifiers.includes(1.43)); // Cartografia e movimento melhorado
  assert.ok(modifiers.includes(2.86)); // combinação anterior com cinquenta Sereias
  assert.ok(modifiers.length > 100);
});

test('usa menos cem milissegundos apenas quando a precisão é suficiente', () => {
  assert.equal(Core.chooseReturnOffset({ nc: true, hasMilliseconds: true, uncertaintyMs: 50 }), -100);
  assert.equal(Core.chooseReturnOffset({ nc: true, hasMilliseconds: true, uncertaintyMs: 100 }), -1_000);
  assert.equal(Core.chooseReturnOffset({ nc: true, hasMilliseconds: false, uncertaintyMs: 10 }), -1_000);
  assert.equal(Core.chooseReturnOffset({ nc: false }), 1_000);
});

test('uma onda conserva o primeiro NC identificado como referência', () => {
  const groups = Core.groupAttackWaves([
    { id: 'clean', targetTownId: '1', arrivalAt: 1_000_000 },
    { id: 'nc', targetTownId: '1', arrivalAt: 1_010_300, nc: { isNc: true, confidence: 'high' } },
    { id: 'later', targetTownId: '1', arrivalAt: 1_020_000 }
  ], 300);
  assert.equal(groups[0].ncArrivalAt, 1_010_300);
  assert.equal(groups[0].ncConfidence, 'high');
});

test('auto-milícia usa leitura da quinta, ação descoberta e confirmação', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /ajaxPost\('building_farm', action/);
  assert.match(source, /function townMilitiaActive/);
  assert.match(source, /job\.activeUntil = job\.activatedAt \+ CONFIG\.militiaActiveMs/);
  assert.match(source, /job\.stage = 'blocked'/);
  assert.match(source, /reconcileMilitia\(rawAttacks\);[\s\S]*classifyAttacks\(rawAttacks\)/);
});

test('o snipe e o dodge partilham uma única máquina de estados por cidade', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /tactic: wave\.ncArrivalAt \? 'nc-snipe' : 'dodge'/);
  assert.match(source, /candidate\.targetTownId === wave\.targetTownId/);
  assert.match(source, /const referenceArrivalAt = wave\.ncArrivalAt \|\| wave\.lastArrivalAt/);
  assert.match(source, /referenceAttack\?\.arrivalHasMilliseconds\) && serverClockHasMilliseconds\(\)/);
});

test('reconhece Narcisismo e Protecao independentemente do idioma', () => {
  assert.equal(Core.isNarcissismPower('narcissism'), true);
  assert.equal(Core.isNarcissismPower('Narcisismo'), true);
  assert.equal(Core.isCityProtectionPower('town_protection'), true);
  assert.equal(Core.isCityProtectionPower('Protecao'), true);
});

test('purifica apenas com Artemis, favor suficiente e sem protecao', () => {
  const base = { narcissism: true, artemisTownId: '10', favor: 200, cost: 200 };
  assert.deepEqual(Core.purificationDecision(base), { allowed: true, reason: 'allowed' });
  assert.equal(Core.purificationDecision({ ...base, favor: 199 }).reason, 'insufficient-favor');
  assert.equal(Core.purificationDecision({ ...base, artemisTownId: '' }).reason, 'artemis-unavailable');
  assert.equal(Core.purificationDecision({ ...base, protectedCity: true }).reason, 'city-protected');
  assert.equal(Core.purificationDecision({ ...base, favor: Number.NaN }).reason, 'favor-unknown');
  assert.equal(Core.purificationDecision({ ...base, handled: true }).reason, 'already-handled');
});

test('auto-purificacao usa o contrato de poderes e nao repete resposta ambigua', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /ajaxPost\('powers', 'cast'/);
  assert.match(source, /power_id: 'cleanse'/);
  assert.match(source, /target_type: 'town'/);
  assert.match(source, /cast-status-unknown-after-reload/);
  assert.match(source, /if \(handled\) continue;/);
});

test('aceita ataques próprios dirigidos a uma cidade própria para testes reais', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /ownIds\.has\(movement\.targetTownId\)/);
  assert.doesNotMatch(source, /!ownIds\.has\(movement\.originTownId\)/);
  assert.doesNotMatch(source, /movement\.playerId !== playerId/);
});

test('não duplica o arredondamento do instante de partida no regresso', () => {
  const estimate = 1_725_000_000_750;
  const rounded = Core.normalizeMovement({ started_at: 1_725_000_000 });
  const precise = Core.normalizeMovement({ started_at: 1_725_000_000_420 });
  assert.equal(rounded.startedHasMilliseconds, false);
  assert.equal(Core.chooseSentAt(rounded, estimate), estimate);
  assert.equal(precise.startedHasMilliseconds, true);
  assert.equal(Core.chooseSentAt(precise, estimate), 1_725_000_000_420);
});

test('regista diagnóstico temporal e classificação sem abrir interface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-dodge.user.js'), 'utf8');
  assert.match(source, /diagnostic = JSON\.stringify\(details\)/);
  assert.match(source, /tactic: job\.tactic/);
  assert.match(source, /movementStartedHasMilliseconds: movement\.startedHasMilliseconds/);
  assert.match(source, /attackArrivalIso: new Date\(referenceArrivalAt\)\.toISOString\(\)/);
});

test('interpola milissegundos entre mudanças do segundo do servidor', () => {
  const first = Core.calibratedServerTime(1_725_000_000, 10_000, {});
  const middle = Core.calibratedServerTime(1_725_000_000, 10_475, first.state);
  const tick = Core.calibratedServerTime(1_725_000_001, 11_015, middle.state);
  assert.equal(first.now, 1_725_000_000_000);
  assert.equal(middle.now, 1_725_000_000_475);
  assert.equal(tick.now, 1_725_000_001_000);
  assert.equal(Core.calibratedServerTime(1_725_000_001_250, 11_265, tick.state).now, 1_725_000_001_250);
});
