/**
 * Derivações: traduzem registradores "crus" de um protocolo para as tags que o
 * supervisório entende.
 *
 * A tela do gerador, o anunciador e o motor de indicadores falam uma língua só:
 * `estado` (0 parado … 5 em falha), `modo`, `rede_presente`, `falha_*` ligada ou
 * desligada. Um controlador que já entrega isso pronto não precisa de nada aqui.
 * O Deep Sea (GenComm) entrega outra coisa — alarmes em códigos de 4 bits,
 * uma palavra de flags, modo com códigos próprios — e esta camada faz a ponte.
 *
 * Roda no coletor logo depois da leitura, então o resto do sistema (histórico,
 * alarmes, tendência, tela) trata as tags derivadas como qualquer outra.
 * Módulo puro: sem driver, sem banco — testável com um objeto de valores.
 */

const nulo = (v) => v === null || v === undefined || Number.isNaN(v);

/* ------------------------------------------------------------ GenComm (DSE) */

/**
 * Código de 4 bits de cada alarme nomeado (GenComm página 154):
 *   0 entrada desabilitada · 1 inativo · 2 advertência · 3 parada (shutdown)
 *   4 trip elétrico · 5 parada controlada · 8/9 indicação inativa
 *   10 indicação ativa · 15 não implementado neste controlador
 * Falha é 2 a 5. Indicação (10) é aviso de estado, não defeito.
 */
export const CODIGO_ALARME = {
  0: 'desabilitado', 1: 'inativo', 2: 'advertência', 3: 'parada', 4: 'trip elétrico',
  5: 'parada controlada', 8: 'indicação inativa', 9: 'indicação inativa', 10: 'indicação ativa', 15: 'não implementado',
};
const ativo = (codigo) => !nulo(codigo) && codigo >= 2 && codigo <= 5;

/**
 * Falhas que a tela mostra no anunciador, cada uma a partir de um ou mais
 * alarmes do DSE. Agrupadas pelo que o operador precisa saber, não pela lista
 * do fabricante: "baixa pressão de óleo" acende pelo sensor ou pelo pressostato.
 */
export const FALHAS_DSE = {
  falha_emergencia: ['dse_al_emergencia'],
  falha_pressao_oleo: ['dse_al_pressao_oleo', 'dse_al_nivel_oleo_chave'],
  falha_temperatura: ['dse_al_temperatura_alta', 'dse_al_temperatura_chave'],
  falha_sobrevelocidade: ['dse_al_sobrevelocidade'],
  falha_subvelocidade: ['dse_al_subvelocidade'],
  falha_frequencia: ['dse_al_subfrequencia', 'dse_al_sobrefrequencia'],
  falha_tensao: ['dse_al_subtensao', 'dse_al_sobretensao'],
  falha_bateria: ['dse_al_bateria_baixa', 'dse_al_bateria_alta'],
  falha_carregador: ['dse_al_alternador_carga'],
  falha_partida: ['dse_al_falha_partida'],
  falha_parada: ['dse_al_falha_parada'],
  falha_disjuntor: ['dse_al_disjuntor_gerador', 'dse_al_disjuntor_rede'],
  falha_sobrecorrente: ['dse_al_sobrecorrente'],
  falha_sobrecarga: ['dse_al_sobrecarga_kw'],
  falha_combustivel: ['dse_al_combustivel_baixo', 'dse_al_combustivel_chave'],
  falha_sensor: ['dse_al_sensor_oleo', 'dse_al_pickup_perdido', 'dse_al_pickup_aberto', 'dse_al_calibracao'],
  falha_ecu: ['dse_al_ecu_advertencia', 'dse_al_ecu_parada', 'dse_al_ecu_dados'],
};

/** Bits da palavra de status geral (página 3, registrador 6). Numeração 0–15. */
const FLAG = {
  NAO_CONFIGURADO: 15, FALHA_CONTROLADOR: 13, PARADA: 12, TRIP: 11, ADVERTENCIA: 10, PARADA_CONTROLADA: 6,
};
const bit = (palavra, n) => (nulo(palavra) ? null : (palavra >> n) & 1);

/**
 * Estado do grupo no código que a tela usa:
 *   0 Parado · 2 Partindo · 3 Em carga · 4 Em vazio/resfriando · 5 Em falha
 * O GenComm não entrega essa máquina de estados em forma padronizada (os
 * estados das páginas 27/28 variam por modelo), então ela é deduzida do que é
 * medido: alarme de parada ativo, rotação, frequência e potência. "Pré-aquecendo"
 * (1) não é distinguível e não é usado.
 */
export function estadoDoGrupo(v, opcoes = {}) {
  const flags = v.dse_flags;
  if (bit(flags, FLAG.PARADA) || bit(flags, FLAG.TRIP) || bit(flags, FLAG.PARADA_CONTROLADA)) return 5;
  if (nulo(v.rotacao) && nulo(v.frequencia)) return null;
  const girando = (v.rotacao ?? 0) > (opcoes.rpm_parado ?? 100) || (v.frequencia ?? 0) > 5;
  if (!girando) return 0;
  // abaixo de 90 % da frequência nominal ainda está acelerando
  const estavel = (v.frequencia ?? 0) >= (opcoes.frequencia_nominal_hz ?? 60) * 0.9;
  if (!estavel) return 2;
  // disjuntor do gerador fechado (quando o controlador informa) é carga mesmo
  // com potência baixa — em paralelo com a rede o grupo pode estar a 0 kW
  const carga = v.disjuntor_fechado === 1
    || (v.potencia ?? 0) >= (opcoes.limiar_carga_kw ?? 1) || (v.carga_pct ?? 0) >= 2;
  return carga ? 3 : 4;
}

/**
 * Rede presente: frequência de rede plausível e alguma fase com tensão.
 * Controladores só de partida (sem medição de rede, ex. DSE7310/6110) devolvem
 * sentinela — aí fica sem dado, em vez de afirmar "rede ausente" o tempo todo.
 * Com `mede_rede: false` nas opções, nem tenta.
 */
export function redePresente(v, opcoes = {}) {
  if (opcoes.mede_rede === false) return null;
  const fases = [v.rede_tensao_an, v.rede_tensao_bn, v.rede_tensao_cn].filter((x) => !nulo(x));
  if (nulo(v.rede_frequencia) && !fases.length) return null;
  const minima = opcoes.rede_minima_v ?? 80;    // fase-neutro; 127 V ou 220 V passam
  const temTensao = fases.some((x) => x >= minima);
  const temFrequencia = !nulo(v.rede_frequencia) && v.rede_frequencia >= 40 && v.rede_frequencia <= 70;
  return temTensao && temFrequencia ? 1 : 0;
}

function derivarGencomm(v, opcoes = {}) {
  const saida = {};
  // o perfil de um modelo pode acrescentar falhas ou ampliar as fontes de uma
  // existente (`derivar_opcoes.falhas_extra`), sem mexer no código
  const falhas = { ...FALHAS_DSE, ...(opcoes.falhas_extra || {}) };
  for (const [falha, fontes] of Object.entries(falhas)) {
    const lidas = fontes.map((f) => v[f]).filter((c) => !nulo(c) && c !== 15);
    // nenhuma fonte implementada neste modelo: sem dado, não "sem falha"
    saida[falha] = lidas.length ? (lidas.some(ativo) ? 1 : 0) : null;
  }
  const m = v.dse_al_manutencao;
  saida.manutencao_vencida = nulo(m) || m === 15 ? null : (ativo(m) ? 1 : 0);

  const f = v.dse_flags;
  saida.alarme_parada = bit(f, FLAG.PARADA) === null ? null : (bit(f, FLAG.PARADA) || bit(f, FLAG.PARADA_CONTROLADA) ? 1 : 0);
  saida.alarme_trip = bit(f, FLAG.TRIP);
  saida.alarme_advertencia = bit(f, FLAG.ADVERTENCIA);
  saida.controlador_falha = nulo(f) ? null : (bit(f, FLAG.FALHA_CONTROLADOR) || bit(f, FLAG.NAO_CONFIGURADO) ? 1 : 0);

  saida.estado = estadoDoGrupo(v, opcoes);
  saida.rede_presente = redePresente(v, opcoes);
  return saida;
}

/* ------------------------------------------------- harmônicas (medidores) */

/**
 * Corrente harmônica de cada fase, em ampères, a partir da corrente eficaz e
 * do THD de corrente (% da fundamental): Ih = I · THD / √(1 + THD²).
 * É o que aponta quem polui a entrada: o THD em % sozinho engana — um setor
 * quase sem carga mostra 80 % com 2 A, e quem pesa na entrada é quem injeta
 * mais ampères de harmônica.
 */
function derivarHarmonicas(v) {
  const saida = {};
  for (const [f, tagThd] of [['a', 'thd_corrente'], ['b', 'thd_corrente_b'], ['c', 'thd_corrente_c']]) {
    const i = v[`corrente_${f}`];
    const thd = v[tagThd];
    saida[`corrente_harmonica_${f}`] = nulo(i) || nulo(thd)
      ? null
      : (Math.abs(i) * (thd / 100)) / Math.sqrt(1 + (thd / 100) ** 2);
  }
  // uma série por setor no gráfico de comparação: a fase que mais injeta
  const fases = ['a', 'b', 'c'].map((f) => saida[`corrente_harmonica_${f}`]).filter((x) => !nulo(x));
  saida.corrente_harmonica = fases.length ? Math.max(...fases) : null;
  return saida;
}

/* ------------------------------------------------------------------ registro */

export const DERIVACOES = {
  'dse-gencomm': derivarGencomm,
  harmonicas: derivarHarmonicas,
};

/**
 * Aplica a derivação declarada no equipamento (`derivar`, vindo do perfil)
 * sobre os valores lidos. Sempre sobrescreve, inclusive com nulo: os valores
 * partem da leitura anterior, e um derivado que deixou de existir (sensor que
 * virou sentinela) não pode ficar congelado no último valor bom.
 */
export function aplicarDerivacao(def, valores) {
  const fn = def?.derivar && DERIVACOES[def.derivar];
  if (!fn) return valores;
  for (const [nome, valor] of Object.entries(fn(valores, def.derivar_opcoes || {}))) {
    valores[nome] = valor ?? null;
  }
  return valores;
}
