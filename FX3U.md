# CLP FX3U — conversão do flow Node-RED

O `perfis/clp-fx3u-disjuntor.json` reproduz o que o seu flow lia, com os mesmos
endereços, as mesmas funções Modbus e a mesma escala de sensor.

## Rodar em modo real no Windows

```
cd C:\painel
npm install
npm run bancada
```

Antes disso, **confirme a porta COM**: Gerenciador de Dispositivos → Portas (COM e LPT),
com o conversor espetado. No flow a porta era COM7; se for outra, altere
`porta_serial` em `config.fx3u.json`. Acima de COM9 o nome precisa do prefixo longo:
`"\\\\.\\COM10"`.

Se preferir ver as telas antes de ligar no CLP:

```
npm run bancada-demo
```

Ao subir pela primeira vez, o console mostra a **senha temporária do admin**.
Ela aparece uma única vez — copie antes de fechar a janela.

O log de partida confirma o que foi carregado:

```
1 equipamentos · varredura a cada 1000 ms
configuração: config.fx3u.json
    1  CLP FX3U                   COM7 9600 8N1  heartbeat D101
```

> Só um programa por vez abre a porta serial. Feche o Node-RED, o Modbus Poll ou
> o QModMaster antes de subir o supervisório.

## O que foi convertido

| No flow | No supervisório |
|---|---|
| `Ler X0-X7 (FC2)`, adr 0 | 8 tags `discreta` nos endereços 0–7 |
| X0 → `ligado` | `disjuntor_ligado`, severidade **info** |
| X1 → `falha` | `disjuntor_falha`, severidade **alta**, vira alarme |
| X2 → `remoto` | `modo_remoto`, lógica **invertida**: alarma em LOCAL |
| `Ler Y0-Y7 (FC1)`, adr 0 | 8 tags `coil` nos endereços 0–7 |
| `Ler nivel (FC3)`, adr 212 | `nivel` em holding 212, com escala |
| Função `Escalonar nivel` | `escala` + `offset` + `limitar` na própria tag |
| Aviso "fio rompido" | tag `nivel_bruto` + alarme de faixa |
| `D101 = heartbeat` | bloco `heartbeat` do perfil |
| `D100 = comando (FC6)` | botões **Ligar** e **Desligar** com intertravamento — ver abaixo |

### A escala do sensor

A conta da sua função virou dois campos na tag, o que dispensa código:

```
escala = (MAX - MIN) / (RAW_MAX - RAW_MIN) = 100 / (4095 - 756) = 0,029949087
offset = MIN - RAW_MIN × escala                                 = -22,641509
```

Conferido: 756 → 0,00 % · 2425 → 50,0 % · 4095 → 100,0 %.

O `"limitar": [0, 100]` faz o papel do `Math.max(0, Math.min(100, pct))` do flow —
sem ele a tela mostraria −1,7 % quando o sensor cai um pouco abaixo dos 4 mA.

**Trocou o sensor?** Recalcule com a fórmula acima e substitua os dois números.
Para um sensor de 0–10 V, `RAW_MIN` passa a ser 0.

### Detecção de fio rompido

O flow imprimia um aviso de texto. Aqui a mesma condição virou alarme de verdade,
com registro e histórico: a tag `nivel_bruto` lê **o mesmo registrador sem escala**
(entra na mesma requisição, não custa nada no barramento) e duas regras vigiam a
faixa do laço de 4-20 mA:

| Bruto | O que significa | Prioridade |
|---|---|---|
| abaixo de 706 | laço aberto — fio rompido ou sensor desconectado | alta |
| acima de 4145 | sensor acima da faixa, ou escala errada | média |

### Heartbeat

Se o programa do CLP vigia o supervisório, trocar o Node-RED sem manter a prova
de vida derrubaria o watchdog. O perfil preserva isso:

```jsonc
"heartbeat": { "endereco": 101, "intervalo_s": 5, "maximo": 30000 }
```

O contador é escrito por FC6 a cada 5 s, exatamente como no flow. Se o seu CLP
**não** vigia nada, desligue no equipamento com `"heartbeat": false`.

Essa escrita é declarada em configuração e vai para um registrador fixo, então
funciona mesmo com `escrita_modbus_liberada: false` — essa chave trava apenas a
escrita manual pelo terminal de engenharia.

## Comando de liga/desliga

Convertido, com a mesma lógica da sua função `Validar comando` — só que declarada
no perfil e avaliada **no servidor**:

```jsonc
{ "nome": "ligar", "rotulo": "Ligar disjuntor",
  "papel": "tecnico",
  "endereco": 100, "valor": 1,              // D100 = 1, como no flow
  "intertravamentos": [
    { "tag": "modo_remoto",      "igual": 1, "senao": "CLP em LOCAL — comando bloqueado" },
    { "tag": "disjuntor_falha",  "igual": 0, "senao": "Proteção disparada — rearme no painel" },
    { "tag": "disjuntor_ligado", "igual": 0, "senao": "O disjuntor já está ligado" }
  ],
  "confirma_com": { "tag": "disjuntor_ligado", "igual": 1, "prazo_s": 10 } }
```

O botão fica nas telas de **Energia** e de **Unifilar**, no bloco **Acionamento**
— é lá que o operador está olhando quando decide abrir ou fechar disjuntor. As
duas telas mostram o mesmo bloco e o mesmo estado.

### As travas

| Camada | O que faz |
|---|---|
| `comandos_liberados` | a instalação precisa liberar; em `false` nem a rota existe |
| Papel | cada comando declara o perfil mínimo (aqui, **técnico**) |
| Intertravamento | avaliado no servidor contra a última leitura, não no navegador |
| Dois toques | o primeiro arma, o segundo executa; passa de 8 s, desarma sozinho |
| Espera mínima | confirmação em menos de 400 ms é ignorada — duplo clique, tecla presa ou toque repicando não confirmam |
| Senha | com `exige_senha`, o segundo toque só sai com a senha do próprio operador |
| Realimentação | depois de escrever, confere se o CLP obedeceu em até 10 s |
| Auditoria | enviado, confirmado, negado e falhou, com usuário, hora e origem |

O botão fica desabilitado enquanto houver impedimento, **com o motivo escrito ao
lado** — o operador não fica adivinhando por que não pode acionar.

A revalidação no servidor não é formalidade: uma aba aberta há meia hora, ou uma
requisição forjada, não conseguem mandar o que o processo não permite naquele
instante.

### Senha no momento de acionar

Comando com `"exige_senha": true` pede a senha **do operador logado** na hora de
confirmar. Não é a sessão: é o posto deixado aberto que isso protege — ninguém
abre disjuntor porque o técnico saiu para o almoço sem travar a tela.

* a senha vai só naquela requisição, não é guardada em lugar nenhum e **não entra
  na auditoria** (a auditoria registra que houve comando e quem o fez);
* senha errada conta para o mesmo bloqueio progressivo do login — depois de
  algumas tentativas, o comando fica travado por alguns minutos;
* errar a senha **não derruba a sessão**: o operador continua na tela, só com o
  aviso de senha incorreta.

### Religamento por tipo de falha

Foi para isso que o perfil `clp-fx3u-disjuntor-protecao.json` existe. A regra: há
falta que se religa remoto (sobretensão, subtensão — a rede oscilou, o disjuntor
abriu, religou-se) e há falta que **ninguém** religa de longe (sobrecorrente,
curto, falta à terra: pode haver cabo no chão, painel queimado, gente no local).

São duas informações diferentes, e o produto usa as duas:

| | Vem de | Serve para |
|---|---|---|
| `permite_religar` (X3) | contato do relé de proteção | **é a trava.** Quem decide é o relé, dispositivo certificado |
| `causa_disparo` (D30) | código escrito pelo CLP | **é informação.** Explica ao operador e fica no histórico |

```jsonc
"intertravamentos": [
  { "tag": "permite_religar", "igual": 1,
    "senao": "Proteção não libera religamento remoto — inspeção e rearme no painel" },
  { "tag": "causa_disparo", "fora_de": [1, 4, 5, 6, 7],
    "senao": "Disparo por {valor} exige inspeção antes de religar" }
]
```

`fora_de` bloqueia a lista; `em` faz o contrário e libera só o que estiver nela.
`{valor}` na mensagem é trocado pelo texto do `enum` da tag, então o operador lê
**"Disparo por sobrecorrente exige inspeção antes de religar"**, não um código.

**Sobre a dúvida de projeto (passar os dados do relé direto ou fazer a lógica no
CLP):** faça as duas, e não confie só no código. O supervisório não pode ser a
única barreira — um defeito de software, uma aba antiga ou um acesso ao CLP por
outro caminho religariam sobre falta. O contato seco do relé habilitando o
comando no CLP é a trava que vale; o código da causa é o que faz a tela explicar
o motivo em vez de só dizer "bloqueado". O perfil já vem com as duas, e o teste
`causa não religável bloqueia mesmo com o permissivo fechado` existe justamente
para garantir que nenhuma das duas sozinha destrava.

### Quando o CLP não obedece

Mandar o comando não é o mesmo que ele ter surtido efeito. Se `disjuntor_ligado`
não mudar no prazo, a tela diz **"Comando enviado, mas o equipamento não confirmou
em 10 s. Verifique no painel"** e a auditoria registra `comando_sem_confirmacao`.
Um supervisório que dissesse "pronto" sem conferir seria pior que não ter botão.

### Comando em duas palavras (valor + complemento)

Hoje o comando é **uma palavra**: D100 = 1 liga, D100 = 2 desliga. Ruído na
RS-485 sozinho dificilmente vira um "desligar": todo quadro Modbus RTU leva CRC-16,
que pega com certeza qualquer rajada de até 16 bits trocados, e o CLP descarta o
quadro com CRC errado. O risco real de uma palavra só é outro — **alguém escrever
2 no D100 sem querer**: um endereço errado no terminal de engenharia, um heartbeat
configurado no registrador errado, outro programa (Node-RED, Modbus Poll) esquecido
na mesma porta, ou o D100 guardando o último valor e o CLP reexecutando depois de
voltar de uma queda de energia.

A defesa é o CLP só obedecer a um **par que ninguém escreve por acaso**: o código
e o seu inverso bit a bit, chegando juntos no mesmo quadro:

| Comando | D102 | D103 (complemento) |
|---|---|---|
| ligar | 1 | 65534 (−2) |
| desligar | 2 | 65533 (−3) |

A ideia dos "dois bits para ligar e dois para desligar" vai na mesma direção, mas o
complemento é mais forte: dois bits iguais (1 e 1) podem sair juntos de um único
erro (uma escrita de 0xFFFF, uma escrita múltipla no endereço errado); um valor e
o seu inverso só saem de quem montou o comando de propósito. Se mesmo assim
preferir bits, o perfil aceita `"funcao": "coil", "valores": [1, 1]`, escritos num
quadro só (FC15).

**No perfil** (fora do D101, que é o heartbeat — o servidor recusa sobreposição):

```jsonc
{ "nome": "desligar", "funcao": "holding", "endereco": 102, "valor": 2, "complemento": true, ... }
{ "nome": "ligar",    "funcao": "holding", "endereco": 102, "valor": 1, "complemento": true, ... }
```

O supervisório escreve D102 e D103 **num único quadro FC16** — as duas palavras
chegam juntas ou nenhuma chega, e o CLP as vê no mesmo scan.

**No CLP** (lista de instruções do GX Works2; troque M100/M101 pela sua lógica de
saída):

```
LD   M8000
CML  D102 D110        ; D110 = inverso bit a bit de D102

LD=  D103 D110        ; o par confere?
AND= D102 K1          ; código 1 = ligar
AND  X002             ; chave em REMOTO
ANI  X001             ; proteção não disparada
PLS  M100             ; pulso de ligar

LD=  D103 D110
AND= D102 K2          ; código 2 = desligar
AND  X002
PLS  M101             ; pulso de desligar

LD<> D102 K0          ; chegou qualquer coisa…
OR<> D103 K0
ZRST D102 D103        ; …executada ou recusada, o par é zerado no mesmo scan
```

Três detalhes importam:

* **zerar sempre** — o comando vira pulso. Nada fica "armado" no registrador para
  ser reexecutado depois;
* **D102/D103 fora da faixa retentiva** (no FX3U, D0–D199 não são retentivos por
  padrão): depois de uma queda de energia o par volta zerado;
* **o intertravamento continua no CLP** (REMOTO, sem falha). O do supervisório
  explica ao operador; o do CLP é o que vale.

Mude o CLP e o perfil **juntos**: com o perfil em D102/D103 e o CLP ainda lendo
D100, o botão não faz nada (e a tela avisa que o equipamento não confirmou).

### O que acontece no barramento durante um comando

* **uma conversa por vez**: tudo que fala na mesma porta (varredura, heartbeat,
  terminal, comando) passa por uma fila única — dois quadros nunca se sobrepõem no
  par trançado. `COM7`, `com7` e `\\.\COM7` são reconhecidos como a mesma porta;
* **o comando fura a fila**: não espera o ciclo de varredura terminar, sai logo
  depois do quadro que estiver no fio (interromper esse quadro, isso sim, causaria
  colisão);
* **o barramento fica reservado** do envio até a realimentação: a varredura dos
  outros equipamentos daquela porta espera (eles mantêm o último valor e não são
  dados como sem comunicação). O heartbeat continua — o watchdog do CLP não pode
  vencer no meio de um comando;
* **um comando por vez** na planta: um segundo acionamento é recusado com o nome
  de quem está acionando o quê;
* **o eco da escrita é conferido**: pela norma o CLP responde repetindo endereço e
  valor. Eco com **outro endereço** é resposta de outra conversa e a escrita não
  conta como feita. Eco com o endereço certo e **outro valor** não derruba o
  comando — o FX3U da bancada responde sempre 184 no campo de valor e obedece
  normalmente. A divergência vai para a auditoria (`comando_eco_divergente`, com os
  bytes crus do pedido e da resposta), e quem confirma o comando é a realimentação;
* **silêncio entre quadros**: pelo menos 3,5 caracteres (5 ms a 9600 bps) entre um
  pedido e o próximo, e 150 ms depois de um timeout — o escravo que se atrasou pode
  ainda estar respondendo. Os bytes que chegarem fora de hora são descartados antes
  do pedido seguinte, para uma resposta velha nunca ser lida como nova. Ajustáveis
  na `conexao`: `intervalo_entre_quadros_ms` e `silencio_apos_falha_ms`;
* **o terminal de engenharia não escreve** em registrador de comando nem de
  heartbeat: comando só sai pelo bloco de acionamento, com todas as travas.

### Para desligar os comandos

Em instalação só de monitoramento, ponha `"comandos_liberados": false` na seção
`seguranca`, ou `"comandos": false` no equipamento. Os botões somem e a rota recusa.

## O que você vê na tela

Como esta bancada ainda não tem medidor de energia nem gerador, a tela de
**Gerador** não aparece. **Energia** e **Unifilar** continuam no menu, mostrando
o roteiro para cadastrar os medidores em Engenharia.

A tela de Água mostra:

- o reservatório em corte, com o nível e as marcas de limite;
- nível em % e volume em litros;
- o anunciador com as janelas que vieram do perfil — disjuntor ligado, proteção
  disparada, comando em REMOTO e as saídas Y0 e Y1. Verde é estado normal de
  operação; vermelho e âmbar só aparecem em anormalidade;
- o bloco **Acionamento**, com os botões de ligar e desligar o disjuntor;
- a tendência do nível, com as linhas de limite desenhadas.

As entradas X3–X7 e as saídas Y2–Y7 estão mapeadas mas marcadas `"oculto": true`:
ficam gravadas no histórico e disponíveis para alarme, sem poluir o anunciador.
Para mostrar alguma delas, tire o `oculto` e dê um `rotulo` que diga o que é.

## Se os valores vierem errados

| Sintoma | Ajuste |
|---|---|
| Exceção "illegal data address" nas entradas | o CLP pode expor X em outra base; tente `endereco` + 1 |
| Nível parado em 0 ou 100 | escala errada: leia o registrador cru no terminal de engenharia e recalcule |
| Nível com valor absurdo | o registrador pode não ser o 212; confira no programa do CLP |
| Entradas todas em 0 | confira se é FC2 mesmo; alguns CLPs expõem X como coil (FC1) |
| Timeout constante | velocidade, paridade ou endereço do escravo diferentes |

Lembre que **X e Y são octais no FX3U**: X10 no programa do CLP é o endereço
Modbus 8, não 10. O comentário do seu próprio flow já registrava isso.

## Conferir no campo

Use **Engenharia → Terminal Modbus**: leia o holding 212 com quantidade 1 e
compare a coluna `uint16` com o valor bruto que o CLP mostra. Depois leia
`discreta` 0..7 e acione cada entrada fisicamente para ver o bit mudar. É o mesmo
trabalho que você fazia com o debug do Node-RED, sem precisar de um segundo
programa segurando a porta serial.
