'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../grepolis-auto-purification.user.js');

test('normaliza os nomes dos poderes em português e inglês', () => {
  assert.equal(Core.normalizeToken('Narcisismo'), 'narcisismo');
  assert.equal(Core.normalizeToken('Proteção da cidade'), 'protecao_da_cidade');
});

test('purifica apenas com Ártemis, favor suficiente e sem proteção', () => {
  const base = { narcissism: true, protectedCity: false, artemisTownId: '10', favor: 200, cost: 200 };
  assert.deepEqual(Core.purificationDecision(base), { allowed: true, reason: 'allowed' });
  assert.equal(Core.purificationDecision({ ...base, artemisTownId: '' }).reason, 'artemis-unavailable');
  assert.equal(Core.purificationDecision({ ...base, favor: 199 }).reason, 'insufficient-favor');
  assert.equal(Core.purificationDecision({ ...base, protectedCity: true }).reason, 'city-protected');
});

test('reads god from Grepolis Backbone models', () => {
  assert.equal(Core.godFromTownModel({ get: (key) => key === 'god' ? 'artemis' : undefined }), 'artemis');
  assert.equal(Core.godFromTownModel({ getGod: () => ({ attributes: { god_id: 'artemis' } }) }), 'artemis');
  assert.equal(Core.godFromTownModel({ god: () => 'artemis' }), 'artemis');
});

test('only finds a power actually present in the collection', () => {
  assert.equal(Core.powerFromCollections([{ power_id: 'narcissism', id: 42 }], ['narcissism']).id, 42);
  assert.equal(Core.powerFromCollections({ narcissism: { end_at: 123 } }, ['narcissism']).end_at, 123);
  assert.equal(Core.powerFromCollections([{ power_id: 'happiness' }], ['narcissism']), null);
  const shared = [{ power_id: 'narcissism', town_id: 14804, id: 629572 }];
  assert.equal(Core.powerFromCollections(shared, ['narcissism'], '14804').id, 629572);
  assert.equal(Core.powerFromCollections(shared, ['narcissism'], '2731'), null);
});

test('reads Artemis favor from numeric and Backbone formats', () => {
  assert.equal(Core.favorFromGods({ artemis: 500 }, 'artemis'), 500);
  assert.equal(Core.favorFromGods({ artemis: { get: (key) => key === 'favor' ? 321 : undefined } }, 'artemis'), 321);
  assert.equal(Core.favorFromGods({ get: (key) => key === 'artemis' ? 444 : undefined }, 'artemis'), 444);
  assert.equal(Core.favorFromGods({ attributes: { artemis_favor: 500 } }, 'artemis'), 500);
  assert.equal(Core.favorFromGods({ attributes: { production_overview: { artemis: { current: 499.5 } } } }, 'artemis'), 499.5);
  assert.equal(Core.favorFromGods('{"artemis":{"current":498}}', 'artemis'), 498);
});

test('userscript é isolado, silencioso e usa o contrato backend de Purificação', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'grepolis-auto-purification.user.js'), 'utf8');
  assert.match(source, /ajaxPost\('town_info', 'cast'/);
  assert.match(source, /power: 'cleanse'/);
  assert.match(source, /id: integer\(job\.targetTownId\)/);
  assert.match(source, /payload\?\.error/);
  assert.match(source, /cast-status-unknown-after-reload/);
  assert.doesNotMatch(source, /createElement|appendChild|window\.alert|\.click\(/);
});
