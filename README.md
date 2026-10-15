# Engemase Pulse Configurador

Configurador e supervisório local do **gateway** de cada unidade (o antigo Painel):
energia, reservatório de água e grupo gerador diesel em uma interface só, rodando em um
servidor Linux dentro da própria instalação. Funciona sem internet; com a ligação da nuvem
(ver [NUVEM.md](NUVEM.md)), copia as leituras para o **Engemase Pulse**.

```
navegador  ←HTTP/WebSocket→  servidor Node  ←RS-485 Modbus RTU→  9× SMART 7KT (IDs 1-9)
 (qualquer                   (Linux, 8080)   /dev/ttyUSB0         CLP utilidades (ID 10)
  máquina da rede)                                                controlador GMG (ID 11)
```

## Telas

| Tela | Tag | O que mostra |
|---|---|---|
| Energia | QGBT-01 | entrada geral e os 8 alimentadores, com corrente por fase e carga sobre o disjuntor |
| Unifilar | QGBT-01 | rede, grupo gerador, chave de transferência e barramento, com corrente ao vivo |
| Água | TQ-01 | reservatório em corte, nível, volume, bomba de recalque e tendência |
| Gerador | GMG-01 | estado do grupo, parâmetros do motor, tanque de diesel, **bateria e arranque**, **indicadores do período**, últimas partidas e anunciador de falhas |
| Histórico | — | tendência de qualquer grandeza, com as linhas de limite desenhadas |
| Alarmes | — | ativos, reconhecimento e ocorrências recentes |

Água e Gerador só entram no menu quando existem na instalação — loja sem reservatório
não precisa de tela de reservatório. Na hora de instalar é o contrário: o técnico quer a
tela antes do equipamento. Para isso, a configuração manda em cima da regra automática:

```jsonc
"telas": { "gerador": true }   // aparece sempre, com o guia de instalação
"telas": { "agua": false }     // some, mesmo havendo reservatório
```

Energia e Unifilar aparecem sempre. As teclas **1 a 8** trocam de tela (e são ignoradas
enquanto você digita em algum campo). A URL guarda a tela aberta (`#gerador`), o que permite
deixar um monitor de parede fixo em uma delas.

## A interface

O desenho segue a lógica de **HMI de alto desempenho (ISA-101)**, e não a de painel
colorido: em operação normal a tela é cinza e monocromática; vermelho, âmbar e azul
aparecem **apenas** quando algo sai do esperado. O operador aprende que cor significa
problema, e enxerga uma anormalidade do outro lado da sala sem ler número nenhum.

A tipografia acompanha essa lógica e viaja com o produto, sem CDN:
**Archivo** nos títulos e placas (grotesca de sinalização) e **Source Sans 3**
no corpo e nos valores. Os números usam **dígitos tabulares** em vez de fonte
monoespaçada: alinham na coluna sem o aspecto rígido de terminal.

Outras decisões deliberadas:

- **Placas de identificação gravadas** como cabeçalho de cada bloco, com a tag ISA
  (QGBT-01, TQ-01, GMG-01) — a mesma nomenclatura da porta do painel e do projeto elétrico.
- **Cores de fase conforme ABNT**: marrom, preto e cinza para I1, I2 e I3; azul no neutro.
- **Anunciador de falhas** do gerador reproduzindo o painel físico, inclusive a marcação de
  **primeira falha** (a janela que acendeu primeiro fica com "1ª"), que é o que interessa
  na hora de achar a causa raiz de um desarme em cascata.
- **Reservatório e tanque desenhados em corte**, com linha de cota e marcas de limite, no
  estilo de desenho técnico — não como um medidor decorativo.
- Títulos em tipografia condensada e **dígitos tabulares** em todo número, para os valores
  não dançarem na tela a cada atualização.
- Nenhuma fonte, ícone ou biblioteca externa: a interface inteira carrega da própria
  máquina, o que é obrigatório em rede isolada.
- **Teclas 1 a 9 trocam de tela**, para operação com teclado ou painel de bancada.
  O atalho é ignorado enquanto o cursor está em qualquer campo — endereço Modbus,
  nome de equipamento ou senha de comando não trocam a tela por baixo do operador.

## Instalação

```bash
node -v                 # 20 ou superior
cd /opt/painel
npm install             # única etapa que precisa de internet
npm run demo            # dados simulados + roteiro de demonstração, sem equipamento
npm run bancada         # bancada com o CLP FX3U (config.fx3u.json) — ver FX3U.md
node server.js --sem-modbus   # simulação sem roteiro, para testes de comissionamento
npm start               # operação normal
npm run teste           # bateria de testes
npm run orcamento       # estimativa de tempo da varredura na RS-485
```

**Central de operação (várias lojas numa tela, pela VPN):** **[CENTRAL.md](CENTRAL.md)**.

**Envio para a nuvem (Monitor de Energia, acesso do cliente pela internet):** **[NUVEM.md](NUVEM.md)**.

**Servidor Linux, como serviço:** siga o **[LINUX.md](LINUX.md)**. Ele cobre a cópia
pelo SSH, os nomes fixos das portas seriais, o `sudo bash tools/instalar-linux.sh` (que
cria o usuário `supervisorio` e o serviço systemd), o backup e a recuperação de senha
(`node tools/redefinir-senha.js`).

### Modo demonstração

`npm run demo` sobe a planta simulada com um **roteiro**: a caixa d'água trabalha em torno
do limite de nível baixo, o diesel começa abaixo da reserva e, a cada ciclo do gerador, o
motor perde pressão de óleo e o grupo desarma. Serve para apresentar o produto sem
hardware — em poucos minutos o cliente vê alarme abrindo, anunciador acendendo com marcação
de primeira falha, reconhecimento e normalização.

Para simular sem encenação (comissionamento, teste de campo), use
`node server.js --sem-modbus` sem a opção `--roteiro`.

O arquivo `public/demo.html` é a mesma interface empacotada em arquivo único, com o
simulador embutido: abre com dois cliques em qualquer máquina, sem servidor e sem rede.
Ele é gerado como script clássico e sem nenhum recurso externo justamente para funcionar
no protocolo `file://`, onde módulos ES e `history.replaceState` são bloqueados.

> `public/index.html` é o contrário: precisa do servidor no ar, porque busca
> `/api/config` e o WebSocket. Abrir esse arquivo direto do disco não funciona —
> para demonstrar sem servidor, use o `demo.html`.

## Cadastrar equipamentos pela tela

**Engenharia → Equipamentos** edita a instalação sem abrir arquivo: quantidade de
medidores, perfil de cada um, endereço Modbus, meio de comunicação (RS-485 ou Ethernet),
porta serial ou máquina e porta TCP, qual é a entrada geral e a corrente do disjuntor.

O fluxo é o mesmo em toda loja nova:

1. **Varredura do barramento** descobre em que endereço cada equipamento responde — na
   serial ou na rede, conforme o meio escolhido.
2. **Equipamentos → Adicionar** cadastra um por vez, escolhendo o perfil do modelo.
3. **Conferir** valida sem aplicar: endereço repetido, tag inexistente e bloco maior
   que o limite do equipamento são recusados aqui.
4. **Aplicar configuração** troca a leitura a quente, guardando a versão anterior.

O diagrama unifilar é montado a partir disso: quem está marcado como entrada geral
vira o topo, os demais medidores de energia viram alimentadores, e a corrente do
disjuntor vira a escala da barra de carga.

### Seções da instalação

Logo abaixo, **Engenharia → Seções da instalação** preenche o que não é do modelo do
equipamento, e sim daquela loja:

| Seção | Campos |
|---|---|
| Grupo gerador | potência nominal, tanque, consumo de catálogo, teste a cada N dias, código do modo automático, limites de bateria (mínima, flutuação, mínimo e crítico no arranque) e as marcas de nível de diesel |
| Reservatório | capacidade, altura útil, tag ISA e as marcas de nível de água |

O formulário aparece sozinho assim que existe um equipamento do grupo, já preenchido
com os valores usuais do perfil — o técnico só corrige o que é diferente naquela loja.
**Estados, modos e lista de falhas continuam vindo do perfil** e não são graváveis pelo
navegador: o servidor aceita apenas a lista fechada de campos acima, recusa marca fora
de 0 a 100 % e sempre amarra a seção ao equipamento cadastrado. Removeu o equipamento,
a seção some junto.

Ou seja: **para acrescentar o gerador a uma loja não é preciso editar JSON nenhum** —
cadastra o equipamento com o perfil da marca, preenche tanque e consumo, aplica, e a
tela de Gerador passa a funcionar com desenho, anunciador e indicadores.

Enquanto nenhum medidor de energia estiver cadastrado, as telas de Energia e
Unifilar continuam no menu mostrando esse roteiro — elas não somem.

## Várias instalações no mesmo servidor

Cada instalação é um arquivo de configuração. `--config` escolhe qual sobe:

```bash
node server.js                              # config.json (a loja)
node server.js --config config.fx3u.json    # bancada com o CLP FX3U
```

O log de partida mostra qual configuração foi carregada, e cada equipamento com
sua porta, parâmetros seriais e heartbeat — útil para conferir antes de sair do lado
do painel.

As telas seguem a instalação: sem reservatório não há tela de Água, sem gerador não
há tela de Gerador, sem medidor de energia não há Energia nem Unifilar.

## Barramento RS-485

| ID | Equipamento | Tag | Leitura | Atualização |
|---|---|---|---|---|
| 1 | Entrada geral | QGBT-01 | 7KT, input registers, float32 | 2 s |
| 2–9 | Padaria, açougue, ilhas de frios, refrigerados, congelados, climatização, iluminação, carregadores | QD-02…QD-09 | idem | 8 s (rodízio) |
| 10 | CLP de utilidades | TQ-01 | holding registers, int16 + bits | 4 s |
| 11 | Controlador do grupo gerador | GMG-01 | holding registers, int16 + bits | 4 s |

Todos no mesmo par trançado, 9600 8N1, terminador de 120 Ω nas duas pontas.

### Equipamento por Ethernet (Modbus TCP)

A conexão é declarada por equipamento, então a mesma loja mistura os dois meios sem
nada de especial: os medidores seguem na RS-485 e o CLP e o gerador vão para a rede.

```jsonc
"conexao": { "tipo": "tcp", "host": "192.168.10.20", "porta": 502, "unit_id": 1, "timeout_ms": 500 }
```

Perfil, tags, alarmes, comandos e indicadores continuam idênticos — muda só o meio. Em
**Engenharia → Equipamentos** há a coluna **Meio** (RS-485 / Ethernet): trocando, o
formulário passa a pedir máquina e porta, e a configuração gravada não guarda resto do
outro meio. A **Varredura do barramento** também procura pela rede, o que serve de teste
de conexão: se responder, aparece o endereço do escravo e o tempo de resposta.

Cada máquina vira um barramento próprio. Como o coletor lê barramentos diferentes **em
paralelo** e só serializa dentro do mesmo, um equipamento em Ethernet não paga o pedágio
da serial: o limite de 12 registradores por leitura, as tags lentas e o rodízio deixam de
importar para ele. O `unit_id` continua valendo — 1 na maioria dos equipamentos nativos,
ou o número do escravo quando há gateway serial→TCP. Em rede, um `timeout_ms` entre 300 e
800 ms é suficiente; depois de duas falhas seguidas o coletor derruba a conexão e
reconecta sozinho.

> **Modbus TCP não tem autenticação nem criptografia.** Quem alcança a porta 502 manda no
> equipamento. Rede de automação em VLAN dedicada, sem rota da rede da loja nem do Wi-Fi
> de clientes, IP fixo no CLP e o servidor como única máquina com acesso. E vale de novo o
> que está em `FX3U.md`: a trava real do religamento é o contato do relé de proteção — o
> supervisório nunca deve ser o único obstáculo entre a rede e a bobina do disjuntor.

### Por que a varredura não é de 1 segundo

O 7KT aceita no máximo **12 registradores por leitura** e leva até **100 ms** para
responder. Com 11 escravos, ler tudo a cada segundo é fisicamente impossível. Quatro
mecanismos, todos declarados no `config.json`, resolvem:

| Mecanismo | Onde | Efeito |
|---|---|---|
| `max_registradores` | `padrao` | respeita o limite de cada equipamento ao montar os blocos |
| `gap_maximo` | `padrao` | junta registradores vizinhos até encher o bloco |
| `"lento": true` | tag | energia, demanda, THD, horímetro: 1 leitura a cada 20 varreduras |
| `varredura_a_cada` | equipamento | alimentadores se revezam; entrada, CLP e gerador têm prioridade |

Resultado medido por `npm run orcamento`: **1,45 s de varredura** no pior caso do manual
(9600 bps, resposta de 100 ms) e **0,68 s** no caso típico, com `intervalo_leitura_ms` de
2000 ms. O laço é auto-agendado — nunca inicia uma varredura antes de a anterior terminar.

**Para atualizar tudo mais rápido**, divida em dois barramentos: um segundo conversor
USB-RS485 em `/dev/ttyUSB1` para o CLP e o gerador. O servidor lê portas diferentes em
paralelo; basta trocar `porta_serial` nesses dois equipamentos e tirar o `varredura_a_cada`.

## Mapa dos equipamentos

### Multimedidor Siemens SMART 7KT0310

Leitura em `3xxxx` → **função 04**, `float32` em 2 registradores, no máximo 12 por
leitura. O campo `endereco` é a coluna "Endereço Hex" do manual, em decimal (30001 = 0).
**O float vem com a palavra baixa primeiro (CDAB).** Lido como ABCD a partir do
endereço + 1 (como fazia o fluxo antigo do Node-RED) os valores *parecem* certos — a
metade alta é a da grandeza certa —, mas a metade baixa vem da grandeza seguinte: a
tensão erra uns décimos e a energia só anda em degraus de 1024 kWh.

| Grandeza | End. | Grandeza | End. |
|---|---|---|---|
| V1N / V2N / V3N | 0 / 2 / 4 | FP médio | 54 |
| V12 / V23 / V31 | 8 / 10 / 12 | Frequência | 56 |
| I1 / I2 / I3 | 16 / 18 / 20 | kWh importado / líquido | 96 / 58 |
| kvarh | 62 | kVAh (energia aparente) | 60 |
| Corrente de neutro | 122 | Demanda máx. kW | 64 |
| kW / kVA / kvar totais | 42 / 44 / 46 | THD V1 / V2 / V3 | 124 / 126 / 128 |
| kWh importado por fase | 84 / 86 / 88 | THD I1 / I2 / I3 | 136 / 138 / 140 |

Conferido numa varredura do medidor real (`tools/ler-registros.js`): médias, somas por
fase e FP batem entre si (ex.: kWh 84+86+88 = 96; FP2 = kW2 / kVA2), e o neutro lido no
122 (12,5 A) é coerente com a soma vetorial das três fases.

Endereço duvidoso se acha pelo display: `node tools/ler-registros.js --porta /dev/ttyUSB0
--unit 1` (com o serviço parado) lista todos os floats do medidor — procure o valor que o
display mostra.

### CLP de utilidades (ID 10) — o que programar

O CLP precisa expor um bloco contíguo de **holding registers**:

| Reg. | Conteúdo | Formato |
|---|---|---|
| 0 | nível do reservatório | int16, 0–1000 = 0–100,0 % |
| 1 | coluna d'água | int16, centímetros |
| 2 | vazão de entrada | int16, 0,1 m³/h |
| 3 | pressão de recalque | int16, 0,1 mca |
| 6–7 | horímetro da bomba | uint32, horas |
| 10 | palavra de status | bits |

Palavra de status (registrador 10):

| Bit | Significado | Bit | Significado |
|---|---|---|---|
| 0 | bomba de recalque ligada | 3 | boia de nível alto atuada |
| 1 | falha da bomba | 4 | falha do sensor de nível |
| 2 | boia de nível baixo atuada | 5 | bomba em automático |

> Endereços não mapeados **dentro** de um bloco fazem o CLP responder exceção 02 e
> derrubam a leitura inteira. Por isso o `gap_maximo` do CLP e do gerador é 4: o coletor
> não atravessa buracos grandes no mapa.

### Controlador do grupo gerador (ID 11)

| Reg. | Conteúdo | Reg. | Conteúdo |
|---|---|---|---|
| 0–2 | tensões V1-2, V2-3, V3-1 | 12 | nível de diesel (0,1 %) |
| 3–5 | correntes I1, I2, I3 | 14–15 | horímetro (uint32) |
| 6 | frequência (0,1 Hz) | 20 | estado (0 parado … 5 em falha) |
| 7 | potência (0,1 kW) | 21 | modo (0 manual, 1 auto, 2 teste) |
| 8 | rotação (rpm) | 22 | bits: 0 disjuntor fechado, 1 rede presente |
| 9 | tensão de bateria (0,1 V) | 23 | bits de falha |
| 10 | pressão de óleo (0,1 bar) | | |
| 11 | temperatura da água (°C) | | |

Bits de falha do registrador 23: 0 partida · 1 sobrevelocidade · 2 baixa pressão de óleo ·
3 alta temperatura · 4 bateria fraca · 5 nível crítico de combustível · 6 parada de
emergência · 7 falha do carregador · 8 sobrecarga · 9 tensão fora da faixa.

Cada bit vira uma janela do anunciador e um alarme, com o texto vindo do `rotulo` da tag —
para adaptar a outro controlador, mexe-se só no `config.json`.

## Indicadores do grupo gerador

Um gerador passa quase todo o tempo parado, então o valor instantâneo diz pouco. A
pergunta que interessa é **"ele vai pegar quando a rede cair?"**, e ela só se responde
com histórico. O supervisório registra **uma linha por corrida** (da partida até parar)
e calcula, sozinho:

| Indicador | Como é obtido | Para que serve |
|---|---|---|
| Prontidão | fração do tempo em que o grupo esteve em automático, sem falha, com diesel acima do crítico e bateria acima do mínimo | é o número que vai para o relatório mensal |
| Partidas e falhas de partida | corrida que girou mas não assumiu carga conta como falha | mostra problema antes de faltar energia |
| Queda de bateria no arranque | mínima da tensão durante o cranking, corrida a corrida | **o melhor indicador de bateria no fim da vida** |
| Horas e energia gerada | duração das corridas e integral da potência | rateio de custo e plano de manutenção por horas |
| Consumo medido (L/h) | litros pela queda de nível ÷ horas em carga | o número real, não o de catálogo |
| Autonomia | diesel no tanque ÷ consumo medido | quanto tempo a loja aguenta |
| Tempo de partida | da partida até fechar o disjuntor | motor que demora a pegar está avisando |
| Dias sem partir | desde o fim da última corrida | teste semanal é o que evita a surpresa |

### Por que a bateria ganha bloco próprio

Bateria é a causa nº 1 de gerador que não parte. Parada, uma bateria ruim mostra 26 V
como uma boa — a diferença só aparece quando o motor de partida puxa centenas de
ampères e a tensão despenca. O painel guarda essa mínima a cada arranque e desenha a
série: enquanto as barras ficam acima do mínimo, está tudo bem; quando começam a descer,
a bateria está avisando com semanas de antecedência. Os limites saem da configuração
(`bateria_partida_min_v`, padrão 20 V, e `bateria_partida_critica_v`, padrão 18 V, para
sistema de 24 V).

### Tags calculadas

Quatro grandezas não vêm do barramento: o supervisório as calcula e as trata como
qualquer outra tag — vão para o histórico, para a tendência e podem virar alarme.

| Tag | Conteúdo |
|---|---|
| `pronto` | 1 quando o grupo consegue partir agora (automático, sem falha, com diesel e bateria) |
| `autonomia_h` | horas restantes no consumo medido |
| `diesel_litros` | nível convertido pela capacidade do tanque |
| `dias_sem_teste` | dias desde a última partida |

Dois alarmes nascem daí automaticamente: **grupo indisponível** (prioridade alta, com
2 min de atraso para não tocar durante manutenção) e **sem partir há mais de N dias**
(prioridade baixa). Para desligá-los, ponha `"alarmes_de_indicador": false` na seção
`gerador`.

### O que o controlador precisa expor

Os indicadores funcionam com qualquer marca, desde que o perfil dê estes nomes de tag:
`estado`, `modo`, `nivel_diesel`, `tensao_bateria`, `potencia`, `rede_presente`,
`disjuntor_fechado` e os bits `falha_*`. É por isso que o mapa de registradores muda de
marca para marca, mas a tela e os indicadores não. Falta alguma? O indicador que depende
dela aparece como `––`; os outros continuam funcionando.

### Ver funcionando sem esperar semanas

```bash
node tools/semear-gerador.js --semanas 12     # histórico plausível para demonstração
node server.js --config config.gerador.json --sem-modbus
```

A ferramenta se recusa a semear um banco que já tenha corridas de verdade.

## Configuração de tags

```jsonc
{ "nome": "nivel", "rotulo": "Nível", "unidade": "%",
  "endereco": 0,        // registrador conforme o manual do equipamento
  "tipo": "int16",      // int16, uint16, int32, uint32, float32, float64, bool
  "funcao": "holding",  // holding (03), input (04), coil (01), discreta (02)
  "bit": 3,             // extrai um bit do registrador (palavras de status)
  "ordem_palavras": "ABCD",  // ABCD, CDAB, BADC, DCBA
  "escala": 0.1,        // multiplicador aplicado ao valor bruto
  "offset": -22.64,     // somado depois da escala (sensor 4-20 mA)
  "limitar": [0, 100],  // corta o valor já escalonado na faixa útil
  "severidade": "info", // digitais: info (estado normal), media, alta
  "inverso": true,      // digitais: a condição anormal é o bit DESLIGADO
  "lento": true,        // lido a cada 20 varreduras, não a cada uma
  "oculto": true,       // fora dos cartões, mas presente no histórico e nos alarmes
  "decimais": 1 }
```

## Alarmes

Três tipos de regra:

```jsonc
{ "tag": "clp.nivel", "min": 15, "prioridade": "alta",
  "mensagem": "Caixa d'água em nível crítico", "atraso_s": 30 }

{ "tag": "gmg.falha_pressao_oleo", "digital": true, "prioridade": "alta",
  "mensagem": "Gerador: baixa pressão de óleo" }

{ "medidor": "clp", "comunicacao": true, "prioridade": "alta",
  "mensagem": "Sem comunicação com o CLP de utilidades", "atraso_s": 15 }
```

- `atraso_s` — a condição precisa se manter por esse tempo para o alarme abrir. É o que
  impede que um pico de leitura ou uma boia balançando gerem alarme.
- Banda morta de 1% nas regras analógicas: para normalizar, o valor precisa voltar para
  dentro da faixa com folga.
- `digital` com `"inverso": true` alarma quando o bit **desliga** (ex.: bomba fora do automático).
- Quando um equipamento perde comunicação, só o alarme de comunicação abre — as regras de
  processo daquele equipamento ficam suspensas, em vez de disparar tudo de uma vez.
### Sirene, silenciar e reconhecer

A sequência é a de um anunciador de painel, e não um bipe solto:

| Ação | O que acontece |
|---|---|
| Alarme entra | a faixa pulsa e a sirene **repete** (3 s em alarme alto, 9 s em médio) |
| **Silenciar** | cala a sirene daquele conjunto; o visual continua chamando |
| Alarme **novo** entra | o conjunto mudou, então a sirene **volta a tocar** |
| **Reconhecer** | a faixa recua para aviso discreto e a sirene cala |
| Condição normaliza | o alarme sai sozinho, reconhecido ou não |

Silenciar nunca desarma o anunciador para o resto do turno: é por ocorrência.
O botão **Som** da coluna é a chave do posto, essa sim permanente.

## Acionamento

O bloco **Acionamento** fica nas telas de **Energia** e de **Unifilar**.

Comandos de saída (ligar e desligar disjuntor, por exemplo) são declarados no
perfil do equipamento e passam por sete camadas antes de escrever:

1. a instalação precisa ter `seguranca.comandos_liberados: true`;
2. o comando declara o **papel mínimo** de quem pode acioná-lo;
3. os **intertravamentos** são avaliados no servidor contra a última leitura —
   a tela desabilita o botão por conveniência, mas quem decide é o servidor;
4. **dois toques**: o primeiro arma, o segundo executa, com prazo de 8 s e uma
   espera mínima de 400 ms entre um e outro — a confirmação tem que ser um segundo
   gesto humano, e não o mesmo toque chegando duas vezes;
5. com `exige_senha`, o segundo toque pede a **senha do próprio operador** — a
   sessão sozinha não abre disjuntor. A senha vai só naquela requisição, não é
   guardada, não entra na auditoria, e errá-la não derruba a sessão;
6. depois de escrever, o resultado é conferido pela **realimentação** do
   equipamento — comando aceito não é comando cumprido;
7. tudo vai para a **auditoria**, inclusive o que foi recusado e por quê.

```jsonc
{ "nome": "desligar", "rotulo": "Desligar disjuntor", "papel": "tecnico",
  "endereco": 100, "valor": 2, "perigoso": true,
  "intertravamentos": [
    { "tag": "modo_remoto",      "igual": 1, "senao": "CLP em LOCAL — comando bloqueado" },
    { "tag": "disjuntor_ligado", "igual": 1, "senao": "O disjuntor já está desligado" }
  ],
  "confirma_com": { "tag": "disjuntor_ligado", "igual": 0, "prazo_s": 10 } }
```

### Condição por lista: religar só em certas faltas

Além de `igual`, `min` e `max`, um intertravamento aceita lista:

```jsonc
{ "tag": "causa_disparo", "fora_de": [1, 4, 5, 6, 7],
  "senao": "Disparo por {valor} exige inspeção antes de religar" }
```

`fora_de` bloqueia os códigos listados, `em` libera só os listados, e `{valor}`
vira o texto do `enum` declarado na tag — o operador lê "Disparo por
sobrecorrente", não "causa_disparo = 1". É assim que se permite religamento
remoto em sobretensão e se exige ida ao painel em sobrecorrente.

Isso é a explicação para o operador, **não a segurança**: a trava que vale é um
contato do relé de proteção habilitando o comando no CLP (`permite_religar` no
perfil). Use as duas juntas — ver `FX3U.md`, seção *Religamento por tipo de
falha*, e o perfil `perfis/clp-fx3u-disjuntor-protecao.json`.

Em instalação só de monitoramento, deixe `comandos_liberados: false`.

### Bloqueio de senha e proxy reverso

Senha errada bloqueia por **origem** (após `tentativas_ate_bloquear` erros) e por
**conta** (após o dobro), com espera que dobra a cada novo bloqueio. A senha pedida
nos comandos bloqueia pela conta de quem está logado.

A origem é o endereço da conexão. O cabeçalho `X-Forwarded-For` só é considerado
quando a conexão vem de um proxy declarado — sem isso, qualquer cliente trocaria
o cabeçalho para escapar do bloqueio e falsificar a auditoria:

```jsonc
"seguranca": { "proxies_confiaveis": ["127.0.0.1"] }   // nginx na mesma máquina
```

### HTTPS

Sem criptografia, a senha do login e a senha pedida nos comandos passam pela
rede da loja em texto aberto. O configurador serve HTTPS sozinho, sem proxy:

```bash
npm run certificado                          # endereços desta máquina
npm run certificado -- 192.168.8.109 painel.local
```

O certificado (autoassinado, ECDSA P-256, 825 dias) vai para `dados/tls/`. Depois:

```jsonc
"seguranca": {
  "tls": { "certificado": "dados/tls/painel.crt", "chave": "dados/tls/painel.key" }
}
```

Com `tls`, o configurador atende em `https://` na mesma `porta_http`, o cookie de sessão
passa a ser `Secure` e o tempo real usa `wss://`. O certificado é lido na partida:
trocá-lo pede reiniciar o serviço. Na primeira visita o navegador avisa que o
certificado não é de uma autoridade conhecida; para o aviso sumir de vez, importe
o `painel.crt` como autoridade confiável em cada posto da loja. Se já houver um
proxy com TLS na frente, deixe `tls` de fora e use `"https": true`, que só marca o
cookie como `Secure`.

### Um acionamento por vez

O servidor aceita um comando de cada vez na planta inteira: enquanto um aguarda
a realimentação, os outros são recusados com o nome de quem acionou e do quê, e
a tela de acionamento mostra o comando em andamento. Sem isso, dois comandos
simultâneos deixariam a confirmação ambígua — não se saberia a qual deles o
equipamento respondeu.

O banco reconcilia o que estava aberto ao reiniciar o servidor: o alarme não é duplicado
nem perdido.

## API

| Rota | Devolve |
|---|---|
| `GET /api/config` | equipamentos, tags, unifilar, reservatório, gerador e limites |
| `GET /api/valores` | última varredura completa |
| `GET /api/historico?tag=geral.potencia_ativa&horas=24` | série agregada em mín/méd/máx |
| `GET /api/alarmes` | ativos e histórico |
| `POST /api/alarmes/reconhecer` | `{}` reconhece todos, `{"id":12}` reconhece um |
| `GET /api/eng/equipamentos` | lista para o editor (técnico) |
| `POST /api/eng/equipamentos` | grava a lista; `apenas_validar: true` só confere (técnico) |
| `GET /api/gerador/indicadores?dias=30` | prontidão, partidas, bateria, consumo e as últimas corridas |
| `GET /api/comandos` | comandos e o que impede cada um agora |
| `POST /api/comandos/executar` | aciona; exige `confirmado: true`, o papel do comando e, quando `exige_senha`, a senha do operador |
| `WS /ws` | empurra a varredura para todas as telas abertas |

Histórico em SQLite, gravado a cada 15 s, expurgo automático em 90 dias.
Ordem de grandeza: ~90 tags a cada 15 s ≈ 450 MB por ano.

## Testes

`npm run teste` roda 412 verificações sem depender de rede, hardware ou navegador:

- decodificação de todos os tipos e ordens de palavras;
- agrupamento de blocos respeitando o limite de cada equipamento e cobrindo todas as tags;
- extração de bits de palavras de status;
- motor de alarmes: atraso, histerese, digital direto e invertido, falha de comunicação,
  condição intermitente e reinício do servidor;
- coerência do simulador (a entrada fecha com a soma dos alimentadores em 260 ciclos);
- integridade do `config.json` (tags e endereços Modbus existentes e sem repetição);
- integridade da casca: todo id que o código procura existe na página, e ninguém
  reintroduziu cache com prazo (que mistura página antiga com código novo);
- desenhos: a parede do tanque não pode ter preenchimento, as barras de fase precisam
  ser bloco, e as marcas de limite não podem colidir com a logomarca;
- acionamento: cada intertravamento, a senha exigida no momento de acionar, e o
  religamento seletivo — sobretensão libera, sobrecorrente bloqueia, e nenhuma
  das duas barreiras destrava sozinha;
- atalhos de teclado: número digitado em campo de texto não troca de tela;
- acionamento: o bloco de comandos é executado sobre um DOM de teste, trocando de tela
  várias vezes, para garantir que um clique nunca vire dois e que sair da tela desligue
  os ouvintes;
- gerador: a máquina de corridas (partida, falha de partida, desarme, reinício do
  servidor no meio da corrida) e cada indicador do período;
- seções de tela: nascem do perfil, a loja vence o perfil, e o servidor só grava a
  lista fechada de campos que vem do formulário;
- conexão por Ethernet: endereço repetido na mesma máquina é recusado mas o mesmo
  endereço em máquinas diferentes passa, e trocar de meio não deixa resto do outro;
- e, por fim, a interface inteira é executada sobre um DOM mínimo, trocando todas as
  telas, para pegar erro de execução antes de chegar no cliente.

## Arquivos

```
server.js                     HTTP, WebSocket e laço de varredura
config.json                   a loja: equipamentos, alarmes e desenhos
config.fx3u.json              bancada com o CLP FX3U (--config)
config.protecao.json          bancada com religamento seletivo por tipo de falha
config.gerador.json           bancada do grupo gerador e dos indicadores
perfis/*.json                 mapa de registradores por modelo de equipamento
src/mapa.js                   tipos, ordem de palavras, bits e blocos (sem driver)
src/modbus.js                 barramentos, fila serializada e rodízio
src/alarmes.js                motor de alarmes
src/gerador.js                indicadores do grupo gerador (corridas e tags calculadas)
src/nuvem.js                  cópia das leituras para a nuvem (só com "nuvem" na configuração)
src/db.js                     histórico e registro de alarmes em SQLite
src/simulador.js              planta simulada para o modo --sem-modbus
public/index.html             casca da interface
public/assets/estilo.css      identidade visual
public/assets/fontes/         Archivo e Source Sans 3 (SIL OFL), servidas localmente
public/assets/nucleo.js       estado, vínculos de dados e conexão
public/assets/grafico.js      gráfico de tendência em canvas
public/assets/telas/*.js      uma tela por arquivo
public/demo.html              demonstração autocontida, abre sem servidor
tools/gerar-demo.js           empacota a interface em arquivo único
tools/orcamento.js            estimativa de tempo da RS-485
tools/semear-gerador.js       histórico de gerador para demonstração
testes/                       bateria de testes
```

## Comissionamento

1. Endereço Modbus diferente em cada equipamento (1 a 11) — endereço repetido é a falha
   número um em RS-485: dois escravos respondem juntos e colidem.
2. Mesma velocidade, paridade e stop bits em todos.
3. Relação de TC programada em cada 7KT — sem isso a corrente vem errada mesmo com a
   comunicação perfeita.
4. Terminador de 120 Ω nas duas pontas do tronco.
5. Teste do link antes de subir o serviço:
   `mbpoll -m rtu -b 9600 -P none -a 1 -r 1 -c 8 -t 3:float /dev/ttyUSB0`
   (pare o serviço antes: só um programa por vez abre a porta serial).
6. Ajuste limites de alarme, correntes de disjuntor e capacidades do reservatório e do
   tanque conforme o projeto da instalação. Os valores do `config.json` são de partida.

### Se os valores vierem errados

| Sintoma | Ajuste |
|---|---|
| Exceção "illegal function" ou timeout | troque `"funcao": "input"` por `"holding"` |
| Números absurdos (1e-38, 3e38) | troque `"ordem_palavras"` de `ABCD` para `CDAB` |
| Tudo deslocado uma casa | use `endereco - 1` (manual em base 1) |
| Exceção "illegal data address" | bloco maior que o limite, ou buraco no mapa: reduza `gap_maximo` |
| Um equipamento cai e volta | derivação longa demais, ou A/B invertidos nesse ponto |
