const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

global.window = {};
global.document = undefined;
global.unsafeWindow = {
  GameData: {
    units: {
      slinger: { population: 1 },
      hoplite: { population: 1 },
      rider: { population: 3 },
      chariot: { population: 4 },
      catapult: { population: 15 }
    }
  }
};

const Core = require('../grepolis-fakes.user.js');

test('calcula 3% da população militar com arredondamento superior', () => {
  const units = [
    { name: 'slinger', available: 1000, population: 1 },
    { name: 'catapult', available: 50, population: 15 }
  ];
  assert.equal(Core.calculateMinimumPopulation(units), 53);
  assert.equal(Core.calculateMinimumPopulation(units, 77), 77);
  assert.equal(Core.calculateMinimumPopulation(units, 0, 10_000), 300);
});

test('escolhe tropa ofensiva elegível com maior quantidade', () => {
  const selected = Core.chooseMainUnit([
    { name: 'sword', available: 5000 },
    { name: 'rider', available: 600 },
    { name: 'slinger', available: 900 },
    { name: 'catapult', available: 50 }
  ]);
  assert.equal(selected.name, 'slinger');
});

test('cria três fakes mínimos e um real com resto', () => {
  const batch = Core.buildAttackBatch({
    mainName: 'slinger',
    mainAvailable: 1000,
    mainPopulation: 1,
    offensiveUnits: [{ name: 'slinger', available: 1000 }],
    catapults: 50,
    minimumPopulation: 53,
    realPosition: 2
  });
  assert.deepEqual(batch, [
    { slinger: 38, catapult: 1 },
    { slinger: 38, catapult: 1 },
    { slinger: 886, catapult: 47 },
    { slinger: 38, catapult: 1 }
  ]);
});

test('respeita população da tropa principal', () => {
  const batch = Core.buildAttackBatch({
    mainName: 'rider',
    mainAvailable: 100,
    mainPopulation: 3,
    offensiveUnits: [
      { name: 'rider', available: 100 },
      { name: 'hoplite', available: 40 },
      { name: 'sword', available: 500 }
    ],
    catapults: 10,
    minimumPopulation: 31,
    realPosition: 0
  });
  assert.deepEqual(batch[1], { rider: 6, catapult: 1 });
  assert.deepEqual(batch[0], { rider: 82, hoplite: 40, catapult: 7 });
});

test('bloqueia catapultas ou tropas insuficientes', () => {
  assert.throws(() => Core.buildAttackBatch({
    mainName: 'slinger', mainAvailable: 100, mainPopulation: 1,
    catapults: 3, minimumPopulation: 30, realPosition: 0
  }), /pelo menos 4 catapultas/);
  assert.throws(() => Core.buildAttackBatch({
    mainName: 'slinger', mainAvailable: 30, mainPopulation: 1,
    catapults: 4, minimumPopulation: 30, realPosition: 0
  }), /Tropas insuficientes/);
});

test('posição real fica sempre entre zero e três', () => {
  assert.equal(Core.randomRealPosition(() => 0), 0);
  assert.equal(Core.randomRealPosition(() => 0.999999), 3);
});

test('executor usa endpoint nativo sequencial em vez de cliques repetidos', () => {
  const source = fs.readFileSync(require.resolve('../grepolis-fakes.user.js'), 'utf8');
  assert.match(source, /await sendNativeRequest\(wnd, payload\)/);
  assert.match(source, /ajaxRequestPost\([^,]+, 'send_units', payload/);
  assert.doesNotMatch(source, /sendButton\.dispatchEvent/);
  assert.match(source, /const realPosition = 2/);
  assert.match(source, /totalMilitaryPopulation\(originTownId\)/);
  assert.match(source, /mínimo oficial/);
  assert.match(source, /0\\\/4 enviados/);
});
