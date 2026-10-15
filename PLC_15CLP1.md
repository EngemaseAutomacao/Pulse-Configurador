# 15CLP1 — CLP do reservatório (QD11)

Lê o sensor de nível da caixa d'água (4-20 mA) e responde ao supervisório como
**escravo Modbus 10** na RS-485 dos medidores (COM4, **9600 8N1**, a velocidade dos medidores). É o último
equipamento da linha: **leva a terminação de 120 Ω**.

É o mesmo papel do CLP da bancada (que já entrega o nível em D212), sem o disjuntor.

## Comunicação

| Item | Valor |
|---|---|
| Porta | RS-485 (na placa compatível, a porta RS-485 de borne; no FX3U original, FX3U-485ADP-MB) |
| Protocolo | Modbus RTU **escravo** |
| Endereço | **10** |
| Formato | **9600**, 8 bits, sem paridade, 1 stop |
| Atribuição de dispositivos | padrão (D → holding 0…) |
| Terminação | **ligada** (fim da linha) |

> Na bancada o CLP está em 9600 e endereço 1: a velocidade fica, mas no 15CLP1
> mude para o **endereço 10**, senão ele colide com o medidor geral (endereço 1) na COM4.

## Mapa de registradores

| Endereço Modbus | Dispositivo | Conteúdo |
|---|---|---|
| holding 212 | **D212** | leitura bruta do sensor (756 = 4 mA … 4095 = 20 mA, como na bancada) |
| holding 213 | **D213** | 1 = sensor fora da faixa (laço aberto ou acima de 20 mA) por mais de 5 s |
| holding 214 | **D214** | contador de vida: +1 por segundo (o supervisório vê se o programa travou) |

A escala de D212 para % é feita no supervisório (perfil `clp-reservatorio`), a
mesma já conferida na bancada: 756 → 0 %, 2425 → 50 %, 4095 → 100 %.

## Programa (lista de instruções)

```
; nível: copie o canal analógico para D212 — o mesmo MOV que o CLP da bancada
; já usa hoje (na placa compatível costuma ser D8030 para o canal AD0)
LD   M8000
MOV  D8030 D212               ; ← troque D8030 pelo registrador do seu canal analógico

; sensor fora da faixa (706 … 4145) por 5 s
LD<  D212 K706
OR>  D212 K4145
OUT  T0 K50
LD   T0
MOV  K1 D213
LDI  T0
MOV  K0 D213

; contador de vida: +1 por segundo, volta a zero em 30000
LDP  M8013                    ; relógio de 1 s
INC  D214
LD>= D214 K30000
MOV  K0 D214

END
```

**FX3U original com FX3U-4AD-ADP:** o canal 1 do primeiro adaptador analógico
fica num registrador especial (D8260 no FX3U) e o modo corrente se escolhe por
um bit especial (M8260). A faixa digital do adaptador é diferente da placa da
bancada — recalcule `escala` e `offset` da tag `nivel` com a fórmula do
`FX3U.md` (seção "A escala do sensor").

## Teste no comissionamento

No supervisório, Engenharia → Terminal Modbus → endereço **10**, holding **212**,
quantidade 3:

1. D212 acompanha o sensor (simule 4 mA e 20 mA com um calibrador, se tiver);
2. D213 = 0 com o sensor ligado; desligue o sensor: em 5 s vira 1, e o
   supervisório abre o alarme de laço aberto;
3. D214 sobe a cada segundo.
