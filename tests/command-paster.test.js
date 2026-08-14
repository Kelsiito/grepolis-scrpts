const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

global.window = {};
global.document = undefined;

const Core = require('../grepolis-command-paster.user.js');

const chiosNc = Core.normalizePlannedCommand({
  id: 46,
  plan_id: 19,
  plan_name: 'Bbhh',
  type: 'attack',
  origin_town_id: 19,
  target_town_id: 22,
  send_at: 1_786_365_308,
  arrival_at: 1_786_366_646,
  units: { colonize_ship: 1, attack_ship: 20, catapult: 10 },
  spell: null,
  strategies: '[]',
  can_edit: true
});

test('normaliza comando real de Chios e conserva duração nativa', () => {
  assert.equal(chiosNc.valid, true);
  assert.equal(chiosNc.sendAt, 1_786_365_308_000);
  assert.equal(chiosNc.arrivalAt - chiosNc.sendAt, 1_338_000);
  assert.equal(chiosNc.originTownId, '19');
  assert.equal(chiosNc.targetTownId, '22');
});

test('classifica NC pela composição mesmo quando tipo nativo é attack', () => {
  assert.equal(Core.commandKind(chiosNc), 'nc');
  assert.equal(Core.toleranceForCommand(chiosNc, { attack: 2, nc: 7 }), 7);
});

test('aplica janelas independentes e limita-as a 15 segundos', () => {
  const attack = { ...chiosNc, units: { slinger: 100 } };
  const support = { ...chiosNc, type: 'support', canonicalType: 'support', units: { sword: 100 } };
  assert.equal(Core.toleranceForCommand(attack, { attack: -3, support: 4, nc: 0 }), 0);
  assert.equal(Core.toleranceForCommand(support, { attack: 3, support: 40, nc: 0 }), 15);
  assert.deepEqual(Core.plannedTimes(attack, { attack: 3 }), {
    toleranceSeconds: 3,
    dispatchAt: attack.sendAt,
    desiredArrivalAt: attack.arrivalAt
  });
});

test('cria payload backend sem campos DOM', () => {
  const payload = Core.buildSendPayload({
    ...chiosNc,
    useHero: true,
    spell: 'ares_sacrifice',
    strategies: ['regular']
  });
  assert.deepEqual(payload, {
    id: 22,
    town_id: 19,
    type: 'attack',
    nl_init: true,
    colonize_ship: 1,
    attack_ship: 20,
    catapult: 10,
    use_hero: true,
    power_id: 'ares_sacrifice',
    attacking_strategy: ['regular']
  });
});

test('aceita a janela configurada e rejeita chegada tardia', () => {
  assert.deepEqual(Core.arrivalResult(9_999_250, 10_000_000, 0), { deviationMs: -1_000, accepted: false, retry: true });
  assert.deepEqual(Core.arrivalResult(9_999_250, 10_000_000, 1), { deviationMs: -1_000, accepted: true, retry: false });
  assert.deepEqual(Core.arrivalResult(10_000_999, 10_000_000), { deviationMs: 0, accepted: true, retry: false });
  assert.equal(Core.arrivalResult(10_001_000, 10_000_000).retry, false);
});

test('compensa metade do RTT e viés antecipado', () => {
  assert.equal(Core.median([140, 100, 120]), 120);
  assert.equal(Core.releaseAt(10_000, 120, 100), 9_840);
});

test('calibra o pedido para o centro da janela aceite', () => {
  assert.equal(Core.calibratedAttemptAt(85_000, -14_000, 0), 99_500);
  assert.equal(Core.calibratedAttemptAt(85_000, -14_000, 1), 99_000);
  assert.equal(Core.calibratedAttemptAt(85_000, -14_000, 3), 98_000);
});

test('mantém comando durante correção de dez segundos e só depois expira', () => {
  const stillValid = Core.reconcileCapturedJobs({
    jobs: {},
    capturedIds: ['46'],
    commands: [chiosNc],
    offsets: { nc: 0 },
    now: chiosNc.sendAt + 9_999
  });
  assert.equal(stillValid['46'].status, 'pending');
  const expired = Core.reconcileCapturedJobs({
    jobs: {},
    capturedIds: ['46'],
    commands: [chiosNc],
    offsets: { nc: 0 },
    now: chiosNc.sendAt + 10_000
  });
  assert.equal(expired['46'].status, 'expired');
  assert.equal(expired['46'].error, 'dispatch-time-passed');
});

test('remoção do plano cancela job e planos novos são ignorados', () => {
  const jobs = Core.reconcileCapturedJobs({
    jobs: { 46: { id: '46', status: 'pending' } },
    capturedIds: ['46'],
    commands: [{ ...chiosNc, id: '99' }],
    offsets: { nc: 0 },
    now: 0
  });
  assert.deepEqual(Object.keys(jobs), ['46']);
  assert.equal(jobs['46'].status, 'cancelled');
  assert.equal(jobs['46'].error, 'removed-from-planner');
});

test('edição de comando pronto força nova pré-validação', () => {
  const jobs = Core.reconcileCapturedJobs({
    jobs: {
      46: {
        id: '46',
        status: 'ready',
        fingerprint: Core.commandFingerprint(chiosNc),
        releaseAt: 123,
        rttMs: 90
      }
    },
    capturedIds: ['46'],
    commands: [{ ...chiosNc, arrivalAt: chiosNc.arrivalAt + 5_000, sendAt: chiosNc.sendAt + 5_000 }],
    offsets: { nc: 0 },
    now: 0
  });
  assert.equal(jobs['46'].status, 'pending');
  assert.equal(jobs['46'].releaseAt, 0);
  assert.equal(jobs['46'].rttMs, 0);
});

test('job confirmado permanece terminal após desaparecer do planeador', () => {
  const jobs = Core.reconcileCapturedJobs({
    jobs: { 46: { id: '46', status: 'confirmed', movementId: 'abc' } },
    capturedIds: ['46'],
    commands: [],
    offsets: {},
    now: 99
  });
  assert.equal(jobs['46'].status, 'confirmed');
  assert.equal(jobs['46'].movementId, 'abc');
});

test('fonte reconcilia respostas sem ID e limita spam a duzentas rejeições', () => {
  const source = fs.readFileSync(require.resolve('../grepolis-command-paster.user.js'), 'utf8');
  assert.match(source, /'attack_planer', 'attacks'/);
  assert.match(source, /'town_info', 'send_units'/);
  assert.match(source, /attemptLeadMs:\s*15_000/);
  assert.match(source, /plannerRefreshMs:\s*1_000/);
  assert.match(source, /maximumParallel:\s*1/);
  assert.match(source, /'command_info', 'cancel_command'/);
  assert.match(source, /maximumFailedAttempts:\s*200/);
  assert.match(source, /TIMING_CORRECTION_WINDOW_MS = 10_000/);
  assert.match(source, /timingCorrectionWindowMs:\s*TIMING_CORRECTION_WINDOW_MS/);
  assert.match(source, /job\.dispatchAt \+ CONFIG\.timingCorrectionWindowMs/);
  assert.match(source, /spamGapMs:\s*20/);
  assert.match(source, /Tentativa cancelada; spam serial retomado/);
  assert.match(source, /direct\?\.id \? CONFIG\.commandResolveTimeoutMs : 750/);
  assert.match(source, /setTimeout\(resolve, 10\)/);
  assert.match(source, /if \(!movement\)/);
  assert.match(source, /Referência calibrada registada; retry mantido até ao fim da janela/);
  assert.doesNotMatch(source, /calibratedAt > serverNowMs\(\)/);
  assert.doesNotMatch(source, /if \(!timing\.retry\)/);
  assert.doesNotMatch(source, /<span data-gcp-diagnostics/);
  assert.doesNotMatch(source, /<span data-gcp-history/);
  assert.doesNotMatch(source, /<span data-gcp-status/);
  assert.match(source, /<select data-gcp-offset="attack">/);
  assert.match(source, /position:absolute/);
  assert.match(source, /planner\.classList\.add\('gcp-panel-host'\)/);
  assert.doesNotMatch(source, /\.gcp-panel-host\{position:relative!important\}/);
  assert.match(source, /planner\.insertBefore\(createPanel\(\), planner\.firstChild\)/);
  assert.match(source, /state\.armed \? 'Cancelar' : 'Activar'/);
  assert.match(source, /\.attack_planner\.attacks/);
  assert.match(source, /existingPanel\.hidden = true/);
  assert.match(source, /existingPanel\.hidden = false/);
  assert.match(source, /#\$\{PANEL_ID\}\[hidden\]/);
  assert.doesNotMatch(source, /new MutationObserver\(scanPlanner\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*scanPlanner\(\);\s*renderPanel\(\);\s*\}, 500\)/);
  assert.match(source, /function appendAttemptRecord/);
  assert.match(source, /function jobWasEdited/);
  assert.match(source, /if \(jobWasEdited\(job\)\)/);
  assert.match(source, /result: 'CANCELADO-APÓS-EDIÇÃO'/);
  assert.match(source, /result: 'MANTIDO'/);
  assert.match(source, /result: 'CANCELADO'/);
  assert.match(source, /result: 'CANCELAMENTO-FALHOU'/);
  assert.match(source, /result: 'CANCELADO-MANUAL'/);
  assert.match(source, /stopRequested = true/);
  assert.match(source, /state\.armed && !stopRequested/);
  assert.match(source, /confirmedFingerprints/);
  assert.match(source, /!confirmed\.has\(commandFingerprint\(command\)\)/);
  assert.match(source, /lastMovementSendRttMs/);
  assert.match(source, /lastMovementCancelRttMs/);
  assert.doesNotMatch(source, /Diagnóstico último comando:/);
  assert.match(source, /Colagem terminou com \$\{failed\.length\} falha/);
  assert.match(source, /Comando confirmado no segundo exato/);
  assert.match(source, /Ciclo interrompido para evitar comando duplicado/);
  assert.doesNotMatch(source, /sendButton\.click/);
  assert.doesNotMatch(source, /\.gpwindow_content \.attack_planner\.index/);
});

test('réplica segura contém Planeador e carrega o userscript', () => {
  const replica = fs.readFileSync(require.resolve('./command-paster-replica.html'), 'utf8');
  assert.match(replica, /class="attack_planner index"/);
  assert.match(replica, /grepolis-command-paster\.user\.js/);
  assert.match(replica, /A réplica nunca permite envios/);
});
