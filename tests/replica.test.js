'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const replica = fs.readFileSync(
  path.join(__dirname, 'grepolis-replica.html'),
  'utf8'
);

test('os scripts inline da réplica têm JavaScript válido', () => {
  const scripts = [...replica.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0);
  scripts.forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
});

test('a réplica mantém o contrato DOM do seletor de cidades', () => {
  assert.match(replica, /class="town_name_area"/);
  assert.match(replica, /class="town_groups_dropdown btn_toggle_town_groups_menu"/);
  assert.match(replica, /class="caption js-viewport"/);
  assert.match(replica, /id="town_groups_list"/);
  assert.match(replica, /class="content js-dropdown-item-list town_groups_list"/);
  assert.match(replica, /class="group_towns ui-droppable"/);
  assert.match(replica, /class="btn_next_town button_arrow right"/);
  assert.match(replica, /class="btn_prev_town button_arrow left"/);
});

test('a réplica mantém o contrato DOM da janela da gruta', () => {
  assert.match(replica, /className = 'js-window-main-container classic_window hide'/);
  assert.match(replica, /class="order_count"/);
  assert.match(replica, /class="confirm_deposit"/);
  assert.match(replica, /data-building="hide"/);
});

test('o cenário completo protege a confirmação do depósito', () => {
  assert.match(replica, /window\.Game\.townId === '7'/);
  assert.match(replica, /input\.value === '4706'/);
  assert.match(replica, /confirmedDeposits === 0/);
  assert.match(replica, /PASSOU: Harrenhal selecionada/);
});

test('o cenário de desvio termina antes do envio de tropas', () => {
  assert.match(replica, /function runDodgeTest\(\)/);
  assert.match(replica, /window\.Game\.townId === '2'/);
  assert.match(replica, /lastMapJump === '8'/);
  assert.match(replica, /context_menu\[data-town-id="8"\]/);
  assert.match(replica, /sentCommands === 0/);
  assert.match(replica, /PASSOU: Braavos selecionada, Highgarden aberta no mapa/);
});

test('a réplica mantém o contrato DOM do envio de apoio', () => {
  assert.match(replica, /class="select_all_units"/);
  assert.match(replica, /class="send_command"/);
  assert.match(replica, /name="unit_sword"/);
  assert.match(replica, /data-max="1250"/);
  assert.match(replica, /command\.remove\(\)/);
  assert.match(replica, /class="way_duration"/);
  assert.match(replica, /data-duration="20"/);
});

test('a réplica inclui movimentos próprios para testar falsos positivos', () => {
  assert.match(replica, /id: 'own-outgoing'/);
  assert.match(replica, /id: 'own-returning'/);
  assert.match(replica, /home_town_id: '10'/);
});

test('a réplica suporta o menu contextual por gp_town_link', () => {
  assert.match(replica, /getLinkFragment: \(\) => `#town=\$\{data\.id\}`/);
  assert.match(replica, /\.gp_town_link/);
  assert.match(replica, /openMapTownMenu\(\{ id: townId \}\)/);
});

test('a réplica valida a auto-preparação sem executar ações finais', () => {
  assert.match(replica, /function runAutomationTest\(\)/);
  assert.match(replica, /data-action="arm-automation"/);
  assert.match(replica, /townSwitchHistory\.includes\('2'\)/);
  assert.match(replica, /input\.value === '2543'/);
  assert.match(replica, /confirmedDeposits === 0/);
  assert.match(replica, /sentCommands === 0/);
  assert.match(replica, /ataque e espionagem auto-preparados/);
});

test('a réplica inicia sem exceções nas políticas por cidade', () => {
  assert.match(replica, /townPolicies:\s*\{\}/);
  assert.match(replica, /dodgeTargetTownId:\s*'8'/);
  assert.match(replica, /dodgeFallbackTownId:\s*'11'/);
  assert.match(replica, /autoSelectFallback:\s*true/);
});

test('a réplica contém uma onda de ataques à mesma cidade', () => {
  assert.match(replica, /id: 'attack-wave-2'/);
  assert.match(replica, /arrival_at: threatArrivals\.attack \+ 30_000/);
  assert.match(replica, /target_town_id: '2'/);
  assert.match(replica, /waveGapSeconds:\s*300/);
});

test('a réplica configura os limites do watchdog e do disjuntor', () => {
  assert.match(replica, /automationFailureLimit:\s*3/);
  assert.match(replica, /watchdogStaleSeconds:\s*20/);
});

test('a réplica mantém capacidades suficientes para a pré-verificação', () => {
  assert.match(replica, /window\.WMap = \{/);
  assert.match(replica, /class="btn_next_town button_arrow right"/);
  assert.match(replica, /data-building="hide"/);
});

test('a réplica valida um depósito automático sem enviar tropas', () => {
  assert.match(replica, /function runCaveExecutionTest\(\)/);
  assert.match(replica, /data-action="arm-cave-execution"/);
  assert.match(replica, /confirmedDeposits === 1/);
  assert.match(replica, /castleBlack\.silver === 24_863/);
  assert.match(replica, /castleBlack\.cave === 25_000/);
  assert.match(replica, /sentCommands === 0/);
  assert.match(replica, /2 543 depositados automaticamente/);
});

test('a réplica valida um apoio automático sem usar Atacar', () => {
  assert.match(replica, /function runSupportExecutionTest\(\)/);
  assert.match(replica, /data-setting="autoSendSupport"/);
  assert.match(replica, /data-action="arm-support-execution"/);
  assert.match(replica, /lastSentCommandType === 'support'/);
  assert.match(replica, /lastSentUnits === 965/);
  assert.match(replica, /sentCommands === 1/);
  assert.match(replica, /Atacar não foi utilizado/);
});

test('a réplica configura os limites da execução de apoios', () => {
  assert.match(replica, /autoSendSupport:\s*false/);
  assert.match(replica, /supportSessionLimit:\s*3/);
  assert.match(replica, /supportMinLeadSeconds:\s*30/);
  assert.match(replica, /supportExecutionArmMinutes:\s*10/);
  assert.match(replica, /supportSendPercent:\s*100/);
  assert.match(replica, /supportReservePerUnit:\s*0/);
  assert.match(replica, /supportMinimumTotal:\s*1/);
  assert.match(replica, /supportArrivalBufferSeconds:\s*10/);
  assert.match(replica, /supportRequireTravelTime:\s*true/);
});

test('a réplica valida a calculadora de sorte sem executar ações', () => {
  assert.match(replica, /function runLuckTest\(\)/);
  assert.match(replica, /data-tab="luck"/);
  assert.match(replica, /luckAttackStrength/);
  assert.match(replica, /luckDefenseStrength/);
  assert.match(replica, /data-luck-required/);
  assert.match(replica, /data-luck-selected-result/);
  assert.match(replica, /sorte mínima \+10%/);
  assert.match(replica, /confirmedDeposits === 0/);
  assert.match(replica, /sentCommands === 0/);
});
