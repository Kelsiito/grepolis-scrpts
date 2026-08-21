'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Core = require('../grepolis-spam.user.js');

const DATA = {
  slinger: { population: 1 }, sword: { population: 1 }, rider: { population: 3 },
  big_transporter: { population: 7, capacity: 26, is_naval: true },
  bireme: { population: 8, is_naval: true },
  attack_ship: { population: 10, is_naval: true },
  colonize_ship: { population: 170, is_naval: true }, militia: { population: 0 }
};

test('mínimo oficial prevalece e fallback usa 3% da população militar', () => {
  assert.equal(Core.calculateMinimumPopulation({ slinger: 1000 }, DATA, 77, 1000), 77);
  assert.equal(Core.calculateMinimumPopulation({ slinger: 1000 }, DATA, 0, 2000), 60);
});

test('selecciona todas unidades atacáveis, exclui milícia/NC e limita terra ao transporte', () => {
  assert.deepEqual(Core.selectAttackableUnits({
    slinger: 100, sword: 20, big_transporter: 4, bireme: 7, colonize_ship: 1, militia: 99
  }, DATA), { big_transporter: 4, bireme: 7, slinger: 100, sword: 4 });
});

test('calcula capacidade de transporte', () => {
  assert.deepEqual(Core.transportUsage({ slinger: 52, big_transporter: 2 }, DATA), {
    required: 52, available: 52, valid: true
  });
  assert.equal(Core.transportUsage({ rider: 18, big_transporter: 2 }, DATA).valid, false);
});

test('cria ataques mínimos e conserva unidades seleccionadas', () => {
  const units = { slinger: 100, big_transporter: 4, attack_ship: 6 };
  const batches = Core.buildTownBatches(units, DATA, 30);
  assert.ok(batches.length > 1);
  batches.forEach((bag) => {
    assert.ok(Core.calculateMinimumPopulation(bag, DATA, Core.calculateMinimumPopulation(bag, DATA, 30)) >= 30);
    assert.equal(Core.transportUsage(bag, DATA).valid, true);
  });
  const totals = batches.reduce((all, bag) => {
    Object.entries(bag).forEach(([name, count]) => { all[name] = (all[name] || 0) + count; });
    return all;
  }, {});
  assert.deepEqual(totals, Core.selectAttackableUnits(units, DATA));
});

test('resto abaixo do mínimo é incorporado, nunca cria ataque inválido', () => {
  const batches = Core.buildTownBatches({ attack_ship: 10 }, DATA, 30);
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((sum, bag) => sum + bag.attack_ship, 0), 10);
});

test('round-robin maximiza alvos distintos antes de repetir', () => {
  assert.deepEqual(Core.roundRobinTargets(7, ['a', 'b', 'c']), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
});

test('descodifica links hash usados pelas cidades no perfil real', () => {
  assert.deepEqual(Core.decodeTownLink('#eyJpZCI6NTg5LCJpeCI6NDc0LCJpeSI6NDg5LCJ0cCI6InRvd24iLCJuYW1lIjoiQ0IwMSJ9'), {
    id: '589', name: 'CB01'
  });
  assert.equal(Core.decodeTownLink('#invalid'), null);
});

test('fila intercala origens e constrói payload nativo', () => {
  const queue = Core.buildAttackQueue([
    { id: 1, name: 'A', units: { attack_ship: 6 }, minimumPopulation: 20 },
    { id: 2, name: 'B', units: { attack_ship: 4 }, minimumPopulation: 20 }
  ], [{ id: 10, name: 'X' }, { id: 11, name: 'Y' }, { id: 12, name: 'Z' }], DATA);
  assert.deepEqual(queue.slice(0, 3).map((job) => job.target.id), [10, 11, 12]);
  assert.deepEqual(Core.buildPayload(queue[0]), {
    id: 10, town_id: 1, type: 'attack', nl_init: true, attack_ship: 2
  });
});

test('source contém montagem restrita, Administrador, paragem e falha parcial', () => {
  const source = fs.readFileSync(require.resolve('../grepolis-spam.user.js'), 'utf8');
  assert.match(source, /function looksLikeProfile\(/);
  assert.match(source, /MutationObserver\(scan\)/);
  assert.match(source, /administratorActive\(\)/);
  assert.match(source, /groupOption\.disabled = true/);
  assert.match(source, /state\.stopRequested = true/);
  assert.match(source, /failedOrigins\.add\(job\.originTownId\)/);
  assert.match(source, /ajaxPost\('town_info', 'send_units'/);
  assert.doesNotMatch(source, /sendButton\.click/);
  assert.match(source, /max-height:125px/);
  assert.match(source, /class="gps-source-trigger"/);
  assert.match(source, /class="gps-source-menu" hidden/);
  assert.match(source, /controls\.addEventListener\('pointerdown'/);
  assert.match(source, /\.ui-dialog\.minimized \.gps-controls\{display:none!important\}/);
  assert.match(source, /for \(let pass = 0; pass < 3/);
  assert.match(source, /signature === previousSignature/);
  assert.match(source, /function activeProfileRoot\(/);
  assert.match(source, /if \(!root \|\| !activeProfileRoot\(root\)\) controls\.remove\(\)/);
  assert.match(source, /attributeFilter: \['class', 'style'\]/);
});

test('réplica contém perfil, alvos e nenhum controlo global pré-criado', () => {
  const replica = fs.readFileSync(require.resolve('./spam-profile-replica.html'), 'utf8');
  assert.match(replica, /class="gpwindow_content"/);
  assert.match(replica, /id="player_info"/);
  assert.equal((replica.match(/class="gp_town_link"/g) || []).length, 3);
  assert.doesNotMatch(replica, /id="outside"[^>]*>[^<]*gps-controls/);
  assert.match(replica, /grepolis-spam\.user\.js/);
});
