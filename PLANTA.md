# Planta — comunicação e endereços (Viza CD — E01)

Conforme o projeto elétrico, com uma mudança: **o DSE8620 liga no 7CLP1 por
RS-232** (no projeto está RS-485). Configuração do supervisório:
`config.planta.json` — suba com `npm run planta` (ou `npm run planta-demo` para
ver as telas sem nenhum equipamento ligado).

```
                    ┌──────────────┐  RS-232 19200 8N1 (null-modem)
    DSE8620 ────────┤              │  DSE = escravo 10 (fixo em RS-232)
    (gerador)       │    7CLP1     │
    7SR5 ── E/S ────┤  subestação  │  disjuntor de MT por entradas e saídas
    disjuntor ─ E/S ┤   QD26       │
                    └──────┬───────┘
                           │ RS-485 19200 8N1 — barramento só do 7CLP1
                           │ 7CLP1 = escravo 1
                    ┌──────┴───────┐
                    │ 7PC1         │ COM3 ── subestação
                    │ mini PC      │ COM4 ── medidores + 15CLP1
                    │ supervisório │ Ethernet ── TI / Central Viza
                    └──────┬───────┘
                           │ RS-485 9600 8N1
     7E1 ─ 8E1 ─ 8E2 ─ 9E1 ─ 9E2 ─ 10E1 ─ 10E2 ─ 11E1 ─ 11E1 ─ 15CLP1
      1     2     3     4     5     6      7      8      9      10
```

## Tabela de comunicação

| Equipamento | Onde liga | Parâmetros | Endereço Modbus | Perfil |
|---|---|---|---|---|
| **7PC1** (supervisório) | COM3 e COM4 (USB-RS485) | mestre nos dois | — | — |
| **7CLP1** subestação (QD26) | RS-485 → COM3 | 19200 8N1 | **1** | `clp-subestacao` |
| Gerador **DSE8620** | RS-232 → 7CLP1 | 19200 8N1 | **10** (fixo em RS-232) | `dse-8620-via-clp` (lido pelo 7CLP1) |
| **7E1** medidor geral | RS-485 → COM4 | 9600 8N1 | **1** | `7kt0310-entrada` |
| **8E1** padaria | COM4 | 9600 8N1 | **2** | `7kt0310-alimentador` |
| **8E2** açougue | COM4 | 9600 8N1 | **3** | `7kt0310-alimentador` |
| **9E1** ilhas de frio | COM4 | 9600 8N1 | **4** | `7kt0310-alimentador` |
| **9E2** refrigerados | COM4 | 9600 8N1 | **5** | `7kt0310-alimentador` |
| **10E1** congelados | COM4 | 9600 8N1 | **6** | `7kt0310-alimentador` |
| **10E2** climatização | COM4 | 9600 8N1 | **7** | `7kt0310-alimentador` |
| **11E1** iluminação | COM4 | 9600 8N1 | **8** | `7kt0310-alimentador` |
| **11E1** carregadores (QD11) | COM4 | 9600 8N1 | **9** | `7kt0310-alimentador` |
| **15CLP1** reservatório (QD11) | COM4 | 9600 8N1 | **10** | `clp-reservatorio` |

> No projeto, iluminação e carregadores estão os dois como **11E1**. Mantive
> como está; se for erro de desenho, corrija o `tag_isa` em `config.planta.json`.

**Por que dois barramentos.** O 7CLP1 fica sozinho na COM3: comando de disjuntor
e gerador não esperam a varredura de nove medidores, e um problema na linha dos
medidores não derruba a subestação. O supervisório lê as duas portas em paralelo.

**Velocidades.** COM3 em 19200 8N1 (7CLP1). COM4 em **9600 8N1**: é como os
medidores já estão configurados e lidos hoje pelo Node-RED — não precisa mexer
em nenhum deles. O 15CLP1, na mesma linha, acompanha os 9600.

**Tempo de varredura** (ciclo de 1 s): COM3 ≈ 7 pedidos, ~370 ms. COM4: os oito
alimentadores são lidos em **rodízio** (metade a cada ciclo, cada um a cada 2 s);
o medidor geral e o 15CLP1 a cada ciclo — 14 pedidos, ~1 s a 9600 com a folga de
20 ms entre pedidos (~1,2 s no ciclo que inclui leituras lentas de energia). Se
os medidores forem passados para 19200, cai para ~0,8 s.

**Um pedido de cada vez.** Em cada porta o supervisório manda um pedido, espera a
resposta (ou o timeout de 1 s) e só então manda o próximo, com folga de 20 ms
entre eles na linha dos medidores (`intervalo_entre_quadros_ms` no perfil
7KT0310; depois de uma falha, 150 ms). Equipamento que parou de responder é
tentado de novo só a cada 10 s, para não segurar a linha 1 s por ciclo; e a
falha de um escravo não fecha a porta dos outros.

**Medidor 7KT0310 — detalhes que o perfil já trata:**
* endereço da norma (30001 = 0) e float com a **palavra baixa primeiro**
  (CDAB). No Terminal Modbus, leia a coluna "float CDAB". O fluxo antigo do
  Node-RED lia ABCD a partir do endereço + 1: a tensão saía quase certa, mas a
  energia só andava em degraus de 1024 kWh (a metade baixa vinha da energia
  exportada, que é zero);
* valor fisicamente impossível (fora de `faixa_fisica` da tag) vira "sem dado"
  em vez de ir para a tela e o histórico;
* no máximo 12 registradores por leitura — acima disso ele responde com CRC errado;
* às vezes o contador de energia vem com as duas metades do float de momentos
  diferentes e "pula" centenas de kWh por uma leitura. O supervisório só aceita
  um valor de contador que não desça nem suba mais rápido que 750 kWh/h; um
  salto isolado é descartado (fica o último valor bom) e só vale se a leitura
  seguinte confirmar. Aparece no log como `recusado (salto impossível)`.

> **Um mestre por linha.** O Node-RED do servidor também lê esses medidores pela
> mesma porta. Duas leituras ao mesmo tempo na RS-485 embaralham as respostas:
> antes de ligar o supervisório na linha dos medidores, **desligue o fluxo do
> Node-RED que lê o Modbus** (ou o nó "medidores de energia").

## O que configurar em cada equipamento

| Equipamento | Configuração |
|---|---|
| **7PC1** | Dois conversores USB-RS485. Gerenciador de Dispositivos → porta → Propriedades → Configurações de porta → Avançado → **número da porta COM: COM3** (subestação) e **COM4** (medidores). Fixe os números: assim o supervisório não perde a porta se trocar o USB de lugar. **Se o 7PC1 for Linux:** COM3/COM4 viram `/dev/serial/by-id/...` ou `/dev/serial/by-path/...` — ver `LINUX.md`, passos 3 e 4. |
| **7CLP1** | Ver `PLC_7CLP1.md`: canal RS-232 mestre (19200 8N1) e canal RS-485 escravo 1 (19200 8N1). |
| **DSE8620** | Ver `DSE.md` seção 2: porta RS-232 em **conexão direta (sem modem)**, **19200 8N1**, PIN de telemetria desabilitado, LEDs virtuais 1-3. Endereço é 10 e não muda. |
| **7SR5** | Saídas binárias (Reydisp): permissivo de religamento e um contato por função de trip (50/51, 50N/51N, 59, 27) — ver `PLC_7CLP1.md`. |
| **Medidores 7E1…11E1** | Modbus RTU, **9600 8N1** (como já estão), endereços 1 a 9 conforme a tabela. |
| **15CLP1** | Ver `PLC_15CLP1.md`: RS-485 escravo **10**, **9600 8N1**. |

## Cabeamento RS-485

* Par trançado blindado 120 Ω (a DSE recomenda Belden 9841) — **A com A, B com B**,
  em **barramento** (de um equipamento ao próximo), nunca em estrela.
* **Terminação de 120 Ω só nas duas pontas** de cada barramento:
  * COM3: no conversor do PC e no 7CLP1;
  * COM4: no conversor do PC e no **15CLP1** (último da linha).
* Derivações (do barramento até o borne) o mais curtas possível.
* Malha aterrada **num ponto só** (no painel do PC); nos outros, malha emendada e isolada.
* Se um conversor USB-RS485 tiver resistores de polarização (*bias*), deixe
  ligados só no do PC.

## Ordem de comissionamento

1. **Medidores (COM4):** suba o supervisório, Engenharia → Diagnóstico. Os nove em
   comunicação? Se um falhar, use a Varredura (COM4, 9600, endereços 1-10).
2. **15CLP1 (COM4, endereço 10):** Terminal Modbus → endereço 10, holding 212,
   quantidade 3. D212 deve acompanhar o sensor; D214 deve subir a cada segundo.
3. **7CLP1 sem o gerador (COM3, endereço 1):** disjuntor — X0/X2/X3 aparecem na
   tela de comandos; teste os botões de ligar/desligar **com a chave em LOCAL**
   primeiro (o comando tem que ser recusado), depois em REMOTO.
4. **7CLP1 ↔ DSE8620:** no Terminal Modbus, endereço 1, holding **1140**,
   quantidade 3: D1140 = 1 e D1141 subindo = o CLP está lendo o DSE. A tela do
   gerador passa a mostrar os valores; compare com o display do DSE.
5. **Comandos do gerador:** com o grupo em Auto, mande "Silenciar sirene" (o mais
   inofensivo) e confira no DSE. Depois os demais, com alguém no gerador.
