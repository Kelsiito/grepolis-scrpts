'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'grepolis-assistant.user.js'),
  'utf8'
);

test('a leitura das cidades e o diagnóstico devolvem estruturas completas', () => {
  assert.match(source, /function normalizeTown\([\s\S]*?return \{\s*id:/);
  assert.match(source, /function buildDiagnostic\(\)[\s\S]*?const diagnostic = \{\s*version:/);
  assert.match(source, /diagnostic\.preflight = state\.preflight;\s*return diagnostic;/);
});

test('a auto-preparação reutiliza os fluxos assistidos', () => {
  assert.match(source, /await prepareCave\(command\.targetTownId, \{/);
  assert.match(source, /await prepareDodge\(command\.commands\[0\]\.id, safeChoice\.townId, \{/);
});

test('a confirmação da gruta existe apenas atrás do armamento e dos limites', () => {
  assert.match(source, /function findCaveConfirmButton\(\)/);
  assert.match(source, /function executeCaveDeposit\(\{ town, input, deposit \}\)/);
  assert.match(source, /const decision = caveExecutionDecision\(/);
  assert.match(source, /if \(!decision\.allowed\) return/);
  assert.match(source, /button\.click\(\)/);
  assert.match(source, /allowFinalize: isCaveExecutionArmed\(\) && !command\.synthetic/);
});

test('o envio de tropas existe apenas no fluxo controlado de apoio', () => {
  assert.match(source, /function executeSupportCommand\(\{ command, menu, safeTown \}\)/);
  assert.match(source, /const decision = supportExecutionDecision\(/);
  assert.match(source, /if \(!decision\.allowed\) return/);
  assert.match(source, /allowFinalize: isSupportExecutionArmed\(\) && !command\.synthetic/);
  assert.match(source, /\/apoiar\|apoio\|support\/i/);
  assert.match(source, /!\/atacar\|attack\/i/);
  assert.match(source, /sendButton\.click\(\)/);
});

test('o armamento não é persistido nas definições', () => {
  const defaults = source.match(
    /const DEFAULTS = Object\.freeze\(\{([\s\S]*?)\n  \}\);/
  )?.[1] || '';
  assert.match(source, /automation:\s*\{\s*armedUntil:\s*0/);
  assert.match(source, /execution:\s*\{\s*caveArmedUntil:\s*0/);
  assert.match(source, /supportArmedUntil:\s*0/);
  assert.doesNotMatch(defaults, /armedUntil/);
});

test('as políticas e o centro de ações são persistidos separadamente', () => {
  assert.match(source, /townPolicies:\s*\{\}/);
  assert.match(source, /const ACTION_KEY = 'ga\.actions\.v1'/);
  assert.match(source, /actions:\s*load\(ACTION_KEY, \[\]\)/);
});

test('um desvio automático bloqueia cidades seguras inválidas', () => {
  assert.match(source, /const safeChoice = decision\.action === 'dodge' \? chooseSafeTown\(command\) : null/);
  assert.match(source, /Não existe uma cidade segura disponível/);
});

test('ações defensivas são deduplicadas por cidade e tipo de reação', () => {
  assert.match(source, /return `\$\{action\}:town:\$\{command\.targetTownId \|\| command\.id\}`/);
  assert.match(source, /const candidates = state\.reactions/);
});

test('o desvio usa o seletor central de destinos seguros', () => {
  assert.match(source, /function chooseSafeTown\(command, preferredOverride = ''\)/);
  assert.match(source, /blockedTownIds: blockedSafeTownIds\(\)/);
  assert.match(source, /threatenedTownIds: threatenedAttackTownIds\(\)/);
});

test('a interface expõe prioridades, alternativas e bloqueio de destino', () => {
  assert.match(source, /data-policy-field="priority"/);
  assert.match(source, /data-policy-field="fallbackSafeTownId"/);
  assert.match(source, /data-policy-field="canReceiveDodge"/);
  assert.match(source, /checkField\('autoSelectFallback'/);
});

test('falhas repetidas desarmam a automação e exigem reposição manual', () => {
  assert.match(source, /function registerAutomationOutcome\(success, message = ''\)/);
  assert.match(source, /disarmAutomation\('proteção por falhas repetidas', false\)/);
  assert.match(source, /data-action="reset-breaker"/);
});

test('o watchdog interrompe uma sessão armada com leitura atrasada', () => {
  assert.match(source, /watchdog sem leitura atualizada/);
  assert.match(source, /health\.label === 'Leitura atrasada'/);
});

test('o armamento exige uma pré-verificação aprovada', () => {
  assert.match(source, /const preflight = runPreflight\(false\)/);
  assert.match(source, /if \(!preflight\.passed\)/);
  assert.match(source, /Pré-verificação bloqueou o armamento/);
});

test('o diagnóstico apresenta erros e avisos da pré-verificação', () => {
  assert.match(source, /data-action="run-preflight"/);
  assert.match(source, /preflight\.errors\.map/);
  assert.match(source, /preflight\.warnings\.map/);
});

test('a execução da gruta tem armamento separado e orçamento por sessão', () => {
  assert.match(source, /function armCaveExecution\(\)/);
  assert.match(source, /function disarmCaveExecution\(reason = 'manual'/);
  assert.match(source, /state\.execution\.spentSilver \+= deposit/);
  assert.match(source, /caveSessionBudget/);
  assert.match(source, /caveConfirmMax/);
});

test('a execução do apoio tem armamento, margem e limite separados', () => {
  assert.match(source, /function armSupportExecution\(\)/);
  assert.match(source, /function disarmSupportExecution\(reason = 'manual'/);
  assert.match(source, /state\.execution\.supportCommandsSent \+= 1/);
  assert.match(source, /supportSessionLimit/);
  assert.match(source, /supportMinLeadSeconds/);
  assert.match(source, /supportExecutionArmMinutes/);
  assert.match(source, /supportSendPercent/);
  assert.match(source, /supportReservePerUnit/);
  assert.match(source, /supportMinimumTotal/);
  assert.match(source, /supportArrivalBufferSeconds/);
  assert.match(source, /supportRequireTravelTime/);
  assert.match(source, /calculateSupportSelection\(/);
  assert.match(source, /below-minimum-total/);
  assert.match(source, /travel-time-unknown/);
  assert.match(source, /arrival-too-late/);
  assert.match(source, /function readSupportTravelSeconds\(commandWindow\)/);
});

test('desarmar a auto-preparação desarma também as execuções finais', () => {
  assert.match(source, /disarmCaveExecution\('auto-preparação desarmada', false\)/);
  assert.match(source, /disarmSupportExecution\('auto-preparação desarmada', false\)/);
});

test('a calculadora de sorte é passiva e não reutiliza fluxos de execução', () => {
  assert.match(source, /function calculateLuckScenario\(/);
  assert.match(source, /function renderLuck\(\)/);
  const calculator = source.match(
    /function renderLuck\(\) \{([\s\S]*?)\n  \}\n\n  function renderActions/
  )?.[1] || '';
  assert.doesNotMatch(calculator, /\.click\(/);
  assert.doesNotMatch(calculator, /prepareCave|prepareDodge|executeSupportCommand/);
});

test('o risco tem um elemento próprio e não substitui a prioridade', () => {
  assert.match(source, /class="ga-badge ga-priority"/);
  assert.match(source, /class="ga-badge ga-risk"/);
  assert.match(source, /const riskBadge = card\.querySelector\('\.ga-risk'\)/);
  assert.doesNotMatch(source, /const badge = card\.querySelector\('\.ga-badge'\)/);
});

test('os cartões mostram cidade e jogador de origem', () => {
  assert.match(source, /town_name_origin/);
  assert.match(source, /town_name_destination/);
  assert.match(source, /link_origin/);
  assert.match(source, /function formatCommandOrigin\(command\)/);
  assert.match(source, /command\.originLabels\?\./);
});
