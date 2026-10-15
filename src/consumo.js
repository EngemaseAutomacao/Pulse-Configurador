/**
 * Consumo de energia hora a hora, por setor.
 *
 * A fonte preferida é o CONTADOR de energia do medidor (kWh acumulado): o
 * consumo de uma hora é o valor do contador no fim da hora menos o valor no
 * início. É o que o medidor de faturamento faz, e a soma das horas bate com o
 * total do dia. Só quando o contador não serve (falha de comunicação na virada
 * da hora, troca ou zeramento do medidor) a hora é ESTIMADA pela potência média
 * vezes a duração — e a tela diz isso.
 *
 * Horas fechadas são consolidadas numa tabela própria (consumo_horario): o
 * histórico bruto é apagado depois de alguns dias, o consumo por hora fica.
 *
 * As funções de cálculo são puras (recebem amostras, devolvem números) para
 * serem testadas sem banco.
 */

const HORA = 3600000;

/**
 * Valor do contador no instante t, a partir das amostras gravadas
 * (ordenadas por ts). Interpola entre a última amostra antes e a primeira
 * depois, se estiverem a até 2 × `tolerancia` uma da outra — o contador anda
 * de forma linear. Uma amostra de um lado só vale apenas se estiver colada no
 * instante (`proximo`): uma leitura de 10 min atrás usada como "valor na
 * virada" jogaria consumo de uma hora para a outra.
 * Contador que andou para trás entre as duas (zerado, trocado) não tem valor.
 */
export function contadorEm(amostras, t, tolerancia = 10 * 60000, proximo = 60000) {
  if (!amostras?.length) return null;
  // busca binária: a primeira amostra com ts >= t
  let lo = 0;
  let hi = amostras.length;
  while (lo < hi) {
    const meio = (lo + hi) >> 1;
    if (amostras[meio].ts < t) lo = meio + 1; else hi = meio;
  }
  const depois = amostras[lo] || null;
  const antes = lo > 0 ? amostras[lo - 1] : null;
  if (depois && depois.ts === t) return depois.valor;
  if (antes && depois && depois.ts - antes.ts <= 2 * tolerancia) {
    if (depois.valor < antes.valor) return null;
    return antes.valor + ((depois.valor - antes.valor) * (t - antes.ts)) / (depois.ts - antes.ts);
  }
  if (antes && t - antes.ts <= proximo) return antes.valor;
  if (depois && depois.ts - t <= proximo) return depois.valor;
  return null;
}

/**
 * Consumo de um intervalo [ini, fim).
 *   energia   amostras do contador (kWh), ordenadas
 *   potencia  { media, amostras } da potência ativa (kW) no intervalo, ou null
 *   esperadas quantas amostras de potência o intervalo teria sem falhas
 * Devolve { kwh, fonte: 'contador' | 'potencia' | null }.
 */
export function consumoDoIntervalo({ energia, potencia, ini, fim, esperadas, tolerancia, proximo }) {
  const e0 = contadorEm(energia, ini, tolerancia, proximo);
  const e1 = contadorEm(energia, fim, tolerancia, proximo);
  if (e0 !== null && e1 !== null && e1 >= e0) return { kwh: e1 - e0, fonte: 'contador' };
  // estimativa só com pelo menos metade da hora coberta por leituras
  if (potencia && potencia.amostras >= Math.max(1, esperadas / 2) && Number.isFinite(potencia.media)) {
    return { kwh: Math.max(0, potencia.media) * ((fim - ini) / HORA), fonte: 'potencia' };
  }
  return { kwh: null, fonte: null };
}

/** Os 25 limites (meia-noite a meia-noite) de um dia "AAAA-MM-DD", no fuso do servidor. */
export function limitesDoDia(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia || ''));
  if (!m) return null;
  const [a, me, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const limites = Array.from({ length: 25 }, (_, h) => new Date(a, me, d, h).getTime());
  return Number.isFinite(limites[0]) && new Date(limites[0]).getDate() === d ? limites : null;
}

export function diaDe(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * As duas energias que a tela de Consumo mostra. A ativa (kWh) é a da conta de
 * energia; a aparente (kVAh) inclui a parcela reativa — a diferença entre as
 * duas é o efeito do fator de potência.
 */
export const GRANDEZAS = {
  ativa: { energia: 'energia_ativa', potencia: 'potencia_ativa', uEnergia: /^kwh$/i, uPotencia: /^kw$/i, unidade: 'kWh' },
  aparente: { energia: 'energia_aparente', potencia: 'potencia_aparente', uEnergia: /^kvah$/i, uPotencia: /^kva$/i, unidade: 'kVAh' },
};

/** Quais tags de um equipamento servem para o consumo de uma grandeza: o contador e a potência. */
export function tagsDeConsumo(eq, grandeza = 'ativa') {
  const g = GRANDEZAS[grandeza] || GRANDEZAS.ativa;
  const tags = eq?.tags || [];
  const energia = tags.find((t) => t.nome === g.energia)
    || tags.find((t) => t.acumulador && g.uEnergia.test(t.unidade || ''));
  const potencia = tags.find((t) => t.nome === g.potencia)
    || tags.find((t) => !t.calculada && g.uPotencia.test(t.unidade || ''));
  return { energia: energia?.nome || null, potencia: potencia?.nome || null };
}

/** Equipamentos de energia que medem consumo: o principal (entrada) e os setores. */
export function medidoresDeConsumo(config, grandeza = 'ativa') {
  return (config.medidores || [])
    .filter((m) => (m.grupo || 'energia') === 'energia')
    .map((m) => ({ m, ...tagsDeConsumo(m, grandeza) }))
    .filter((x) => x.energia || x.potencia);
}

/**
 * Consumo de um medidor nas horas indicadas (limites[h] .. limites[h+1]).
 * Lê do banco o que precisa; não grava nada.
 */
export function calcularHoras(banco, { id, energia, potencia }, limites, agora, intervaloS) {
  const tolerancia = Math.max(10 * 60000, intervaloS * 4000);
  // o contador é lento (lido a cada ~20 ciclos) e gravado a cada intervaloS:
  // "colado na virada" é até 4 gravações de distância, no mínimo 1 min
  const proximo = Math.max(60000, intervaloS * 4000);
  const ini = limites[0];
  const fim = Math.min(limites[limites.length - 1], agora);
  const amostrasE = energia ? banco.amostrasEntre(`${id}.${energia}`, ini - tolerancia, fim + tolerancia) : [];
  const medias = potencia ? banco.mediaPorHora(`${id}.${potencia}`, ini, fim) : new Map();
  const saida = [];
  for (let h = 0; h < limites.length - 1; h++) {
    const a = limites[h];
    const b = Math.min(limites[h + 1], agora);
    if (a >= agora) { saida.push({ hora: a, kwh: null, fonte: null, futura: true }); continue; }
    const esperadas = ((b - a) / 1000) / Math.max(1, intervaloS);
    const r = consumoDoIntervalo({
      energia: amostrasE, potencia: medias.get(a) || null, ini: a, fim: b, esperadas, tolerancia, proximo,
    });
    saida.push({ hora: a, ...r, parcial: b < limites[h + 1] });
  }
  return saida;
}

/**
 * Consolida as horas FECHADAS das últimas `horasAtras` horas na tabela de
 * consumo. Chamado periodicamente pelo servidor: o histórico bruto pode ser
 * apagado depois, o consumo por hora fica.
 */
export function consolidar(banco, config, agora = Date.now(), horasAtras = 48) {
  const intervaloS = config.historico?.intervalo_gravacao_s || 60;
  const ultimaFechada = new Date(agora);
  ultimaFechada.setMinutes(0, 0, 0);
  const fim = ultimaFechada.getTime();
  const limites = Array.from({ length: horasAtras + 1 }, (_, i) => fim - (horasAtras - i) * HORA);
  let gravadas = 0;
  for (const grandeza of Object.keys(GRANDEZAS)) {
    for (const x of medidoresDeConsumo(config, grandeza)) {
      const ja = new Set(banco.consumoGravado(x.m.id, limites[0], fim, grandeza).map((r) => r.hora));
      const novas = calcularHoras(banco, { id: x.m.id, energia: x.energia, potencia: x.potencia }, limites, fim + 1, intervaloS)
        .filter((r) => r.kwh !== null && !r.parcial && !ja.has(r.hora));
      if (novas.length) {
        banco.gravarConsumo(novas.map((r) => ({ medidor: x.m.id, grandeza, hora: r.hora, kwh: r.kwh, fonte: r.fonte })));
        gravadas += novas.length;
      }
    }
  }
  return gravadas;
}

/**
 * O dia inteiro, pronto para a tela: horas fechadas da tabela consolidada (ou
 * calculadas na hora, se ainda não consolidadas), a hora corrente ao vivo.
 */
export function consumoDoDia(banco, config, dia, agora = Date.now(), grandeza = 'ativa') {
  const limites = limitesDoDia(dia);
  if (!limites || !GRANDEZAS[grandeza]) return null;
  const intervaloS = config.historico?.intervalo_gravacao_s || 60;
  const medidores = medidoresDeConsumo(config, grandeza);

  const setores = medidores.map((x) => {
    const gravado = new Map(banco.consumoGravado(x.m.id, limites[0], limites[24], grandeza).map((r) => [r.hora, r]));
    const precisaCalcular = limites.slice(0, 24).some((h) => h < agora && !gravado.has(h));
    const calculado = precisaCalcular
      ? calcularHoras(banco, { id: x.m.id, energia: x.energia, potencia: x.potencia }, limites, agora, intervaloS)
      : [];
    const horas = limites.slice(0, 24).map((h, i) => {
      const g = gravado.get(h);
      if (g) return { kwh: g.kwh, fonte: g.fonte, parcial: false };
      const c = calculado[i];
      if (!c || c.futura) return { kwh: null, fonte: null, parcial: false, futura: h >= agora };
      return { kwh: c.kwh, fonte: c.fonte, parcial: !!c.parcial };
    });
    const validas = horas.filter((r) => r.kwh !== null);
    return {
      id: x.m.id,
      nome: x.m.nome,
      tag_isa: x.m.tag_isa || null,
      principal: !!x.m.principal,
      kwh: horas.map((r) => (r.kwh === null ? null : +r.kwh.toFixed(3))),
      fonte: horas.map((r) => r.fonte),
      parcial: horas.map((r) => r.parcial),
      futura: horas.map((r) => !!r.futura),
      total: validas.length ? +validas.reduce((s, r) => s + r.kwh, 0).toFixed(3) : null,
      horas_sem_dado: horas.filter((r) => r.kwh === null && !r.futura).length,
    };
  });

  // não medido = entrada geral menos a soma dos setores, só nas horas em que
  // todos têm valor; negativo (erro de medição) vira zero
  const geral = setores.find((s) => s.principal) || null;
  const ramais = setores.filter((s) => !s.principal);
  // energia aparente não se soma (cada setor tem o seu fator de potência): a
  // aparente da entrada não é a soma das aparentes dos setores, então
  // "entrada menos setores" não significa "não medido" — fica sem cálculo
  const naoMedido = grandeza === 'ativa' && geral && ramais.length
    ? geral.kwh.map((g, h) => {
      if (g === null || ramais.some((s) => s.kwh[h] === null)) return null;
      return +Math.max(0, g - ramais.reduce((t, s) => t + s.kwh[h], 0)).toFixed(3);
    })
    : null;

  return {
    dia,
    grandeza,
    unidade: GRANDEZAS[grandeza].unidade,
    horas: limites.slice(0, 24),
    agora,
    geral: geral?.id || null,
    setores,
    nao_medido: naoMedido,
  };
}
