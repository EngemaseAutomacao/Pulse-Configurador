# Instalar uma loja nova

O mapa de registradores de cada modelo fica em `perfis/`. O `config.json` da loja
só diz qual perfil usar, em que endereço e com que nome. Uma loja nova é um
arquivo de ~200 linhas, não um mapa Modbus copiado à mão.

## Perfis que já acompanham o produto

| Perfil | Para que serve |
|---|---|
| `7kt0310-entrada` | multimedidor Siemens na entrada geral, conjunto completo de grandezas |
| `7kt0310-alimentador` | mesmo medidor em alimentador: corrente, potência e energia |
| `clp-utilidades` | CLP de reservatório e bomba de recalque |
| `gerador-generico` | controlador de grupo gerador, mapa a partir do registrador 0 |
| `gerador-marca-b` | mesmo conjunto de grandezas, mapa a partir de 1000 |
| `dse-gencomm` | controlador Deep Sea (61xx, 72xx/73xx/74xx, 8xxx) por RS-232 (padrão), RS-485 ou Ethernet — ver `DSE.md` |
| `dse-8620` | DSE8620 MKII: herda o `dse-gencomm` + paralelismo com a rede |
| `dse-8620-via-clp` | o mesmo DSE8620, lido por um CLP que espelha o GenComm em D1000… (ver `PLC_7CLP1.md`) |
| `clp-subestacao` | 7CLP1: disjuntor de MT por E/S + ponte para o gerador |
| `clp-reservatorio` | 15CLP1: nível da caixa d'água em D212 |

`"remapear"` num perfil filho move os endereços herdados bloco a bloco (ex.: o
GenComm 1024–1071 lido em D1010–D1057). Bloco esquecido é erro na carga.

Um perfil pode herdar de outro com `"herda": "<perfil>"`: tags e comandos com o
mesmo nome são substituídos, o resto se soma, e as seções se mesclam campo a campo.

## Loja com 4 medidores, sem caixa d'água, com gerador de outra marca

```jsonc
{
  "planta": "Loja 118 — Bairro Alto",
  "medidores": [
    { "id": "geral", "perfil": "7kt0310-entrada", "tag_isa": "QGBT-01",
      "nome": "Entrada geral", "principal": true,
      "conexao": { "porta_serial": "/dev/ttyUSB0", "baud": 9600, "unit_id": 1 },
      "limites": { "corrente_a": { "max": 400 } } },

    { "id": "frios", "perfil": "7kt0310-alimentador", "tag_isa": "QD-02",
      "nome": "Refrigeração", "conexao": { "porta_serial": "/dev/ttyUSB0", "unit_id": 2 },
      "limites": { "corrente_a": { "max": 160 } } },

    { "id": "gmg", "perfil": "gerador-marca-b", "tag_isa": "GMG-01",
      "nome": "Grupo gerador", "conexao": { "porta_serial": "/dev/ttyUSB0", "unit_id": 9 } }
  ],
  "gerador": { "medidor": "gmg", "potencia_nominal_kw": 80,
               "capacidade_tanque_litros": 300, "consumo_litros_hora": 19 }
}
```

Sem equipamento do grupo `agua` e sem a seção `caixa_agua`, **a tela de Água
simplesmente não aparece no menu**. O mesmo vale para o gerador.

## Gerador de uma marca ainda não mapeada

1. Ligue o controlador na RS-485 e entre como técnico.
2. **Engenharia → Varredura**: descubra em que endereço ele responde.
3. **Engenharia → Terminal**: leia blocos de registradores e compare com o
   mostrador do próprio controlador. A tabela mostra o mesmo conteúdo como
   int16, uint16, float ABCD, CDAB, DCBA e uint32 lado a lado — a coluna que
   bater com o mostrador define `tipo` e `ordem_palavras`.
4. Copie `perfis/gerador-generico.json` para `perfis/gerador-<marca>.json` e
   ajuste os endereços. A estrutura das tags e dos alarmes continua a mesma, então
   a tela do gerador e o anunciador funcionam sem tocar em código.
5. **Engenharia → Configuração**: valide e aplique. A troca é a quente, sem
   derrubar o serviço nem perder histórico.

**Mantenha os nomes das tags.** O endereço muda de marca para marca; o nome, não.
Os indicadores (prontidão, partidas, queda de bateria no arranque, consumo medido,
autonomia) são calculados a partir de `estado`, `modo`, `nivel_diesel`,
`tensao_bateria`, `potencia`, `rede_presente`, `disjuntor_fechado` e dos bits
`falha_*`. Renomeou, o indicador correspondente passa a mostrar `––`; manteve, a
marca nova entra com tela, anunciador e indicadores prontos.

Se o controlador usar outra numeração de estados, ajuste a lista `estados` da seção
`gerador` na configuração da loja e o código do automático em `modo_automatico` —
é ali que o supervisório decide se o grupo conta como disponível.

## Rede de proteção

- Toda aplicação guarda a versão anterior em `dados/versoes/`, mantendo as 20 últimas.
- A validação recusa endereço Modbus repetido, tag inexistente, alarme órfão e
  bloco maior que o limite do equipamento.
- Se depois de aplicar **nenhum equipamento responder em 90 segundos**, o servidor
  volta sozinho para a configuração anterior. É o que evita perder o acesso ao
  supervisório por um erro de velocidade da serial.
- Cada aplicação fica registrada na auditoria com usuário, hora e origem.

## O que um perfil contém

```jsonc
{
  "titulo": "...", "fabricante": "...", "protocolo": "Modbus RTU",
  "equipamento": { "grupo": "gerador", "varredura_a_cada": 2 },
  "conexao": { "tipo": "rtu", "baud": 9600, "timeout_ms": 800 },
  "padrao": { "funcao": "holding", "tipo": "int16", "gap_maximo": 4 },
  "tags": [ /* mapa de registradores do modelo */ ],
  "alarmes": [ /* regras prontas; {nome} vira o nome do equipamento na loja */ ],
  "comandos": [ /* acionamentos, com intertravamento */ ],
  "gerador": { /* esqueleto da seção de tela — ver abaixo */ }
}
```

**A seção de tela também nasce no perfil.** Um perfil de gerador traz um bloco
`gerador` e um perfil de CLP com nível traz um bloco `caixa_agua`, com o que é do
modelo (estados, modos, lista de falhas, qual tag é o nível) e com os valores usuais
dos limites. O que é da instalação — tanque, consumo, capacidade do reservatório —
fica em branco no perfil e é preenchido em **Engenharia → Seções da instalação**.

Na prática: cadastrou o equipamento com o perfil certo, a tela correspondente já
existe e funciona; preencher os números é questão de minutos, pela tela, sem editar
arquivo.

Limites que variam por loja — corrente de disjuntor, demanda contratada —
ficam em branco no perfil e entram pelo `limites` do equipamento.
