# 7CLP1 — CLP da subestação (QD26)

Faz três coisas:

1. **disjuntor de média tensão** por entradas e saídas (status, trip, LOCAL/REMOTO,
   permissivo do relé 7SR5, comando de fechar/abrir);
2. **mestre Modbus na RS-232** do gerador DSE8620: lê o GenComm e copia para a
   área D1000…, e repassa os comandos do supervisório;
3. **escravo Modbus na RS-485** do supervisório (COM3, endereço 1).

> **Premissa de hardware.** O programa abaixo é para **Mitsubishi FX3U** com os
> adaptadores de comunicação Modbus da própria Mitsubishi (instrução `ADPRW`).
> Se o 7CLP1 for uma **placa compatível com FX3U** (as de RS-232 em DE9 e RS-485 em
> borne, como a da bancada), a lógica é a mesma, mas **confira no manual da placa**:
> (a) se ela faz **mestre Modbus** numa porta e **escravo** na outra ao mesmo tempo;
> (b) qual instrução ela usa para ler/escrever como mestre (muitas aceitam `ADPRW`,
> outras têm instrução própria); (c) como se configuram as portas. Me mande o
> modelo exato que eu adapto.

---

## 1. Hardware

| Item | Para quê |
|---|---|
| FX3U-14MT (8 entradas, 6 saídas transistor) | CPU |
| FX3U-CNV-BD | permite encaixar os adaptadores de comunicação |
| **FX3U-232ADP-MB** — canal 1 | RS-232, **mestre** Modbus → DSE8620 |
| **FX3U-485ADP-MB** — canal 2 | RS-485, **escravo** Modbus → supervisório (COM3) |
| 2 relés auxiliares 24 Vcc (K1, K2) | interface entre as saídas Y0/Y1 e as bobinas do disjuntor |

O adaptador encostado no CLP é o **canal 1**; o seguinte, o **canal 2**.

## 2. Entradas e saídas

| E/S | Ligação | Observação |
|---|---|---|
| **X0** | contato auxiliar **52a** do disjuntor (fechado = 1) | realimentação dos comandos |
| **X1** | **trip** do 7SR5 (ou do relé de bloqueio 86) | borda de subida grava a causa em D30 |
| **X2** | chave **LOCAL/REMOTO** em REMOTO | sem REMOTO o CLP não comanda |
| **X3** | **permissivo de religamento** do 7SR5 | é a trava que vale para religar |
| **X4** | 7SR5 — trip por **sobrecorrente** (50/51) | causa 1 |
| **X5** | 7SR5 — trip por **falta à terra** (50N/51N) | causa 5 |
| **X6** | 7SR5 — trip por **sobretensão** (59) | causa 2 |
| **X7** | 7SR5 — trip por **subtensão** (27) | causa 3 |
| **Y0** | relé K1 → **bobina de fechamento** | pulso de 1 s |
| **Y1** | relé K2 → **bobina de abertura** | pulso de 1 s |
| Y2–Y5 | livres | |

**No 7SR5 (Reydisp):** programe uma saída binária para o **permissivo** (fechada
quando a falta que atuou admite religamento remoto — ex. só 27/59) e uma para cada
função de trip (50/51, 50N/51N, 59, 27). As saídas de função precisam ficar
**seladas até o reset** ou ter **pulso mínimo de 500 ms**, para o CLP enxergar a
causa junto com o trip.

**Segurança no circuito, não só no programa:**
* a chave LOCAL/REMOTO deve **abrir fisicamente** o circuito de K1/K2 em LOCAL;
* o contato do relé de bloqueio (86) deve estar **em série** no circuito de fechamento;
* saídas transistor (Y0/Y1) só acionam relés auxiliares — nunca a bobina direto.

O programa repete essas travas, mas a que protege quem está no painel é a do fio.

## 3. Comunicação

Configure em **GX Works2 → Parâmetros → Parâmetros do CLP → PLC System (2)**:

| | Canal 1 (232ADP-MB) | Canal 2 (485ADP-MB) |
|---|---|---|
| Protocolo | MODBUS, **mestre**, RTU | MODBUS, **escravo**, RTU |
| Velocidade / formato | **19200**, 8 bits, sem paridade, 1 stop | **19200**, 8 bits, sem paridade, 1 stop |
| H/W | RS-232C | RS-485 |
| Endereço | — | **1** |
| Tempo de resposta do escravo | 500 ms | — |
| Tentativas | 1 | — |
| Atribuição de dispositivos | — | **padrão** (X → entradas discretas 0…, Y → coils 0…, D → holding 0…) |

(Por programa, os mesmos parâmetros ficam nos registradores especiais D8400… do
canal 1 e D8420… do canal 2 — use o diálogo, que evita erro de bit.)

**Cabos:**
* **RS-232 ao DSE:** DE9 a DE9, **null-modem** (2↔3 cruzados, 5↔5).
* **RS-485 ao PC:** 2 fios — no 485ADP-MB, junte **SDA+RDA** e **SDB+RDB**;
  SDA/RDA no **A (D+)** do conversor do PC e SDB/RDB no **B (D−)**; SG no GND.
  Chave de terminação do 485ADP-MB em **110 Ω** (o CLP é ponta do barramento).
  Se não comunicar, a primeira coisa a testar é inverter A e B.

## 4. Mapa de registradores (o que o supervisório lê e escreve)

**Disjuntor**

| Endereço Modbus | Dispositivo | Conteúdo | Quem escreve |
|---|---|---|---|
| entradas discretas 0–7 | X0–X7 | entradas | campo |
| coils 0–1 | Y0–Y1 | bobinas | CLP |
| holding 30 | **D30** | causa do último disparo (0 nenhum · 1 sobrecorrente · 2 sobretensão · 3 subtensão · 5 falta à terra · 9 não identificada) | CLP |
| holding 101 | **D101** | heartbeat (contador) | supervisório, a cada 5 s |
| holding 102–103 | **D102 / D103** | comando do disjuntor + complemento (1/65534 = fechar · 2/65533 = abrir) | supervisório (FC16) |
| holding 106 | **D106** | 1 = sem heartbeat há 30 s | CLP |

**Gerador (espelho do DSE8620)**

| CLP | DSE (GenComm) | Leitura do CLP | Conteúdo |
|---|---|---|---|
| D1000–D1002 | 772–774 (H304) | 3 regs | modo, status geral |
| D1003 | 808 (H328) | 1 | paralelismo com a rede ativo |
| D1010–D1057 | 1024–1071 (H400) | 48 | óleo, temperaturas, diesel, bateria, rpm, Hz, tensões, correntes, kW por fase, rede |
| D1060–D1085 | 1536–1561 (H600) | 26 | kW, kVA, kvar, FP, % carga, kW da rede |
| D1090–D1101 | 1798–1809 (H706) | 12 | horímetro, kWh, partidas |
| D1102–D1103 | 1826–1827 (H722) | 2 | diesel consumido |
| D1110–D1130 | 39425–39445 (H9A01) | 21 | alarmes nomeados 1–21 (4 bits cada) |
| D1131 | 39462 (H9A26) | 1 | alarmes de desacoplamento estágio 2 |
| D1132–D1134 | 48896–48898 (HBF00) | 3 | LEDs virtuais 1–3 (disjuntores, gerador disponível) |
| **D1140** | — | — | **1 = leitura do DSE em dia** (zera após 5 s sem leitura válida) |
| D1141 | — | — | contador de leituras completas |
| D1142 | — | — | contador de falhas de leitura |
| **D1150 / D1151** | 4104 / 4105 (H1008) | — | comando do gerador: chave + complemento (o supervisório escreve; o CLP repassa ao DSE e zera) |

Áreas de trabalho do programa: D104, D105, D1143 (passo), D1144, D1152, D1200–D1202.

## 5. Programa (lista de instruções — GX Works2)

```
; =============================================================== 0. PARTIDA
LD   M8002                    ; primeiro ciclo após RUN
ZRST D100 D106
ZRST D1000 D1154
MOV  K-1 D1200                ; rascunho do 1º bloco: -1 = "ainda não leu"
MOV  K0 D1143                 ; passo do sequenciador do DSE
RST  M1151

; =============================================================== 1. HEARTBEAT
; o supervisório escreve D101 a cada 5 s; parado por 30 s = supervisório ausente
LD<> D101 D105
MOV  D101 D105
RST  T2
LD   M8000
OUT  T2 K300
LD   T2
MOV  K1 D106
LDI  T2
MOV  K0 D106

; =============================================================== 2. DISJUNTOR
; comando = código em D102 + complemento em D103, gravados juntos (FC16)
LD   M8000
CML  D102 D104                ; D104 = inverso bit a bit de D102

LD=  D103 D104                ; o par confere?
AND= D102 K1                  ; 1 = FECHAR
AND  X002                     ; REMOTO
ANI  X000                     ; está aberto
AND  X003                     ; permissivo do relé
ANI  X001                     ; sem trip presente
ANI  Y001                     ; não está abrindo
SET  Y000

LD=  D103 D104
AND= D102 K2                  ; 2 = ABRIR
AND  X002                     ; REMOTO
AND  X000                     ; está fechado
ANI  Y000
SET  Y001

LD<> D102 K0                  ; chegou qualquer coisa: executada ou recusada,
OR<> D103 K0                  ; o par é zerado — o comando é um pulso
ZRST D102 D103

LD   Y000                     ; pulsos de 1 s nas bobinas
OUT  T0 K10
LD   T0
RST  Y000
LD   Y001
OUT  T1 K10
LD   T1
RST  Y001

; =============================================================== 3. CAUSA DO DISPARO
LD   X001
PLS  M30                      ; um ciclo na subida do trip
LD   M30
MOV  K9 D30                   ; não identificada, a menos que…
LD   M30
AND  X004
MOV  K1 D30                   ; sobrecorrente
LD   M30
AND  X005
MOV  K5 D30                   ; falta à terra
LD   M30
AND  X006
MOV  K2 D30                   ; sobretensão
LD   M30
AND  X007
MOV  K3 D30                   ; subtensão
LD   X000
PLS  M31                      ; disjuntor fechou: zera a causa
LD   M31
MOV  K0 D30

; =============================================================== 4. COMANDO DO GERADOR
LD   M8000
CML  D1150 D1152
LD<> D1150 K0
AND= D1151 D1152              ; par válido: envia ao fim do ciclo de leitura
SET  M1151
LD<> D1150 K0
AND<> D1151 D1152
ANI  M1151
ZRST D1150 D1151              ; par inválido é descartado

; =============================================================== 5. LEITURA DO DSE (canal 1)
; um ADPRW por vez; M1000 = "passo terminou"
LD=  D1143 K0
ADPRW H0A H3 H304 K3 D1200    ; página 3 → rascunho (validado no item 6)
LD=  D1143 K0
AND  M8029
SET  M1000

LD=  D1143 K1
ADPRW H0A H3 H328 K1 D1003    ; página 3 reg 40
LD=  D1143 K1
AND  M8029
SET  M1000

LD=  D1143 K2
ADPRW H0A H3 H400 K48 D1010   ; página 4
LD=  D1143 K2
AND  M8029
SET  M1000

LD=  D1143 K3
ADPRW H0A H3 H600 K26 D1060   ; página 6
LD=  D1143 K3
AND  M8029
SET  M1000

LD=  D1143 K4
ADPRW H0A H3 H9A01 K21 D1110  ; página 154 regs 1-21
LD=  D1143 K4
AND  M8029
SET  M1000

LD=  D1143 K5
ADPRW H0A H3 H9A26 K1 D1131   ; página 154 reg 38
LD=  D1143 K5
AND  M8029
SET  M1000

LD=  D1143 K6
ADPRW H0A H3 HBF00 K3 D1132   ; página 191 — LEDs virtuais 1-3
LD=  D1143 K6
AND  M8029
SET  M1000

LD=  D1143 K7
ADPRW H0A H3 H706 K12 D1090   ; página 7 regs 6-17
LD=  D1143 K7
AND  M8029
SET  M1000

LD=  D1143 K8
ADPRW H0A H3 H722 K2 D1102    ; página 7 regs 34-35
LD=  D1143 K8
AND  M8029
SET  M1000

LD=  D1143 K10
ADPRW H0A H10 H1008 K2 D1150  ; FC16: chave + complemento → DSE 4104/4105
LD=  D1143 K10
AND  M8029
SET  M1000

; =============================================================== 6. VALIDAÇÃO E ENLACE
; o 1º bloco só vale se o modo do DSE veio entre 0 e 7: prova que o DSE respondeu
LD   M1000
AND= D1143 K0
AND>= D1200 K0
AND<= D1200 K7
BMOV D1200 D1000 K3
MOV  K1 D1140                 ; enlace em dia
INCP D1141
RST  T10

LD   M8000
OUT  T10 K50                  ; 5 s sem leitura válida…
LD   T10
MOV  K0 D1140                 ; …enlace perdido: o supervisório mostra o gerador sem comunicação

; tempo máximo por passo: 3 s
LD<> D1143 D1144
MOV  D1143 D1144
RST  T11
LD   M8000
OUT  T11 K30
LD   T11
SET  M1000
INCP D1142

; =============================================================== 7. AVANÇO DO SEQUENCIADOR
LD   M1000
RST  M1000
INCP D1143

LD=  D1143 K9                 ; terminou a leitura
MPS
AND  M1151                    ; comando pendente?
MOV  K10 D1143
MPP
ANI  M1151
MOV  K0 D1143
MOV  K-1 D1200

LD=  D1143 K11                ; comando enviado
ZRST D1150 D1151
RST  M1151
MOV  K0 D1143
MOV  K-1 D1200

END
```

### Como funciona

* **Sequenciador:** passos 0–8 leem os blocos do DSE, um `ADPRW` por vez (o canal
  mestre só faz uma conversa por vez). Ao fim, volta ao 0 — ou passa pelo passo 10
  se houver comando do gerador pendente. Um ciclo completo leva ~0,4 s a 19200 bps.
* **Enlace (D1140):** a cada ciclo o CLP põe −1 no rascunho e só aceita o 1º bloco
  se o DSE responder com um modo válido (0–7). Sem isso por 5 s, D1140 = 0 e o
  supervisório mostra "7CLP1 sem comunicação com o DSE8620" em vez de valores
  congelados.
* **Comandos:** o supervisório nunca escreve no DSE direto: grava chave +
  complemento em D1150/D1151, o CLP confere o par e repassa ao DSE com FC16 — o
  formato que o DSE exige (056-051). Par inválido é descartado.
* **Disjuntor:** além das travas do supervisório, o CLP confere de novo REMOTO,
  posição, permissivo e trip antes de pulsar a bobina.

### Confira no manual do seu CLP

* que `M8029` liga ao terminar o `ADPRW` (é o comportamento do FX3U com
  adaptador MB) e que um `ADPRW` não acionado não mexe nele;
* o registrador de código de erro do canal mestre (no FX3U, D8402 para o canal 1)
  — útil para diagnóstico, o programa não depende dele;
* em placa compatível, a instrução de mestre Modbus e a forma de configurar as portas.

## 6. Teste no comissionamento

1. **Sem o DSE ligado:** D1140 = 0, D1142 subindo a cada ~3 s (cada passo estoura o
   tempo). O supervisório mostra o gerador sem comunicação — certo.
2. **DSE ligado:** D1140 = 1, D1141 subindo ~2 vezes por segundo. No supervisório,
   Terminal Modbus → endereço 1, holding 1000, quantidade 4: D1000 = modo do DSE.
3. **Disjuntor em LOCAL:** comando pelo supervisório tem que ser recusado (pelo
   supervisório e, se forçado, pelo CLP).
4. **Disjuntor em REMOTO:** abrir e fechar; X0 deve acompanhar em menos de 1 s.
5. **Trip simulado** com X4 ligado: D30 = 1 e o religamento remoto fica bloqueado.
