'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../grepolis-assistant.user.js');

test('normaliza um ataque dos modelos Backbone', () => {
  const command = Core.normalizeCommand({
    id: 'abc',
    attributes: {
      command_type: 'attack',
      arrival_at: 2_000,
      origin_town_name: 'Inimiga',
      target_town_name: 'Castle Black',
      target_town_id: 123
    }
  }, 1_000_000);

  assert.equal(command.id, 'abc');
  assert.equal(command.type, 'attack');
  assert.equal(command.arrivalAt, 2_000_000);
  assert.equal(command.origin, 'Inimiga');
  assert.equal(command.target, 'Castle Black');
  assert.equal(command.targetTownId, '123');
});

test('normaliza os campos reais de MovementsUnits', () => {
  const command = Core.normalizeCommand({
    attributes: {
      command_id: 987,
      type: 'attack_spy',
      arrival_at: 2_000,
      home_town_id: 11,
      home_town_name: 'Origem oculta',
      target_town_id: 22,
      target_town_name: 'Braavos'
    }
  }, 1_000_000);

  assert.equal(command.id, '987');
  assert.equal(command.type, 'spy');
  assert.equal(command.originTownId, '11');
  assert.equal(command.targetTownId, '22');
});

test('normaliza os nomes reais de origem e destino usados pelo mundo pt123', () => {
  const command = Core.normalizeCommand({
    attributes: {
      command_id: 988,
      type: 'support',
      arrival_at: 2_000,
      town_name_origin: 'Cidade de Anks',
      town_name_destination: 'Harrenhal',
      target_town_id: 7,
      player_id: 777,
      link_origin: '<a>Cidade de Anks (peli7)</a>'
    }
  }, 1_000_000);

  assert.equal(command.origin, 'Cidade de Anks');
  assert.equal(command.target, 'Harrenhal');
  assert.equal(command.playerName, 'peli7');
  assert.equal(Core.formatCommandOrigin(command), 'Cidade de Anks (peli7)');
});

test('normaliza o jogador associado ao movimento', () => {
  const command = Core.normalizeCommand({
    attributes: {
      type: 'attack',
      arrival_at: 2_000,
      player_id: 531,
      home_town_id: 10,
      target_town_id: 22
    }
  }, 1_000_000);

  assert.equal(command.playerId, '531');
});

test('não repete o jogador quando coincide com o nome da origem', () => {
  assert.equal(Core.formatCommandOrigin({
    origin: 'peli7',
    playerName: 'peli7'
  }), 'peli7');
});

test('reconhece espionagem em português e inglês', () => {
  assert.equal(Core.canonicalType('Espionagem inimiga'), 'spy');
  assert.equal(Core.canonicalType('incoming spy'), 'spy');
  assert.equal(Core.canonicalType('support'), 'support');
});

test('calcula risco pela proximidade e tipo', () => {
  const urgentAttack = Core.assessThreat({
    type: 'attack',
    arrivalAt: 1_060_000
  }, 1_000_000, { warningSeconds: 300 });
  const distantSpy = Core.assessThreat({
    type: 'spy',
    arrivalAt: 4_600_000
  }, 1_000_000, { warningSeconds: 300 });

  assert.equal(urgentAttack.level, 'critical');
  assert.equal(distantSpy.level, 'medium');
  assert.ok(urgentAttack.score > distantSpy.score);
});

test('recomenda depósito respeitando reserva e objetivo', () => {
  assert.equal(Core.calculateCaveDeposit({
    availableSilver: 30_000,
    storedSilver: 10_000,
    reserve: 5_000,
    target: 25_000
  }), 15_000);

  assert.equal(Core.calculateCaveDeposit({
    availableSilver: 4_000,
    storedSilver: 0,
    reserve: 5_000,
    target: 25_000
  }), 0);
});

test('calcula o instante de desvio antes do impacto', () => {
  assert.equal(Core.calculateDodgeAt(2_000_000, 90), 1_910_000);
});

test('lê durações de viagem nos formatos do jogo', () => {
  assert.equal(Core.parseDurationSeconds('Duração: 01:02:03'), 3_723);
  assert.equal(Core.parseDurationSeconds('00:45'), 45);
  assert.equal(Core.parseDurationSeconds('1h 2min 3s'), 3_723);
  assert.equal(Core.parseDurationSeconds('sem duração'), null);
});

test('calcula a sorte mínima necessária para equilibrar forças', () => {
  const result = Core.calculateLuckScenario({
    attackStrength: 100_000,
    defenseStrength: 110_000,
    morale: 100,
    selectedLuck: 10
  });

  assert.ok(Math.abs(result.requiredLuck - 10) < 0.0001);
  assert.equal(result.status, 'possible');
  assert.equal(result.favorable, true);
  assert.ok(Math.abs(result.ratio - 1) < 0.0001);
});

test('classifica ataques garantidos e impossíveis dentro da faixa de sorte', () => {
  assert.equal(Core.calculateLuckScenario({
    attackStrength: 150_000,
    defenseStrength: 100_000
  }).status, 'guaranteed');

  assert.equal(Core.calculateLuckScenario({
    attackStrength: 70_000,
    defenseStrength: 100_000
  }).status, 'impossible');
});

test('aplica moral e bónus antes da variação de sorte', () => {
  const result = Core.calculateLuckScenario({
    attackStrength: 100_000,
    defenseStrength: 100_000,
    morale: 80,
    attackBonus: 25,
    defenseBonus: 10,
    selectedLuck: 10
  });

  assert.equal(result.attackBeforeLuck, 100_000);
  assert.ok(Math.abs(result.effectiveAttack - 110_000) < 0.0001);
  assert.ok(Math.abs(result.effectiveDefense - 110_000) < 0.0001);
  assert.ok(Math.abs(result.requiredLuck - 10) < 0.0001);
});

test('limita a sorte escolhida ao intervalo de menos trinta a mais trinta', () => {
  assert.equal(Core.calculateLuckScenario({
    attackStrength: 100,
    defenseStrength: 100,
    selectedLuck: 90
  }).selectedLuck, 30);
  assert.equal(Core.calculateLuckScenario({
    attackStrength: 100,
    defenseStrength: 100,
    selectedLuck: -90
  }).selectedLuck, -30);
});

test('ativa a preparação automática da gruta dentro da janela de espionagem', () => {
  assert.deepEqual(Core.automationDecision({
    type: 'spy',
    arrivalAt: 1_250_000
  }, 1_000_000, {
    autoPrepareCave: true,
    warningSeconds: 300
  }), {
    action: 'cave',
    due: true,
    reason: 'waiting'
  });

  assert.equal(Core.automationDecision({
    type: 'spy',
    arrivalAt: 1_400_000
  }, 1_000_000, {
    autoPrepareCave: true,
    warningSeconds: 300
  }).due, false);
});

test('ativa a preparação automática do desvio apenas no instante definido', () => {
  const command = { type: 'attack', arrivalAt: 2_000_000 };
  const settings = { autoPrepareDodge: true, dodgeLeadSeconds: 90 };

  assert.equal(Core.automationDecision(command, 1_909_000, settings).due, false);
  assert.equal(Core.automationDecision(command, 1_910_000, settings).due, true);
  assert.equal(Core.automationDecision(command, 2_000_001, settings).reason, 'expired');
});

test('respeita a desativação individual das regras automáticas', () => {
  assert.equal(Core.automationDecision({
    type: 'spy',
    arrivalAt: 1_100_000
  }, 1_000_000, {
    autoPrepareCave: false,
    warningSeconds: 300
  }).due, false);
  assert.equal(Core.automationDecision({
    type: 'attack',
    arrivalAt: 1_100_000
  }, 1_000_000, {
    autoPrepareDodge: false,
    dodgeLeadSeconds: 90
  }).due, false);
});

test('resolve políticas por cidade com herança das regras globais', () => {
  const settings = {
    autoPrepareCave: true,
    autoPrepareDodge: false,
    dodgeTargetTownId: '8',
    warningSeconds: 300,
    dodgeLeadSeconds: 90,
    townPolicies: {}
  };

  assert.deepEqual(Core.resolveTownPolicy('2', settings), {
    caveEnabled: true,
    dodgeEnabled: false,
    safeTownId: '8',
    fallbackSafeTownId: '',
    priority: 'normal',
    canReceiveDodge: true,
    warningSeconds: 300,
    dodgeLeadSeconds: 90
  });
});

test('aplica exceções defensivas apenas à cidade configurada', () => {
  const settings = {
    autoPrepareCave: true,
    autoPrepareDodge: true,
    dodgeTargetTownId: '8',
    warningSeconds: 300,
    dodgeLeadSeconds: 90,
    townPolicies: {
      2: {
        caveEnabled: false,
        dodgeEnabled: true,
        safeTownId: '11',
        dodgeLeadSeconds: 120
      }
    }
  };

  assert.deepEqual(Core.resolveTownPolicy('2', settings), {
    caveEnabled: false,
    dodgeEnabled: true,
    safeTownId: '11',
    fallbackSafeTownId: '',
    priority: 'normal',
    canReceiveDodge: true,
    warningSeconds: 300,
    dodgeLeadSeconds: 120
  });
  assert.equal(Core.resolveTownPolicy('4', settings).safeTownId, '8');
});

test('a decisão automática usa a política da cidade ameaçada', () => {
  const settings = {
    autoPrepareCave: true,
    autoPrepareDodge: true,
    warningSeconds: 300,
    dodgeLeadSeconds: 90,
    townPolicies: {
      4: { caveEnabled: false }
    }
  };
  const decision = Core.policyDecision({
    type: 'spy',
    targetTownId: '4',
    arrivalAt: 1_100_000
  }, 1_000_000, settings);

  assert.equal(decision.action, 'cave');
  assert.equal(decision.due, false);
  assert.equal(decision.reason, 'disabled');
  assert.equal(decision.policy.caveEnabled, false);
});

test('agrupa ataques próximos à mesma cidade numa única onda operacional', () => {
  const incidents = Core.groupThreats([
    {
      id: 'a1',
      type: 'attack',
      origin: 'Origem A',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_100_000
    },
    {
      id: 'a2',
      type: 'attack',
      origin: 'Origem B',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_220_000
    }
  ], 300);

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].count, 2);
  assert.equal(incidents[0].origins.length, 2);
  assert.equal(incidents[0].arrivalAt, 1_100_000);
  assert.equal(incidents[0].lastArrivalAt, 1_220_000);
});

test('separa ataques distantes e tipos diferentes', () => {
  const incidents = Core.groupThreats([
    {
      id: 'a1',
      type: 'attack',
      origin: 'Origem',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_100_000
    },
    {
      id: 's1',
      type: 'spy',
      origin: 'Origem',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_120_000
    },
    {
      id: 'a2',
      type: 'attack',
      origin: 'Origem',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_500_001
    }
  ], 300);

  assert.equal(incidents.length, 3);
});

test('não mistura ondas dirigidas a cidades diferentes', () => {
  const incidents = Core.groupThreats([
    {
      id: 'a1',
      type: 'attack',
      origin: 'Origem',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_100_000
    },
    {
      id: 'a2',
      type: 'attack',
      origin: 'Origem',
      target: 'Castle Black',
      targetTownId: '4',
      arrivalAt: 1_110_000
    }
  ], 300);

  assert.equal(incidents.length, 2);
});

test('consolida incidentes separados numa única reação por cidade', () => {
  const reactions = Core.groupReactions([
    {
      id: 'a1',
      type: 'attack',
      origin: 'Origem A',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 1_100_000
    },
    {
      id: 'a2',
      type: 'attack',
      origin: 'Origem B',
      target: 'Braavos',
      targetTownId: '2',
      arrivalAt: 9_100_000
    }
  ]);

  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].count, 2);
  assert.equal(reactions[0].arrivalAt, 1_100_000);
  assert.equal(reactions[0].lastArrivalAt, 9_100_000);
});

test('escolhe a cidade segura principal quando está disponível', () => {
  assert.deepEqual(Core.selectSafeDestination({
    threatenedTownId: '2',
    preferredTownId: '8',
    fallbackTownIds: ['11'],
    availableTowns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' },
      { id: '11', name: 'Meereen' }
    ]
  }), {
    townId: '8',
    usedFallback: false,
    reason: 'preferred'
  });
});

test('usa uma alternativa quando a cidade principal está ameaçada ou bloqueada', () => {
  assert.deepEqual(Core.selectSafeDestination({
    threatenedTownId: '2',
    preferredTownId: '8',
    fallbackTownIds: ['11'],
    availableTowns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' },
      { id: '11', name: 'Meereen' }
    ],
    threatenedTownIds: ['8']
  }), {
    townId: '11',
    usedFallback: true,
    reason: 'fallback'
  });
});

test('não escolhe destinos bloqueados nem a própria cidade ameaçada', () => {
  assert.equal(Core.selectSafeDestination({
    threatenedTownId: '2',
    preferredTownId: '2',
    fallbackTownIds: ['8'],
    availableTowns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    blockedTownIds: ['8'],
    allowAnyFallback: false
  }).townId, '');
});

test('seleção automática escolhe outra cidade elegível por ordem estável', () => {
  assert.equal(Core.selectSafeDestination({
    threatenedTownId: '2',
    preferredTownId: '8',
    availableTowns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' },
      { id: '11', name: 'Meereen' },
      { id: '1', name: 'Barad-dûr' }
    ],
    blockedTownIds: ['8']
  }).townId, '1');
});

test('prioridade alta antecipa reações com chegadas quase simultâneas', () => {
  const candidates = [
    {
      command: { arrivalAt: 1_000_000 },
      decision: { policy: { priority: 'normal' } }
    },
    {
      command: { arrivalAt: 1_010_000 },
      decision: { policy: { priority: 'high' } }
    }
  ].sort(Core.compareReactionCandidates);

  assert.equal(candidates[0].decision.policy.priority, 'high');
});

test('o contador de falhas abre o disjuntor no limite configurado', () => {
  assert.deepEqual(Core.nextAutomationFailureState(false, 1, 3), {
    consecutiveFailures: 2,
    breakerOpen: false
  });
  assert.deepEqual(Core.nextAutomationFailureState(false, 2, 3), {
    consecutiveFailures: 3,
    breakerOpen: true
  });
  assert.deepEqual(Core.nextAutomationFailureState(true, 2, 3), {
    consecutiveFailures: 0,
    breakerOpen: false
  });
});

test('diagnostica leitura atrasada e proteção ativada', () => {
  assert.equal(Core.automationHealth({
    enabled: true,
    armedUntil: 2_000_000,
    busy: false,
    breakerOpen: false,
    consecutiveFailures: 0,
    lastScanAt: 900_000
  }, 1_000_000, 20).status, 'warning');

  assert.equal(Core.automationHealth({
    enabled: true,
    armedUntil: 2_000_000,
    busy: false,
    breakerOpen: true,
    consecutiveFailures: 3,
    lastScanAt: 999_000
  }, 1_000_000, 20).status, 'blocked');
});

test('diagnostica automação saudável, armada e ocupada', () => {
  assert.equal(Core.automationHealth({
    enabled: true,
    armedUntil: 2_000_000,
    busy: false,
    breakerOpen: false,
    consecutiveFailures: 0,
    lastScanAt: 999_000
  }, 1_000_000, 20).status, 'armed');

  assert.equal(Core.automationHealth({
    enabled: true,
    armedUntil: 2_000_000,
    busy: true,
    breakerOpen: false,
    consecutiveFailures: 0,
    lastScanAt: 999_000
  }, 1_000_000, 20).status, 'busy');
});

test('pré-verificação aprova uma configuração defensiva completa', () => {
  const result = Core.analyzePreflight({
    towns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    settings: {
      ...Core.DEFAULTS,
      simulation: false,
      dodgeTargetTownId: '8',
      autoSelectFallback: true,
      townPolicies: {
        8: { safeTownId: '2' }
      }
    },
    capabilities: {
      layoutTownSwitch: true,
      mapJump: true,
      caveBuilding: true,
      caveInput: false
    },
    reactions: []
  });

  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.score, 100);
});

test('pré-verificação bloqueia APIs ausentes e limites inseguros', () => {
  const result = Core.analyzePreflight({
    towns: [{ id: '2', name: 'Braavos' }],
    settings: {
      ...Core.DEFAULTS,
      scanInterval: 5_000,
      watchdogStaleSeconds: 5,
      automationFailureLimit: 0
    },
    capabilities: {
      layoutTownSwitch: false,
      mapJump: false,
      caveBuilding: false,
      caveInput: false
    }
  });

  assert.equal(result.passed, false);
  assert.ok(result.errors.some((issue) => issue.code === 'town-switch-missing'));
  assert.ok(result.errors.some((issue) => issue.code === 'watchdog-too-short'));
  assert.ok(result.errors.some((issue) => issue.code === 'failure-limit-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'insufficient-towns'));
});

test('pré-verificação deteta políticas órfãs e destinos inexistentes', () => {
  const result = Core.analyzePreflight({
    towns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    settings: {
      ...Core.DEFAULTS,
      dodgeTargetTownId: '8',
      townPolicies: {
        999: { safeTownId: '777' }
      }
    },
    capabilities: {
      layoutTownSwitch: true,
      mapJump: true,
      caveBuilding: true,
      caveInput: false
    }
  });

  assert.equal(result.passed, true);
  assert.ok(result.warnings.some((issue) => issue.code === 'orphan-policy:999'));
  assert.ok(result.warnings.some((issue) => (
    issue.code === 'missing-policy-destination:999:safeTownId'
  )));
});

test('pré-verificação bloqueia cidade sem qualquer destino seguro', () => {
  const result = Core.analyzePreflight({
    towns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    settings: {
      ...Core.DEFAULTS,
      dodgeTargetTownId: '8',
      autoSelectFallback: false,
      townPolicies: {
        8: { canReceiveDodge: false }
      }
    },
    capabilities: {
      layoutTownSwitch: true,
      mapJump: true,
      caveBuilding: true,
      caveInput: false
    }
  });

  assert.equal(result.passed, false);
  assert.ok(result.errors.some((issue) => issue.code === 'no-safe-destination:2'));
});

test('execução da gruta exige opção ativa, armamento e limites', () => {
  assert.equal(Core.caveExecutionDecision({
    enabled: false,
    armed: true,
    amount: 1_000,
    maxPerDeposit: 5_000,
    sessionBudget: 10_000
  }).reason, 'disabled');
  assert.equal(Core.caveExecutionDecision({
    enabled: true,
    armed: false,
    amount: 1_000,
    maxPerDeposit: 5_000,
    sessionBudget: 10_000
  }).reason, 'not-armed');
  assert.equal(Core.caveExecutionDecision({
    enabled: true,
    armed: true,
    amount: 6_000,
    maxPerDeposit: 5_000,
    sessionBudget: 10_000
  }).reason, 'deposit-limit');
});

test('execução da gruta respeita o orçamento acumulado', () => {
  assert.deepEqual(Core.caveExecutionDecision({
    enabled: true,
    armed: true,
    amount: 2_000,
    maxPerDeposit: 5_000,
    spentInSession: 7_000,
    sessionBudget: 10_000
  }), {
    allowed: true,
    reason: 'allowed'
  });
  assert.equal(Core.caveExecutionDecision({
    enabled: true,
    armed: true,
    amount: 4_000,
    maxPerDeposit: 5_000,
    spentInSession: 7_000,
    sessionBudget: 10_000
  }).reason, 'session-budget');
});

test('execução do apoio exige opção, armamento, margem e unidades', () => {
  const base = {
    enabled: true,
    armed: true,
    simulation: false,
    synthetic: false,
    secondsUntilArrival: 90,
    minLeadSeconds: 30,
    sentInSession: 0,
    sessionLimit: 3,
    selectedUnits: 1_970,
    travelSeconds: 20,
    arrivalBufferSeconds: 10,
    requireTravelTime: true
  };

  assert.deepEqual(Core.supportExecutionDecision(base), {
    allowed: true,
    reason: 'allowed'
  });
  assert.equal(Core.supportExecutionDecision({
    ...base,
    armed: false
  }).reason, 'not-armed');
  assert.equal(Core.supportExecutionDecision({
    ...base,
    synthetic: true
  }).reason, 'synthetic');
  assert.equal(Core.supportExecutionDecision({
    ...base,
    secondsUntilArrival: 29
  }).reason, 'insufficient-lead');
  assert.equal(Core.supportExecutionDecision({
    ...base,
    selectedUnits: 0
  }).reason, 'no-units');
});

test('execução do apoio respeita o limite acumulado da sessão', () => {
  assert.equal(Core.supportExecutionDecision({
    enabled: true,
    armed: true,
    secondsUntilArrival: 90,
    minLeadSeconds: 30,
    sentInSession: 3,
    sessionLimit: 3,
    selectedUnits: 100,
    travelSeconds: 20
  }).reason, 'session-limit');
});

test('execução do apoio bloqueia viagens desconhecidas ou tardias', () => {
  const base = {
    enabled: true,
    armed: true,
    secondsUntilArrival: 60,
    minLeadSeconds: 30,
    sessionLimit: 3,
    selectedUnits: 100,
    arrivalBufferSeconds: 10,
    requireTravelTime: true
  };
  assert.equal(Core.supportExecutionDecision({
    ...base,
    travelSeconds: null
  }).reason, 'travel-time-unknown');
  assert.equal(Core.supportExecutionDecision({
    ...base,
    travelSeconds: 50
  }).reason, 'arrival-too-late');
  assert.equal(Core.supportExecutionDecision({
    ...base,
    travelSeconds: 49
  }).reason, 'allowed');
});

test('seleção do apoio aplica percentagem depois da reserva por tipo', () => {
  const result = Core.calculateSupportSelection([
    { name: 'sword', available: 1_250 },
    { name: 'archer', available: 600 },
    { name: 'bireme', available: 80 },
    { name: 'transport', available: 40 }
  ], 50, 10);

  assert.deepEqual(result.units.map((unit) => unit.selected), [620, 295, 35, 15]);
  assert.equal(result.availableTotal, 1_970);
  assert.equal(result.selectedTotal, 965);
});

test('seleção do apoio nunca ultrapassa o disponível nem a faixa percentual', () => {
  assert.equal(Core.calculateSupportSelection([5], 200, 10).selectedTotal, 0);
  assert.equal(Core.calculateSupportSelection([100], -20, 0).selectedTotal, 0);
  assert.equal(Core.calculateSupportSelection([100], 100, 20).selectedTotal, 80);
});

test('pré-verificação valida limites da execução automática da gruta', () => {
  const result = Core.analyzePreflight({
    towns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    settings: {
      ...Core.DEFAULTS,
      autoConfirmCave: true,
      caveConfirmMax: 0,
      caveSessionBudget: 0,
      executionArmMinutes: 0,
      dodgeTargetTownId: '8',
      townPolicies: { 8: { safeTownId: '2' } }
    },
    capabilities: {
      layoutTownSwitch: true,
      mapJump: true,
      caveBuilding: true,
      caveInput: false
    }
  });

  assert.equal(result.passed, false);
  assert.ok(result.errors.some((issue) => issue.code === 'cave-confirm-limit-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'cave-session-budget-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'execution-duration-invalid'));
});

test('pré-verificação valida limites da execução automática de apoios', () => {
  const result = Core.analyzePreflight({
    towns: [
      { id: '2', name: 'Braavos' },
      { id: '8', name: 'Highgarden' }
    ],
    settings: {
      ...Core.DEFAULTS,
      autoSendSupport: true,
      supportSessionLimit: 0,
      supportMinLeadSeconds: 4,
      supportExecutionArmMinutes: 0,
      supportSendPercent: 0,
      supportReservePerUnit: -1,
      supportMinimumTotal: 0,
      supportArrivalBufferSeconds: -1,
      dodgeTargetTownId: '8',
      townPolicies: { 8: { safeTownId: '2' } }
    },
    capabilities: {
      layoutTownSwitch: true,
      mapJump: true,
      caveBuilding: true,
      caveInput: false
    }
  });

  assert.equal(result.passed, false);
  assert.ok(result.errors.some((issue) => issue.code === 'support-session-limit-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-lead-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-duration-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-percent-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-reserve-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-minimum-invalid'));
  assert.ok(result.errors.some((issue) => issue.code === 'support-arrival-buffer-invalid'));
});

test('formata durações negativas e positivas', () => {
  assert.equal(Core.formatDuration(3_661), '1h 01m 01s');
  assert.equal(Core.formatDuration(-5), '00m 00s');
});

test('mantém o painel dentro do ecrã', () => {
  assert.deepEqual(
    Core.clampPanelPosition(1_900, -20, 1_920, 1_080, 360, 400),
    { x: 1_560, y: 0 }
  );
});

test('lê prata através do método resources do Grepolis', () => {
  const resources = Core.extractTownResources({
    resources: () => ({ wood: 10, stone: 20, iron: 30_600 })
  });
  assert.deepEqual(resources, { wood: 10, stone: 20, silver: 30_600 });
});

test('confirma valores numéricos preenchidos em inputs formatados', () => {
  assert.equal(Core.numericInputValue('19 000'), 19_000);
  assert.equal(Core.numericInputValue('19.000'), 19_000);
  assert.equal(Core.numericInputValue('19000'), 19_000);
});

test('normaliza nomes de cidades para comparação entre fontes', () => {
  assert.equal(Core.normalizeTownLabel('  Harrenhal  '), 'harrenhal');
  assert.equal(Core.normalizeTownLabel('Castely   Rock'), 'castely rock');
});

test('cria a carga correta para abrir uma cidade no mapa', () => {
  assert.deepEqual(
    Core.buildMapTownPayload('8', {
      getIslandCoordinateX: () => 488,
      getIslandCoordinateY: () => 554
    }, 'Highgarden'),
    {
      id: 8,
      x: 488,
      y: 554,
      name: 'Highgarden'
    }
  );
});

test('exclui movimentos que partem das próprias cidades', () => {
  const ownTownIds = new Set(['2', '7', '10']);
  assert.equal(Core.isOwnMovement({
    originTownId: '10',
    playerId: '531',
    synthetic: false
  }, ownTownIds, '531'), true);
  assert.equal(Core.isOwnMovement({
    originTownId: '999',
    playerId: '777',
    synthetic: false
  }, ownTownIds, '531'), false);
  assert.equal(Core.isOwnMovement({
    originTownId: '',
    playerId: '531',
    synthetic: false
  }, ownTownIds, '531'), true);
});
