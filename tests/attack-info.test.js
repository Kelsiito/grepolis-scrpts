'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = {};
global.document = undefined;

const Core = require('../grepolis-attack-info.user.js');

const BASE = 1_750_000_000_000;

test('normaliza ataque com hora nativa e mantém ataque próprio para cidade própria', () => {
  const movement = Core.normalizeMovement({
    command_id: 'own-nc',
    type: 'attack',
    home_town_id: '10',
    target_town_id: '20',
    started_at_ms: BASE,
    arrival_at_ms: BASE + 1_200_000,
    units: { colonize_ship: 1 }
  });

  assert.equal(movement.type, 'attack');
  assert.equal(movement.startedAt, BASE);
  assert.equal(movement.arrivalAt, BASE + 1_200_000);
  assert.equal(movement.returning, false);
  assert.equal(movement.explicitNc, 'colonize_ship');
  assert.equal(Core.isIncomingAttack(movement, new Set(['20']), BASE), true);
});

test('aceita o tipo abort apenas para o NC explícito usado no teste próprio', () => {
  const movement = Core.normalizeMovement({
    command_id: 'own-nc-abort',
    type: 'abort',
    home_town_id: '10',
    target_town_id: '20',
    started_at_ms: BASE,
    arrival_at_ms: BASE + 1_200_000,
    units: { colonize_ship: 1 }
  });

  assert.equal(movement.type, 'unknown');
  assert.equal(Core.isIncomingAttack(movement, new Set(['20']), BASE), true);
});

test('aceita aliases da Visão geral e identifica cidade própria pelo nome', () => {
  const movement = Core.normalizeMovement({
    type: 'attack',
    town_name_origin: 'Casterly Rock',
    town_name_destination: 'Kings Landing',
    arrival_at_ms: BASE + 60_000
  });

  assert.equal(movement.origin, 'Casterly Rock');
  assert.equal(movement.target, 'Kings Landing');
  assert.equal(Core.isIncomingAttack(
    movement,
    new Set(),
    BASE,
    new Set(['kings landing'])
  ), true);
});

test('captura hora própria pelo evento sem confundir target id com command id', () => {
  const record = Core.eventToSentRecord({
    sending_type: 'attack',
    params: {
      id: '20',
      town_id: '10',
      type: 'attack',
      colonize_ship: 1
    }
  }, BASE, { Game: { town_id: '10' } });

  assert.deepEqual(record, {
    id: '',
    type: 'attack',
    originTownId: '10',
    targetTownId: '20',
    sentAt: BASE,
    explicitNc: true,
    raw: {
      sending_type: 'attack',
      params: {
        id: '20',
        town_id: '10',
        type: 'attack',
        colonize_ship: 1
      },
      id: '20',
      town_id: '10',
      type: 'attack',
      colonize_ship: 1
    }
  });
});

test('usa registo guardado quando movimento próprio não expõe started_at', () => {
  const records = Core.rememberSentRecord([], {
    type: 'attack',
    originTownId: '10',
    targetTownId: '20',
    sentAt: BASE
  }, BASE);
  const movement = Core.normalizeMovement({
    command_id: 'movement-without-start',
    type: 'attack',
    home_town_id: '10',
    target_town_id: '20',
    arrival_at_ms: BASE + 1_200_000
  });

  const match = Core.findSentRecord(records, movement, BASE + 1_000);
  assert.equal(match.sentAt, BASE);
  assert.equal(Core.durationBetween(match.sentAt, movement.arrivalAt), 1_200_000);
});

test('deteção cega confirma NC por duração sem units', () => {
  const expected = Core.calculateNcDurations({
    distance: 10,
    unitSpeed: 1,
    colonySpeed: 3,
    profiles: [1],
    escortSpeeds: [3],
    meteorology: [1]
  });
  const movement = Core.normalizeMovement({
    type: 'attack',
    origin_town_id: '100',
    target_town_id: '200',
    started_at_ms: BASE,
    arrival_at_ms: BASE + expected[0]
  });
  const result = Core.classifyNcAttack(movement, {
    sentAt: movement.startedAt,
    expectedDurations: expected
  });

  assert.equal(movement.explicitNc, '');
  assert.equal(result.isNc, true);
  assert.equal(result.confidence, 'duration');
});

test('ataque normal sem duração NC compatível não recebe NC', () => {
  const expected = Core.calculateNcDurations({
    distance: 10,
    profiles: [1],
    escortSpeeds: [3],
    meteorology: [1]
  });
  const movement = Core.normalizeMovement({
    type: 'attack',
    started_at_ms: BASE,
    arrival_at_ms: BASE + expected[0] + 120_000
  });
  const result = Core.classifyNcAttack(movement, {
    sentAt: movement.startedAt,
    expectedDurations: expected
  });

  assert.equal(result.isNc, false);
  assert.equal(result.confidence, 'no-match');
});

test('sem hora de envio não inventa duração nem confirmação NC', () => {
  const movement = Core.normalizeMovement({
    type: 'attack',
    arrival_at_ms: BASE + 1_000_000
  });
  const result = Core.classifyNcAttack(movement, {
    expectedDurations: [1_000_000]
  });
  const display = Core.buildDisplayModel(movement, 0, result);

  assert.equal(result.confidence, 'impossible');
  assert.equal(display.durationText, 'indisponível');
  assert.equal(display.sentText, 'indisponível');
  assert.equal(display.ncText, 'NC: impossível confirmar');
});

test('perfis incluem Cartografia, Farol, Sereias, Atalanta e Set Sail', () => {
  const profiles = Core.buildSpeedProfiles();
  assert.ok(profiles.includes(1));
  assert.ok(profiles.includes(1.1));
  assert.ok(profiles.includes(2));
  assert.ok(profiles.includes(1.43));
  assert.ok(profiles.length > 100);
});

test('distância e escolta lenta alteram duração NC', () => {
  const fast = Core.calculateNcDurations({
    distance: 100,
    profiles: [1],
    escortSpeeds: [3],
    meteorology: [1]
  });
  const catapultEscort = Core.calculateNcDurations({
    distance: 100,
    profiles: [1],
    escortSpeeds: [2],
    meteorology: [1]
  });

  assert.ok(catapultEscort[0] > fast[0]);
});

test('overlay usa camada fixa e não executa ações do jogo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-attack-info.user.js'), 'utf8');
  assert.match(source, /position:fixed/);
  assert.match(source, /pointer-events:none/);
  assert.match(source, /GameEvents\?\.command\?\.send_unit/);
  assert.match(source, /#command_overview \.command/);
  assert.match(source, /#command_overview > li\.js-command-row/);
  assert.match(source, /replace\(\/\^command_\//);
  assert.match(source, /town_name_origin/);
  assert.match(source, /getCollections/);
  assert.match(source, /appendMovementModels/);
  assert.match(source, /Array\.isArray\(value\.models\)/);
  assert.match(source, /filter\(rowIsVisible\)/);
  assert.match(source, /getComputedStyle\(row\)/);
  assert.match(source, /\.gai-overlay\{position:absolute/);
  assert.match(source, /row\.appendChild\(node\)/);
  assert.doesNotMatch(source, /send_units/);
  assert.doesNotMatch(source, /cancel_command/);
  assert.doesNotMatch(source, /\.click\(/);
});
