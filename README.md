# Grepolis Assistant

Userscripts Tampermonkey para apoio defensivo no Grepolis. O `grepolis-assistant.user.js`
monitoriza comandos, calcula prioridades e prepara reações. O
`grepolis-attack-info.user.js` mostra duração, hora de envio e deteção de navios
colonizadores no espaço livre da lista oficial de comandos. Depósitos automáticos
na gruta são opcionais. O envio automático de apoios também é opcional e usa um
armamento, limites e validações próprios.

## Funcionalidades da v1.5.0

- painel integrado e minimizável;
- painel e botão `GA` unidos num conjunto arrastável, com posição guardada;
- scroll interno protegido para listas extensas de cidades;
- posição de scroll preservada durante atualizações e ao trocar de separador;
- leitura de comandos através dos modelos globais do jogo, com fallback pelo DOM;
- apresentação da cidade e do jogador de origem quando fornecidos pelo jogo;
- exclusão de movimentos próprios e tropas em regresso da lista de ameaças;
- contagens decrescentes e recomendações sincronizadas a cada segundo com o
  relógio do servidor;
- auto-preparação controlada, desarmada após cada carregamento da página;
- regras independentes para preparar a gruta perante espionagem e preparar o
  desvio na janela temporal configurada;
- período de armamento configurável e desativação automática quando expira;
- fila serial por ordem de chegada e proteção contra repetir a mesma ação;
- por defeito, a auto-preparação não confirma depósitos nem envia tropas;
- políticas defensivas por cidade, com regras independentes para gruta e desvio;
- cidade segura configurável individualmente para cada cidade;
- herança das regras globais e reposição individual ou total das exceções;
- centro de ações com estados pendente, pronta, em curso, preparada, bloqueada,
  ignorada, falhada e expirada;
- histórico local das últimas 100 ações e atalhos para preparação manual;
- agrupamento de ataques e espionagens próximos em incidentes/ondas por cidade;
- apresentação do número de ondas, origens e intervalo entre primeira e última chegada;
- prazo operacional baseado na primeira chegada da onda;
- apenas uma preparação defensiva por cidade e tipo de reação enquanto a ameaça
  permanecer ativa;
- intervalo de agrupamento de ondas configurável;
- alerta sintético com três ataques para testar o agrupamento;
- prioridades alta, normal e baixa por cidade para ordenar reações quase simultâneas;
- cidade segura alternativa global ou específica para cada cidade;
- escolha automática de outro destino próprio quando principal e alternativa não
  estão disponíveis;
- exclusão de cidades que também estão sob ataque da lista de destinos seguros;
- possibilidade de bloquear uma cidade para não receber tropas desviadas;
- indicação no registo e no centro de ações quando foi usado um destino alternativo;
- watchdog que deteta quando a leitura do jogo deixou de atualizar;
- contador configurável de falhas consecutivas;
- disjuntor que desarma e bloqueia a auto-preparação após falhas repetidas;
- estado de saúde, idade da última leitura e último sucesso no diagnóstico;
- reposição manual obrigatória após o disjuntor ser ativado;
- simulador de falhas disponível apenas no modo de simulação;
- pré-verificação obrigatória antes de armar a auto-preparação;
- validação das APIs de troca de cidade, mapa e gruta;
- validação dos limites do watchdog, falhas e duração de armamento;
- análise de todas as políticas e destinos seguros por cidade;
- deteção de políticas órfãs e referências a cidades que já não existem;
- relatório de erros, avisos e pontuação de prontidão no diagnóstico;
- bloqueio do armamento enquanto existir qualquer erro de configuração;
- confirmação automática opcional de depósitos na gruta;
- segundo armamento separado, temporário e não persistente para gastar prata;
- limite máximo por depósito e orçamento acumulado por sessão;
- desarmamento automático ao expirar o tempo ou esgotar o orçamento;
- validação da alteração da gruta após o clique de confirmação;
- alertas sintéticos nunca podem confirmar depósitos;
- envio automático opcional apenas através da ação `Apoiar`;
- armamento temporário, separado e não persistente para enviar apoios;
- limite de apoios por sessão e margem mínima antes da chegada do ataque;
- seleção das tropas disponíveis antes do envio;
- percentagem configurável de tropas a enviar;
- reserva mínima preservada em cada tipo de unidade;
- mínimo total obrigatório antes de confirmar um apoio;
- cálculo determinístico das quantidades antes de preencher o comando;
- leitura da duração da viagem diretamente na janela de apoio;
- bloqueio de apoios que chegariam depois do ataque;
- margem configurável entre a chegada do apoio e o impacto;
- opção segura para bloquear o envio quando a duração não puder ser detetada;
- validação de que existem unidades selecionadas;
- alertas sintéticos nunca podem enviar apoios;
- a ação `Atacar` nunca é utilizada pela execução automática;
- watchdog, disjuntor e desarmamento manual interrompem também o envio de apoios;
- calculadora passiva de margem de sorte entre `−30%` e `+30%`;
- cálculo da sorte mínima necessária para igualar a defesa;
- cenários comparativos com pior sorte, sorte neutra e melhor sorte;
- aplicação de moral, bónus de ataque e bónus de defesa;
- indicação de vantagem garantida, resultado dependente da sorte ou força insuficiente;
- análise de uma sorte escolhida com relação ataque/defesa e margem absoluta;
- valores da calculadora guardados localmente, sem executar ações no jogo;
- monitorização agregada de todas as cidades carregadas na conta;
- leitura correta da prata através de `town.resources()`;
- seleção assistida da cidade ameaçada;
- abertura e preenchimento assistido da gruta, sem confirmar o depósito;
- preparação manual de desvio para uma cidade segura configurável, sem enviar tropas;
- confirmação visual de que o menu contextual da cidade segura abriu antes de
  considerar o desvio preparado;
- diagnóstico integrado das APIs disponíveis no mundo;
- resultado persistente da última validação assistida no separador Diagnóstico;
- confirmação de que a gruta recebeu exatamente o valor sugerido antes da confirmação manual;
- classificação de ataques, espionagens e apoios;
- contagem decrescente e nível de risco;
- recomendação de prata para a gruta em todas as cidades;
- cálculo do momento recomendado para desviar tropas;
- alertas visuais no painel e registo local, sem notificações do browser;
- modo de simulação e alerta sintético para testes seguros;
- atalhos assistidos para abrir a gruta e a lista de comandos.

## Instalação

1. Instalar Tampermonkey no Chrome.
2. Abrir o painel do Tampermonkey e criar um novo script.
3. Substituir o conteúdo pelo ficheiro `grepolis-assistant.user.js`.
4. Guardar e atualizar a página do Grepolis.

Para mostrar informação temporal nos comandos, instalar também o conteúdo de
`grepolis-attack-info.user.js`. Este script é só leitura: não envia nem cancela
comandos e aceita ataques próprios dirigidos a cidades próprias para teste. Guarda
localmente a hora dos envios próprios e a primeira hora em que cada ataque recebido
é identificado. Nos ataques recebidos usa `started_at` do servidor quando existe e
calcula os perfis NC pela distância entre a cidade atacante e o alvo, incluindo
velocidade do mundo, unidade mais lenta, Cartografia, Farol, Sereias, Atalanta e
Set Sail. Sem `started_at`, mostra `Visto às ...` e `NC: impossível confirmar`, em
vez de inventar a hora de envio.

O botão `GA` aparece no lado direito da página. O modo de simulação está ativo
por defeito.

## Desenvolvimento

```powershell
npm test
npm run check
npm run preview
```

Depois, abrir `http://127.0.0.1:8765/tests/grepolis-replica.html`. A réplica
contém os seletores atuais do cabeçalho, lista de cidades, setas e janela da
gruta, além de testes completos para:

- selecionar Harrenhal, abrir a gruta e preencher `4 706` sem confirmar;
- selecionar Braavos perante um ataque, abrir Highgarden no mapa e apresentar
  `Apoiar/Atacar` sem enviar tropas.
- armar a auto-preparação, tratar um ataque e uma espionagem em sequência e
  confirmar zero depósitos e zero comandos enviados.
- armar separadamente a execução de apoios, selecionar todas as unidades e
  enviar um único comando `Apoiar`, sem utilizar `Atacar`.
- calcular que um ataque de `100 000` contra uma defesa de `110 000` necessita
  de `+10%` de sorte, sem alterar o estado do jogo.

O script guarda apenas preferências e registos no armazenamento local do
Tampermonkey. Não guarda credenciais.

A validação manual acumulada está em `TEST-CHECKLIST.md`.
