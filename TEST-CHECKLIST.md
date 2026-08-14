# Checklist de validação no Grepolis

Usar esta lista quando for possível testar no Chrome. Executar primeiro com
`Modo de simulação` ativo e só depois em modo assistido.

## Painel e monitorização

- [ ] O botão `GA` e o painel movem-se juntos e mantêm a posição após atualizar.
- [ ] O scroll funciona nos separadores Gruta, Ações e Políticas.
- [ ] O painel apresenta as 17 cidades.
- [ ] Movimentos próprios e tropas em regresso não aparecem como ameaças.
- [ ] Um ataque ou espionagem real aparece na cidade correta.
- [ ] A contagem decrescente coincide ao segundo com a visão geral de comandos.

## Gruta assistida

- [ ] `Preparar` seleciona a cidade correta.
- [ ] Abre a gruta e preenche exatamente o valor sugerido.
- [ ] Mantém a reserva mínima configurada.
- [ ] Não confirma o depósito.
- [ ] O centro de ações passa para `Preparada`.

## Desvio assistido

- [ ] Seleciona a cidade ameaçada.
- [ ] Salta para a cidade segura correta.
- [ ] Abre o menu contextual da cidade segura.
- [ ] Não abre uma cidade segura igual à cidade ameaçada.
- [ ] Não envia tropas.
- [ ] O centro de ações passa para `Preparada`.

## Auto-preparação controlada

- [ ] Após atualizar a página, a auto-preparação começa desarmada.
- [ ] O botão `Armar auto-preparação` apresenta a duração restante.
- [ ] A automação desarma quando o tempo configurado termina.
- [ ] Uma espionagem dentro da janela prepara a gruta uma única vez.
- [ ] Um ataque prepara o desvio apenas no instante configurado.
- [ ] Duas ameaças são tratadas por ordem de chegada, sem ações simultâneas.
- [ ] Uma falha fica registada e não entra num ciclo de repetição.

## Políticas por cidade

- [ ] Cada cidade aparece no separador Políticas.
- [ ] Desativar a gruta numa cidade não afeta as restantes.
- [ ] Desativar o desvio numa cidade não afeta as restantes.
- [ ] Uma cidade pode usar uma cidade segura diferente da regra global.
- [ ] `Repor regra global` remove apenas a exceção dessa cidade.
- [ ] `Repor todas as políticas` mantém as definições globais.
- [ ] Uma cidade segura inválida deixa a ação como `Bloqueada`.

## Centro de ações

- [ ] Mostra ações `À espera` antes da janela temporal.
- [ ] Altera para `Pronta` quando chega o momento de preparação.
- [ ] Mostra `Em curso` durante a interação com o jogo.
- [ ] Mantém histórico de ações preparadas, falhadas, bloqueadas e expiradas.
- [ ] `Preparar agora` funciona numa ação pendente.
- [ ] `Limpar histórico concluído` não remove ações ainda pendentes.

## Ondas e incidentes

- [ ] `Testar onda` cria três ataques agrupados num único cartão.
- [ ] O cartão mostra três ondas e duas origens.
- [ ] A contagem decrescente usa a primeira chegada.
- [ ] A janela apresentada cobre a primeira até à última chegada.
- [ ] Ataques à mesma cidade fora do intervalo configurado aparecem separados.
- [ ] Ataques a cidades diferentes nunca são agrupados.
- [ ] Ataques e espionagens à mesma cidade permanecem incidentes diferentes.
- [ ] Uma onda gera apenas uma preparação de desvio e uma entrada no centro de ações.

## Prioridades e destinos alternativos

- [ ] Cada cidade permite escolher prioridade alta, normal ou baixa.
- [ ] A prioridade aparece nos cartões de ameaça e no centro de ações.
- [ ] Entre chegadas quase simultâneas, uma cidade de prioridade alta é tratada primeiro.
- [ ] Se a cidade segura principal estiver disponível, é usada normalmente.
- [ ] Se a principal estiver sob ataque, é usada a alternativa configurada.
- [ ] Uma cidade com `Pode receber tropas desviadas` desativado nunca é escolhida.
- [ ] A própria cidade ameaçada nunca é escolhida como destino.
- [ ] Se principal e alternativa falharem, a seleção automática usa outra cidade válida.
- [ ] Com seleção automática desativada e sem destino válido, a ação fica `Bloqueada`.
- [ ] O centro de ações indica quando foi escolhida uma alternativa.

## Watchdog e disjuntor

- [ ] O diagnóstico apresenta `Saudável` com leituras normais.
- [ ] Mostra a idade da última leitura em segundos.
- [ ] `Simular falha` aumenta o contador sem executar ações no jogo.
- [ ] Uma preparação bem-sucedida repõe o contador de falhas.
- [ ] Ao atingir o limite configurado, a auto-preparação é desarmada.
- [ ] O topo do painel apresenta `PROTEÇÃO ATIVADA`.
- [ ] Não é possível armar novamente enquanto o disjuntor estiver ativado.
- [ ] `Repor proteção` limpa as falhas, mas mantém a automação desarmada.
- [ ] Se a leitura do jogo ultrapassar o limite do watchdog, a sessão é interrompida.
- [ ] O motivo da proteção fica visível no diagnóstico e no registo.

## Pré-verificação v1.0

- [ ] `Executar pré-verificação` apresenta uma pontuação de prontidão.
- [ ] Uma configuração válida apresenta `Pronta para armar`.
- [ ] Desativar a monitorização cria um erro e bloqueia o armamento.
- [ ] Um watchdog inferior ao intervalo de leitura cria um erro.
- [ ] Uma cidade sem destino seguro cria um erro identificado pelo nome.
- [ ] Uma política de uma cidade inexistente aparece como aviso.
- [ ] Um destino guardado que já não existe aparece como aviso.
- [ ] APIs obrigatórias indisponíveis aparecem como erros específicos.
- [ ] Avisos reduzem a pontuação, mas não bloqueiam o armamento.
- [ ] Erros impedem o armamento e abrem automaticamente o Diagnóstico.

## Execução controlada da gruta

- [ ] A opção `Confirmar depósitos automaticamente` começa desativada.
- [ ] Atualizar a página desarma a execução da gruta.
- [ ] Não é possível armar a execução enquanto o modo de simulação estiver ativo.
- [ ] O armamento da execução é independente da auto-preparação.
- [ ] Um depósito abaixo do máximo é confirmado automaticamente.
- [ ] Um depósito acima do máximo fica apenas preenchido.
- [ ] O orçamento da sessão acumula todos os depósitos confirmados.
- [ ] Um depósito que ultrapasse o orçamento fica apenas preenchido.
- [ ] A execução desarma quando o orçamento for esgotado.
- [ ] A execução desarma quando o tempo terminar.
- [ ] Ataques e espionagens sintéticas nunca gastam prata.
- [ ] O centro de ações apresenta o estado `Executada`.
- [ ] O diagnóstico apresenta gasto, confirmações e último depósito.
- [ ] Nenhum fluxo de execução da gruta envia tropas.

## Execução controlada de apoios

- [ ] A opção `Enviar apoio automaticamente` começa desativada.
- [ ] Atualizar a página desarma a execução de apoios.
- [ ] Não é possível armar apoios enquanto o modo de simulação estiver ativo.
- [ ] O armamento dos apoios é independente e apresenta o tempo restante.
- [ ] Desarmar a auto-preparação desarma também a execução da gruta e dos apoios.
- [ ] Um ataque sintético nunca envia tropas.
- [ ] Um ataque real abaixo da margem mínima fica apenas preparado.
- [ ] Um ataque real com margem suficiente seleciona todas as tropas disponíveis.
- [ ] Com `100%` e reserva `0`, seleciona todas as tropas disponíveis.
- [ ] Com `50%`, seleciona metade das tropas disponíveis depois da reserva.
- [ ] A reserva configurada permanece em cada tipo de unidade.
- [ ] Tipos com menos unidades do que a reserva ficam a zero.
- [ ] Um total inferior ao mínimo configurado não é enviado.
- [ ] A duração da viagem é lida da janela de apoio.
- [ ] O apoio é enviado quando chega antes do ataque com a margem configurada.
- [ ] Um apoio que chegaria exatamente no limite não é enviado.
- [ ] Um apoio que chegaria depois do ataque não é enviado.
- [ ] Com `Bloquear se a duração não for detetada` ativo, uma duração desconhecida não é enviada.
- [ ] O comando aberto e enviado é `Apoiar`.
- [ ] A ação `Atacar` nunca é clicada.
- [ ] Uma seleção com zero unidades não é enviada.
- [ ] Cada envio incrementa o contador da sessão uma única vez.
- [ ] Ao atingir o limite da sessão, a execução de apoios é desarmada.
- [ ] O watchdog e o disjuntor desarmam a execução de apoios.
- [ ] O centro de ações apresenta o estado `Executada`.
- [ ] O diagnóstico apresenta armamento, contador e último apoio.
- [ ] A execução de apoios não confirma depósitos na gruta.

## Calculadora de sorte

- [ ] O separador `Sorte` abre sem alterar a cidade selecionada.
- [ ] A faixa de sorte aceita apenas valores entre `−30%` e `+30%`.
- [ ] Ataque `100 000`, defesa `110 000`, moral `100%` exige `+10%`.
- [ ] O mesmo cenário fica desfavorável abaixo de `+10%`.
- [ ] O mesmo cenário fica favorável a `+10%`.
- [ ] Um ataque suficientemente forte apresenta vantagem mesmo com `−30%`.
- [ ] Um ataque demasiado fraco apresenta insuficiente mesmo com `+30%`.
- [ ] Reduzir a moral reduz a força efetiva do ataque.
- [ ] Bónus de ataque aumenta a força efetiva antes da sorte.
- [ ] Bónus de defesa aumenta a defesa efetiva.
- [ ] Os três cenários `−30%`, `0%` e `+30%` são atualizados após cada alteração.
- [ ] Os valores mantêm-se depois de atualizar a página.
- [ ] A calculadora não muda cidades, não abre janelas e não executa ações.

## Segurança

- [ ] Com as duas opções de execução desativadas, nenhum fluxo confirma depósitos ou envia tropas.
- [ ] Cada ação final exige a opção correspondente e um armamento separado.
- [ ] O modo de simulação não muda de cidade nem abre janelas reais.
- [ ] Nenhuma notificação do browser é apresentada.
