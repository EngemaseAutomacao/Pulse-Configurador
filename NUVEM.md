# Envio para a nuvem (Engemase Pulse) — módulo versão 3

Este supervisório — o **Pulse Configurador**, instalado no **gateway** de cada unidade —
continua sendo a referência na unidade: lê o Modbus, guarda o histórico
em SQLite, calcula alarmes e consumo e funciona sem internet. Com `src/nuvem.js`, ele
passa a **copiar** as leituras para o Engemase Pulse na nuvem, onde o cliente
acessa pelo navegador ou pelo celular, com o login dele.

```
Gateway da unidade                                   Nuvem (Vercel)
configurador ── HTTPS, só de saída, a cada 10 s ──▶   POST /api/ingest
  SQLite = fila do que falta enviar                    medidores criados sozinhos
```

* **Nenhuma porta aberta na unidade** e nenhuma VPN para os dados: o gateway é que chama a nuvem.
  A VPN da central continua servindo para manutenção (SSH, engenharia).
* **Internet caiu:** a unidade segue normal; quando a conexão volta, o atraso sobe em lotes.
* **Os medidores nascem sozinhos na nuvem**, a partir dos equipamentos do grupo `energia`:
  nome, TAG ISA, entrada geral (`principal`), disjuntor (`limites.corrente_a.max`) e endereço.
* **Os alarmes daqui aparecem na nuvem** e avisam no celular de quem tem acesso ao
  cliente (prioridade `media` e `alta`). Ver [Alarmes](#alarmes).
* **Reservatório e grupo gerador também** (grupos `agua` e `gerador`), e o configurador declara
  quais módulos a unidade usa: o Pulse liga as telas sozinho. Ver [Módulos](#módulos-energia-água-e-gerador).

## Ligar numa unidade

1. Na nuvem: **Administração → Unidades → (a unidade) → Gateway da unidade → Gerar token**.
   O token aparece uma única vez; a tela mostra o trecho pronto.
2. No configurador, com um usuário **técnico**: cole o endereço do Pulse e o token. Pode
   colar o trecho inteiro que a tela do Pulse mostra: vale o `pnl_…` de dentro. Os módulos
   são opcionais (sem escolher, vale o que existe na instalação). O envio começa na hora,
   sem reiniciar o serviço. (A tela entra junto com a pasta `public/`, que ainda não está
   neste repositório; até lá, use as rotas abaixo ou a configuração.)

   A ligação fica em `dados/nuvem-<configuração>.json` (ex.: `dados/nuvem-config.planta.json`),
   com permissão só para o serviço — fora do `config.json`, das versões salvas pela Engenharia
   e do Git. O instalador preserva `dados/`, então atualizar o configurador não desfaz a ligação.

   Rotas (perfil técnico; as que mudam algo pedem o cabeçalho `X-Painel: 1`, como as demais):

   | Rota | O que faz |
   | --- | --- |
   | `GET /api/eng/nuvem` | endereço, final do token (4 caracteres), módulos, de onde vem a ligação (`interface` ou `configuracao`), último envio e erro |
   | `POST /api/eng/nuvem` | `{ url, token, modulos? }` grava a ligação; token em branco mantém o atual. Token de outra unidade faz o histórico subir de novo para ela |
   | `POST /api/eng/nuvem/remover` | apaga a ligação da interface (a seção `nuvem` do `config.json`, se houver, volta a valer) |

   **Também dá para pôr direto na configuração** (ex.: `/opt/supervisorio/config.planta.json`),
   logo abaixo de `"planta"`, e reiniciar o serviço:

   ```jsonc
   "nuvem": { "url": "https://engemase-pulse.vercel.app", "token": "pnl_…" },
   ```

   Opcionais (só na configuração): `"intervalo_s": 10` (envio ao vivo) e
   `"historico_inicial_dias": 7` (quanto do resumo de 5 min já gravado sobe no primeiro envio;
   o consumo por hora sobe inteiro). O que foi gravado pela interface vale por cima.
3. Acompanhe com `journalctl -u supervisorio -f` e, no Pulse, em Saúde do sistema.

**O token é uma senha:** fica só no gateway, nunca no repositório. Sem endereço e token, o
módulo não faz nada.

## Módulos: energia, água e gerador

O configurador diz à nuvem quais módulos a unidade usa, e o
**Engemase Pulse liga as telas sozinho** — ninguém precisa mexer na nuvem.

```jsonc
"nuvem": {
  "url": "https://engemase-pulse.vercel.app",
  "token": "pnl_…",
  "modulos": ["energia", "agua", "gerador"]   // opcional
}
```

* **Com `modulos`:** vale exatamente a lista. Serve para ligar o módulo antes de o
  equipamento existir (a tela do Pulse avisa que está aguardando) ou para deixar um
  equipamento só aqui.
* **Sem `modulos`:** vale o que está configurado — energia se houver medidor de
  energia, água se houver reservatório (`caixa_agua.medidor` ou equipamento do grupo
  `agua`), gerador se houver grupo gerador (`gerador.medidor` ou grupo `gerador`).
* A equipe Engemase ainda pode **desligar** um módulo por cliente na administração do
  Pulse (cliente que não contratou). Ligar, quem liga é o configurador.

### Reservatório (módulo Água)

1. Cadastre o CLP do reservatório com um perfil do grupo `agua` (`clp-reservatorio`,
   só nível; ou `clp-utilidades`, com vazão de entrada, pressão e bomba).
2. Na seção `caixa_agua`, aponte o equipamento e informe a capacidade:

   ```json
   "caixa_agua": { "medidor": "reservatorio", "capacidade_litros": 20000, "altura_util_m": 2.5 }
   ```

   Sem `capacidade_litros` o Pulse mostra o nível, mas não calcula volume, consumo
   em m³, autonomia nem o aviso de vazamento.
3. O que o Pulse usa: `nivel` (%), e se existirem `vazao_entrada` (m³/h),
   `bomba_ligada`, `bomba_falha`, `pressao_recalque`, `boia_baixo`/`boia_alto`.
   Com a vazão de entrada o consumo é medido; só com o nível, ele é calculado pela
   descida do reservatório (e estimado enquanto a bomba enche).

### Grupo gerador (módulo Gerador)

1. Cadastre o controlador com um perfil do grupo `gerador` (`gerador-generico`,
   `dse-8620`, `dse-8620-via-clp`…).
2. Na seção `gerador`, aponte o equipamento e preencha a instalação:

   ```json
   "gerador": { "medidor": "gmg", "potencia_nominal_kw": 260, "capacidade_tanque_litros": 500, "consumo_litros_hora": 55 }
   ```

3. O Pulse mostra o que o motor de indicadores daqui já calcula (`pronto`,
   `autonomia_h`, `diesel_litros`, `dias_sem_teste`), o `estado`, as falhas
   (`falha_*`), o diesel, a bateria e a lista de **corridas** (tabela
   `gerador_corridas`: motivo, resultado, duração, litros, queda da bateria).

O rótulo, a unidade e as casas decimais de cada tag vão junto, então o Pulse escreve
igual à tela daqui. Tags marcadas como `oculto` e equipamentos de outros grupos
(subestação, CLP de disjuntor…) ficam só aqui.

## O que é enviado

| Parte | Quando | De onde |
| --- | --- | --- |
| `equipamentos` | a cada 10 s | a última varredura (`ultimo.equipamentos`) + `principal`, `limites.corrente_a.max` e `conexao.unit_id` da configuração; em água e gerador, também `parametros` (seções `caixa_agua`/`gerador`) e `tags` (rótulo, unidade, casas) |
| `alarmes` | a cada 10 s, junto | os alarmes ativos (`ultimo.alarmes`, a lista inteira) |
| `alarmes_encerrados` | a cada minuto, o que falta | tabela `alarmes`, os já encerrados, pela ordem do `fim` |
| `resumo_5min` | a cada minuto, o que falta | tabela `resumo_5min` (energia, água e gerador), só janelas antes de `resumo_ate` (fechadas) |
| `consumo_horario` | a cada minuto, o que falta | tabela `consumo_horario`, pela ordem do `rowid` |
| `gerador_corridas` | a cada minuto, o que falta | tabela `gerador_corridas`, pela ordem do `id`; a em andamento vai de novo até terminar |
| `agente.modulos` | em todo envio | `nuvem.modulos` ou o que existe na configuração (ver Módulos) |

As marcas `nuvem_resumo_ate` e `nuvem_consumo_rowid` (tabela `marcas`) dizem até onde a
nuvem confirmou e só avançam depois de um HTTP 200. O `consolidar` só insere horas novas,
então o `rowid` só cresce — inclusive quando uma hora antiga é consolidada depois de o
servidor ficar parado. O histórico só começa a subir depois que a nuvem aceitou a lista de
equipamentos naquela execução (medidor que ela ainda não conhece teria o histórico descartado).

A varredura nunca espera a rede: `nuvem.aoVivo(ultimo)` dispara o envio e volta na hora.

Na nuvem, os nomes das grandezas de **energia** são traduzidos (`tensao_an → V1N`, `corrente_a → I1`,
`potencia_ativa → Total_kW`, `thd_corrente → THD_I1`…). Grandeza nova num perfil precisa
entrar nessa tradução (repositório do Engemase Pulse, `src/lib/painel-fields.ts`) para
aparecer na nuvem. Água e gerador vão com os nomes daqui, sem tradução.

## Alarmes

Os alarmes continuam sendo configurados e detectados aqui no configurador (limites, atraso de
confirmação e banda morta são os do `MotorAlarmes`). A cada envio ao vivo vai a lista
inteira dos ativos, e a nuvem só espelha:

| No configurador | Na nuvem |
| --- | --- |
| alarme novo na lista | abre o alarme (marcado "Gateway da unidade") e notifica no celular se a prioridade for `media` ou `alta` |
| some da lista (fechou) | fecha (normalizado) |
| `reconhecido` | marca como reconhecido no gateway |
| encerrado (com `fim`) | acerta o horário do fim; se a nuvem nunca soube dele (abriu e fechou com a internet fora), entra no histórico, sem notificar |
| reconhecido **na nuvem** | volta na resposta do envio e o configurador reconhece aqui também (fica na auditoria como “pela nuvem”) |

Prioridade: `alta` → Crítico, `media` → Atenção, `baixa` → Informativo. Alarme de
equipamento que não é de energia (gerador, CLP…) também aparece na nuvem. Como vai a
lista inteira, uma queda de internet se acerta no primeiro envio seguinte.

A marca `nuvem_alarmes_fim` / `nuvem_alarmes_id` (tabela `marcas`) diz até onde os
encerrados já foram; no primeiro envio sobem os dos últimos `historico_inicial_dias`.

## Quando algo não chega

O módulo escreve no log só quando o estado muda:

| Mensagem | Causa |
| --- | --- |
| `[nuvem] HTTP 401: Token inválido ou revogado` | token errado ou gerado de novo na nuvem |
| `[nuvem] sem conexão com a nuvem (…)` | internet da unidade, DNS ou firewall bloqueando a saída HTTPS |
| `[nuvem] lote recusado e pulado (HTTP 400 …)` | dado fora do formato; o lote é pulado para não travar a fila |
| `[nuvem] alarmes: …` | a nuvem recebeu as leituras mas não registrou os alarmes (tenta de novo a cada envio) |
| `[nuvem] envio restabelecido` | voltou ao normal |

Depois de uma falha, espera 10 s, 20 s, 40 s… até 5 min antes de tentar de novo. A nuvem
mostra o horário do último envio na tela da unidade. `nuvem.estado()` devolve
`{ ativa, ultimo_sucesso, erro }`, caso queira mostrar na Engenharia.

**Teste no PC com `npm run demo`:** use o token de uma unidade **de teste** na nuvem —
com o token da unidade real, os medidores simulados entrariam na unidade real.
