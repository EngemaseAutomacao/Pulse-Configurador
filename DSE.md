# Grupo gerador com controlador Deep Sea (GenComm por RS-232)

O perfil `perfis/dse-gencomm.json` lê o controlador Deep Sea pelo protocolo
**GenComm** — o mapa Modbus da DSE — e preenche a tela do gerador que já existe:
estado, modo, rede, tanque, anunciador de falhas, prontidão, corridas e bateria.

Serve para os controladores cujo GenComm segue o mesmo mapa nas páginas lidas:
**DSE 61xx MKII/MKIII, 72xx/73xx/74xx (MKI e MKII) e 8xxx**. Fontes: GenComm
2.276, 056-051 (teclas de controle), 056-076 (alarmes), 056-079 (status),
056-080 (Modbus).

> **DSE8620 MKII → use o perfil `dse-8620`.** Ele herda tudo do `dse-gencomm` e
> acrescenta o que é de paralelismo com a rede — ver a seção 7.

> **Nesta planta o DSE não liga no PC:** ele liga por RS-232 no **7CLP1**, que lê
> o GenComm e espelha os dados na área D1000… — o supervisório usa o perfil
> `dse-8620-via-clp`. A configuração do DSE (seção 2) é a mesma; a ligação e o
> programa do CLP estão em `PLC_7CLP1.md`, e o mapa da planta em `PLANTA.md`.

---

## 1. O que o supervisório lê

Tudo é *holding register*, lido com a função 3 — o DSE não aceita outra. O
endereço é **página × 256 + offset**, sem somar 1 nem 40000.

| Página | Endereços | O que vem |
|---|---|---|
| 3 — status | 772, 774 | modo (Stop/Auto/Manual/Teste…) e a palavra de alarmes (parada, trip, advertência) |
| 4 — instrumentos | 1024–1071 | pressão e temperatura do óleo, água, diesel %, bateria, rpm, Hz, tensões e correntes (32 bits), kW por fase, rede |
| 6 — derivados | 1536–1558 | kW total, kVA, kvar, fator de potência, % de carga |
| 7 — acumulados | 1798–1827 | horímetro, kWh gerados, número de partidas, diesel consumido (leitura lenta) |
| 154 — alarmes | 39425–39433 | 31 alarmes nomeados, um código de 4 bits cada |

São **4 requisições por segundo** mais 2 lentas — folga de sobra para o DSE.

**Sentinelas.** Quando o controlador não tem o sensor, ou a medida está fora da
faixa, ele responde um valor reservado (0xFFFF, 0x7FFF…) em vez de erro. O
supervisório mostra "––" nesses casos, nunca 655,35 bar.

**Alarmes.** Cada alarme vem com um código: 1 inativo, 2 advertência, 3 parada,
4 trip elétrico, 15 não existe neste modelo. Os 31 viram 17 janelas no
anunciador (ex.: "baixa pressão de óleo" acende pelo sensor ou pelo pressostato).
Alarme que o controlador informa como inexistente fica "sem dado", não "normal".

**Estado do grupo.** O GenComm não tem uma máquina de estados padronizada entre
modelos, então o estado é deduzido do que é medido:

| Estado | Quando |
|---|---|
| Em falha | palavra de status com parada, trip ou parada controlada ativa |
| Parado | rotação ≤ 100 rpm e sem frequência |
| Partindo | girando, abaixo de 90 % da frequência nominal |
| Em carga | frequência estável e potência ≥ 1 kW |
| Em vazio / resfriando | frequência estável, sem carga |

"Pré-aquecendo" não é distinguível pelo GenComm e não aparece.

**Rede presente** vem da medição de rede do próprio DSE (frequência entre 40 e 70
Hz e alguma fase acima de 80 V). Controlador sem medição de rede (ex. DSE7310,
6110) devolve sentinela e a rede fica "––" — declare `"mede_rede": false` (seção 4).

---

## 2. Configurar o controlador (DSE Configuration Suite)

Conecte o PC ao DSE pela USB e abra a configuração.

1. **Porta RS-232, uso direto (sem modem).** Na seção de comunicações da porta
   RS-232, deixe a porta em conexão direta com PC/supervisório — sem modem, sem
   discagem.
2. **Velocidade.** Anote (ou defina) a velocidade da porta RS-232. O perfil usa
   **19200 bps, 8 bits, sem paridade, 1 stop (8N1)**. Se o DSE estiver em outra
   velocidade, ajuste uma das pontas — **as duas precisam ser iguais**.
3. **Endereço Modbus: sempre 10.** O GenComm fixa o endereço em **10** quando a
   ligação é RS-232 direto com o PC — não há como mudar, e o supervisório recusa
   outro valor nesse caso. (Em RS-485 e Ethernet o endereço é o configurado.)
4. **Senha de telemetria (PIN).** Se o DSE tiver PIN de telemetria habilitado, ele
   recusa as leituras até o PIN ser enviado. Deixe o PIN de telemetria desabilitado
   (0000) — o supervisório não envia PIN.
5. **Sensores.** O nível de combustível precisa estar configurado como sensor
   **em %**; sem sensor, o tanque aparece "––" (e o supervisório não calcula
   autonomia). Idem pressão de óleo e temperatura.
6. **Painel travado.** "Lock user controls", *panel lock* por entrada digital ou
   por telemetria podem fazer o DSE ignorar comandos remotos. Se for usar os
   botões do supervisório, confira que nenhum desses está ativo.
7. **Envie a configuração** ao controlador e **desconecte o cabo USB e o DSE
   Configuration Suite** antes de testar o supervisório.

> **Alarmes de entradas configuráveis** (ex. "porta do gerador aberta", ligada a
> uma entrada digital) não estão na lista de alarmes nomeados. Quando um deles
> para o grupo, o supervisório mostra **"grupo parado por alarme — veja o painel
> do controlador"**, pela palavra de status. Se quiser o texto específico, é
> possível ler a página 153 (alarmes não nomeados) — peça que eu acrescente.

---

## 3. Ligação RS-232

1. **Uma porta COM só para o DSE.** RS-232 é ponto a ponto: um equipamento por
   porta. O DSE **não** pode dividir a COM7 com o CLP FX3U (que está na RS-485).
   Use um segundo conversor USB-RS232 — o supervisório recusa a configuração se
   duas coisas forem postas na mesma porta RS-232.
2. **Conversor USB-RS232** com chip FTDI ou Prolific original. Depois de espetar,
   veja a porta em Gerenciador de Dispositivos → Portas (COM e LPT), ex. `COM4`.
   Acima de COM9 o nome é `\\.\COM10`.
3. **Cabo null-modem (cruzado), DE9.** É o que o documento 056-051 da DSE pede
   para RS-232. Cabo "direto" (pino a pino) não funciona: o TX de um lado precisa
   chegar no RX do outro.

   | Conversor (DE9) | DSE (DE9) |
   |---|---|
   | 2 RX | 3 TX |
   | 3 TX | 2 RX |
   | 5 GND | 5 GND |

4. **Distância.** RS-232 é para perto: até uns **15 m**, cabo blindado, longe dos
   cabos de força do gerador, malha aterrada só de um lado. Se o computador ficar
   mais longe, use a porta **RS-485** do DSE (até ~1200 m) ou Ethernet — o perfil
   aceita os dois, ver a seção 4.
5. **Só um programa por vez na porta.** Feche o DSE Configuration Suite, o
   Modbus Poll ou qualquer outro programa que esteja com a COM aberta.

---

## 4. Configurar o supervisório

**Pela tela (recomendado):** Engenharia → Equipamentos → perfil **dse-8620** (ou
**dse-gencomm** para outros modelos) → meio **RS-232** → porta COM do conversor
e velocidade igual à do DSE. Escolher RS-232 já põe o endereço em 10. Na seção do
gerador, preencha capacidade do tanque, consumo em plena carga e potência
nominal. Valide e aplique.

**Ou no arquivo de configuração:**

```jsonc
"medidores": [
  { "id": "gmg", "nome": "Grupo gerador", "tag_isa": "GMG-01", "perfil": "dse-8620",
    "conexao": { "tipo": "rtu", "interface": "rs232", "porta_serial": "COM4",
                 "baud": 19200, "unit_id": 10 } }
],
"gerador": {
  "capacidade_tanque_litros": 400,
  "consumo_litros_hora": 30,
  "potencia_nominal_kw": 180
}
```

Ajustes que dependem da instalação:

| Situação | O que mudar |
|---|---|
| Bateria de **12 V** (o perfil vem em 24 V) | na seção `gerador`: `bateria_minima_v` 11,5 · `bateria_repouso_min_v` 12,6 · `bateria_partida_min_v` 10 · `bateria_partida_critica_v` 9; e em `limites` do equipamento: `"tensao_bateria": { "min": 11.5 }` |
| Rede de **50 Hz** | no equipamento: `"derivar_opcoes": { "frequencia_nominal_hz": 50 }` |
| Controlador **sem medição de rede** | no equipamento: `"derivar_opcoes": { "mede_rede": false }` |
| Grupo que roda com pouca carga | `"derivar_opcoes": { "limiar_carga_kw": 0.3 }` |

(`derivar_opcoes` no equipamento substitui o bloco inteiro do perfil — repita os
campos que quiser manter.)

**Outros meios.** O mesmo perfil fala com o DSE por:

| Meio | `conexao` | Endereço |
|---|---|---|
| RS-232 (padrão) | `"tipo": "rtu", "interface": "rs232", "porta_serial": "COM4", "baud": 19200` | sempre 10 |
| RS-485 | `"tipo": "rtu", "interface": "rs485", "porta_serial": "COM5", "baud": 19200` | o configurado no DSE |
| Ethernet | `"tipo": "tcp", "host": "192.168.8.20", "porta": 502` | o configurado no DSE |

Em Ethernet: IP fixo no DSE e no computador, mesma sub-rede, e a porta 502 do DSE
acessível **só** pelo supervisório — Modbus TCP não tem senha.

---

## 5. Comandos (opcional)

O perfil traz cinco botões, que só aparecem com `seguranca.comandos_liberados:
true`. Todos usam o formato que o DSE exige (056-051): **chave de controle em 4104
e o complemento (65535 − chave) em 4105, no mesmo quadro FC16**. O DSE ignora
qualquer outra escrita nesses registradores.

| Botão | Chave | Travas | Confirmação |
|---|---|---|---|
| Modo automático | 35701 | — | modo = Auto |
| Parar grupo (Stop) | 35700 | senha · **só com rede presente** | modo = Stop |
| Teste com carga | 35703 | senha · rede presente · sem falha · diesel acima do crítico | modo = Teste com carga |
| Rearmar alarmes | 35707 | — | — |
| Silenciar sirene | 35706 | perfil operador | — |

"Parar grupo" é bloqueado sem rede: parar o gerador nessa hora apaga a loja. Se
for preciso, pare no painel. Depois de um teste com carga, **volte para
Automático** — em modo Teste o grupo não para sozinho.

Instalação só de monitoramento: `"comandos": false` no equipamento.

---

## 6. Comissionamento

1. Suba o supervisório e confira no console: `10  Grupo gerador  COM4 19200 8N1`.
2. Engenharia → **Diagnóstico**: o equipamento deve aparecer em comunicação, sem
   falhas acumulando. Se não responder: confira a COM, a velocidade dos dois
   lados, o cabo null-modem e se o Configuration Suite está fechado. A
   **Varredura** da Engenharia (meio serial, porta do DSE, endereços 10 a 10)
   ajuda a achar a velocidade: tente 19200, 9600 e 38400.
3. Engenharia → **Terminal Modbus**: leia o endereço **10**, holding **1024**, quantidade 8. A coluna
   `uint16` do registrador 5 dividida por 10 é a tensão da bateria que o display
   do DSE mostra; o 3 é o diesel em %.
4. Tela **Gerador**: compare com o display do DSE — modo, rpm, Hz, tensões,
   bateria, horímetro.
5. Com o grupo parado em Auto, a prontidão deve estar **verde**. Mude o DSE para
   Stop no painel: em poucos segundos o supervisório mostra "Stop" e a prontidão cai.
6. Faça um teste com carga (pelo painel ou pelo botão): o estado passa por
   Partindo → Em carga, a corrida aparece na lista com tempo de partida e queda de
   bateria, e ao fim ela é fechada.
7. Provoque um alarme simples (ex. parada de emergência com o grupo parado): a
   janela acende no anunciador e o alarme aparece na lista.

O perfil e a tradução foram testados contra um controlador simulado que imita o
mapa GenComm — não contra um DSE real. Os passos 2 a 7 são a prova de campo.

---

## 7. DSE8620 MKII (paralelismo com a rede)

O 8620 é o controlador de grupo único que sincroniza e opera em paralelo com a
rede. O perfil `dse-8620` lê, além do mapa comum:

| O quê | Onde | Na tela |
|---|---|---|
| Potência da rede (negativa = exportando) | página 6, reg 24-25 (1560) | leitura "Potência da rede" |
| Modo de paralelismo ativo | página 3, reg 40 (808) | histórico |
| Disjuntor do gerador / da rede, gerador disponível | **LEDs virtuais 1-3** (48896-48898) | "Disjuntores: gerador fechado · rede aberta" ou "em paralelo com a rede" |
| Alarmes da família 8xxx | página 154, regs 9-21 e 38 | seis janelas novas no anunciador |

Alarmes novos, agrupados como o operador precisa:

| Janela | Vem de |
|---|---|
| Falha de sincronismo | falha de sincronismo, fora de sincronismo (barra e rede) |
| Proteção de rede (desacoplamento) | ROCOF, salto vetorial, sub/sobrefrequência e sub/sobretensão (estágios 1 e 2), desacoplamento combinado |
| Potência reversa | potência reversa no gerador |
| Curto-circuito / fuga à terra | curto-circuito, fuga à terra |
| Perda de excitação | perda de excitação |
| Sequência de fase | sequência de fase do gerador ou da rede |

E dois avisos fora do anunciador: **exportando para a rede** (média) e
**proteções desabilitadas ou bloqueadas** (alta — o grupo está rodando sem as
proteções do controlador).

### Configurar os LEDs virtuais no 8620

O GenComm não tem um registrador fixo com a posição dos disjuntores para o 8620.
O jeito que a própria DSE indica (documento 056-079) é ligar LEDs virtuais às
fontes desejadas e ler a página 191. No DSE Configuration Suite, em **LEDs
virtuais**:

| LED virtual | Fonte | Polaridade |
|---|---|---|
| 1 | a que indica **disjuntor do gerador fechado** (ex.: *Close Gen Output*) | aceso |
| 2 | a que indica **disjuntor da rede fechado** (ex.: *Close Mains Output*) | aceso |
| 3 | **Generator Available** | aceso |

Os nomes das fontes variam um pouco entre versões de firmware; escolha a
equivalente na lista. Se os LEDs virtuais 1-3 já estiverem em uso, escolha
outros e ajuste os endereços das tags `disjuntor_fechado`,
`disjuntor_rede_fechado` e `gerador_disponivel` no equipamento
(LED virtual *n* = 48896 + *n* − 1).

Sem os LEDs configurados, eles leem 0: a tela mostra os disjuntores abertos, mas
o resto funciona — o estado "em carga" também é deduzido pela potência.

### O que o 8620 muda nos comandos

Os cinco botões do perfil comum continuam. Dois cuidados:

* **Teste com carga**, num 8620 configurado para paralelismo, pode sincronizar e
  entrar em paralelo com a rede em vez de transferir. É o comportamento
  configurado no controlador — confira antes de usar pela primeira vez.
* **Transferir para gerador/rede** (chaves 35708/35709) e **rearmar falha de
  rede** (35710, que reabilita o paralelismo depois de um desacoplamento) ficaram
  **de fora de propósito**. Rearmar uma proteção de rede ou transferir carga em
  paralelo é decisão de quem está no local, vendo o painel.
