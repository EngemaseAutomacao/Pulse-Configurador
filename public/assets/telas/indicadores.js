import {
  estado, esc, num, valor, api, MODO_DEMO, dataHora, $, SEM_DADO,
} from '../nucleo.js';
import { placa } from './energia.js';

/**
 * Indicadores do grupo gerador.
 *
 * O valor instantâneo de um gerador diz pouco: ele passa quase todo o tempo
 * parado. O que responde "vai pegar quando faltar energia?" é o histórico —
 * prontidão, partidas que falharam, e principalmente a tensão da bateria
 * durante o arranque, que é onde a bateria velha se entrega antes de deixar a
 * loja no escuro.
 *
 * Os números vêm prontos do servidor (/api/gerador/indicadores): quem calcula
 * é quem tem o banco, não o navegador.
 */

const PERIODOS_IND = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias']];

const fichaInd = (rotulo, valor, unidade = '', apoio = '', nivel = '') => `
  <div class="indicador ${nivel}">
    <span class="rotulo">${esc(rotulo)}</span>
    <div class="n">${valor}${unidade ? `<span class="un">${esc(unidade)}</span>` : ''}</div>
    <div class="apoio">${apoio}</div>
  </div>`;

const horasInd = (h) => {
  if (h === null || h === undefined || !Number.isFinite(h)) return SEM_DADO;
  if (h >= 10) return num(h, 0);
  return num(h, 1);
};

/** Mini-gráfico das mínimas de partida: uma barra por corrida, a última à direita. */
function graficoBateria(historico, limite, critico) {
  if (!historico?.length) {
    return '<p class="nota" style="margin:10px 0 0">Ainda não há partidas registradas para comparar.</p>';
  }
  const L = 300; const A = 92; const base = A - 16; const topo = 8;
  const minimas = historico.map((h) => h.minima);
  const piso = Math.min(critico - 1.5, ...minimas) - 0.5;
  const teto = Math.max(limite + 2, ...minimas) + 0.5;
  const y = (v) => base - ((v - piso) / (teto - piso)) * (base - topo);
  const larg = Math.min(26, (L - 8) / historico.length) - 4;
  const passo = (L - 8) / historico.length;

  const barras = historico.map((h, i) => {
    const x = 4 + i * passo + (passo - larg) / 2;
    const yv = y(h.minima);
    const classe = h.minima < critico ? 'critico' : h.minima < limite ? 'atencao' : '';
    return `<rect class="barra-bat ${classe}" x="${x.toFixed(1)}" y="${yv.toFixed(1)}"
                  width="${larg.toFixed(1)}" height="${(base - yv).toFixed(1)}">
              <title>${esc(dataHora(h.ts))} — mínima ${num(h.minima, 1)} V, queda de ${num(h.queda, 1)} V</title>
            </rect>`;
  }).join('');

  return `
    <svg class="desenho" viewBox="0 0 ${L} ${A}" style="margin-top:10px"
         role="img" aria-label="Tensão mínima da bateria nas últimas partidas">
      <line class="limite-bat" x1="0" y1="${y(limite).toFixed(1)}" x2="${L}" y2="${y(limite).toFixed(1)}"/>
      <text class="rot" x="${L - 2}" y="${(y(limite) - 4).toFixed(1)}" text-anchor="end">mínimo ${num(limite, 0)} V</text>
      ${barras}
      <line class="cota" x1="0" y1="${base}" x2="${L}" y2="${base}"/>
      <text class="rot" x="0" y="${A - 3}">mais antiga</text>
      <text class="rot" x="${L}" y="${A - 3}" text-anchor="end">última partida</text>
    </svg>`;
}

/** Uma frase dizendo o que fazer — que é o que o gerente da loja vai ler. */
function vereditoBateria(bat) {
  const u = bat.ultima_queda;
  if (!u) return { nivel: '', texto: 'Sem partida registrada ainda. O primeiro arranque estabelece a referência.' };
  if (u.minima < bat.limite_critico_v) {
    return {
      nivel: 'critico',
      texto: `A tensão caiu a <b>${num(u.minima, 1)} V</b> no último arranque, abaixo do mínimo de `
        + `${num(bat.limite_critico_v, 0)} V. <b>Programe a troca da bateria</b> — o próximo arranque é aposta.`,
    };
  }
  if (u.minima < bat.limite_v) {
    return {
      nivel: 'atencao',
      texto: `Queda de <b>${num(u.queda, 1)} V</b> no arranque, chegando a ${num(u.minima, 1)} V. `
        + 'Ainda parte, mas a folga acabou: confira densidade, terminais e o carregador.',
    };
  }
  const piora = bat.queda_media !== null && u.queda > bat.queda_media * 1.25;
  return {
    nivel: piora ? 'atencao' : '',
    texto: piora
      ? `Última queda de <b>${num(u.queda, 1)} V</b> contra ${num(bat.queda_media, 1)} V de média — `
        + 'a bateria está piorando. Vale acompanhar nas próximas partidas.'
      : `Arranque firme: mínima de <b>${num(u.minima, 1)} V</b>, dentro do esperado para 24 V.`,
  };
}

export const blocoIndicadores = () => `
  <section class="bloco" id="gmg-indicadores">
    ${placa('GMG-01', 'Indicadores do período')}
    <div class="corpo">
      <div class="controles">
        <div class="grupo-botoes" role="group" aria-label="Período dos indicadores">
          ${PERIODOS_IND.map(([d, r], i) => `
            <button class="botao" data-dias="${d}" aria-pressed="${i === 1}">${r}</button>`).join('')}
        </div>
        <span class="rotulo" id="gmg-ind-quando" style="margin:0"></span>
      </div>
      <div id="gmg-ind-mosaico"><p class="nota">carregando…</p></div>
    </div>
  </section>`;

export const blocoBateria = () => `
  <section class="bloco">
    ${placa('BAT-01', 'Bateria e arranque')}
    <div class="corpo">
      <div class="leituras">
        <div class="leitura">
          <span class="rotulo">Tensão agora</span>
          <span class="valor g sem-dado"><span id="gmg-bat-agora">––</span><span class="un">V</span></span>
        </div>
        <div class="leitura">
          <span class="rotulo">Mínima no último arranque</span>
          <span class="valor sem-dado"><span id="gmg-bat-min">––</span><span class="un">V</span></span>
        </div>
        <div class="leitura">
          <span class="rotulo">Carregador</span>
          <span class="valor" style="font-size:16px"><span id="gmg-bat-carregador">––</span></span>
        </div>
      </div>
      <div id="gmg-bat-grafico"></div>
      <div class="veredito" id="gmg-bat-veredito">avaliando o histórico de partidas…</div>
    </div>
  </section>`;

export const blocoCorridas = () => `
  <section class="bloco">
    ${placa('GMG-01', 'Últimas partidas')}
    <div class="corpo">
      <div class="rolagem" id="gmg-corridas"><p class="nota">carregando…</p></div>
    </div>
  </section>`;

/* --------------------------------------------------------- comportamento */

export const indicadores = {
  _relogio: null,
  _dias: 30,
  _dados: null,

  aoMontar(raiz) {
    this._dias = 30;
    raiz.querySelectorAll('[data-dias]').forEach((b) => b.addEventListener('click', () => {
      this._dias = Number(b.dataset.dias);
      raiz.querySelectorAll('[data-dias]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      this.carregar(raiz);
    }));
    this.carregar(raiz);
    // histórico não muda a cada varredura: meio minuto basta e poupa o banco
    this._relogio = setInterval(() => this.carregar(raiz), 30000);
  },

  destruir() {
    clearInterval(this._relogio);
    this._relogio = null;
    this._dados = null;
  },

  async carregar(raiz) {
    const alvo = $('#gmg-ind-mosaico', raiz);
    if (!alvo || !alvo.isConnected) return;
    try {
      this._dados = MODO_DEMO
        ? simuladosDemo(this._dias)
        : await api(`/api/gerador/indicadores?dias=${this._dias}`);
      this.desenhar(raiz);
    } catch (e) {
      alvo.innerHTML = `<p class="nota">${esc(e.message)}</p>`;
    }
  },

  desenhar(raiz) {
    const d = this._dados;
    if (!d) return;
    const cfg = estado.config.gerador || {};
    const alvoDias = d.teste_a_cada_dias || 0;
    // a autonomia normalmente vem calculada do servidor; no modo demonstração (e
    // enquanto a primeira varredura não chega) ela sai do nível e do consumo
    const nivelAgora = valor(`${d.medidor}.nivel_diesel`);
    const lh = d.consumo_medido_lh || d.consumo_nominal_lh || cfg.consumo_litros_hora;
    const autonomia = valor(`${d.medidor}.autonomia_h`)
      ?? (nivelAgora === null || !lh || !cfg.capacidade_tanque_litros
        ? null : ((nivelAgora / 100) * cfg.capacidade_tanque_litros) / lh);
    const pronto = valor(`${d.medidor}.pronto`);

    const nivelProntidao = d.prontidao === null ? ''
      : d.prontidao < 90 ? 'critico' : d.prontidao < 98 ? 'atencao' : '';
    const nivelTeste = d.dias_sem_partir === null || !alvoDias ? ''
      : d.dias_sem_partir > alvoDias ? 'atencao' : '';
    const consumo = d.consumo_medido_lh;
    const desvio = consumo && d.consumo_nominal_lh
      ? ((consumo - d.consumo_nominal_lh) / d.consumo_nominal_lh) * 100 : null;

    $('#gmg-ind-mosaico', raiz).innerHTML = `<div class="indicadores">
      ${fichaInd('Prontidão no período', d.prontidao === null ? SEM_DADO : num(d.prontidao, 1), '%',
    pronto === null ? '' : pronto >= 0.5 ? 'pronto para partir agora' : 'indisponível agora', nivelProntidao)}
      ${fichaInd('Partidas', String(d.partidas),
    '', d.falhas_de_partida
      ? `<b>${d.falhas_de_partida}</b> não assumiram carga` : 'todas assumiram carga',
    d.falhas_de_partida ? 'critico' : '')}
      ${fichaInd('Horas de operação', horasInd(d.horas_operacao), 'h',
    d.pico_kw ? `pico de ${num(d.pico_kw, 0)} kW` : '')}
      ${fichaInd('Energia gerada', num(d.energia_kwh, 0), 'kWh',
    d.energia_kwh > 0 && d.horas_operacao > 0.05
      ? `média de ${num(d.energia_kwh / d.horas_operacao, 0)} kW` : '')}
      ${fichaInd('Consumo medido', consumo === null ? SEM_DADO : num(consumo, 1), 'L/h',
    consumo === null
      ? `catálogo: ${num(d.consumo_nominal_lh, 0)} L/h`
      : `${desvio > 0 ? '+' : ''}${num(desvio, 0)}% sobre o catálogo`,
    desvio !== null && Math.abs(desvio) > 20 ? 'atencao' : '')}
      ${fichaInd('Autonomia', autonomia === null ? SEM_DADO : num(autonomia, 1), 'h',
    'no consumo e no nível atuais',
    autonomia === null ? '' : autonomia < 4 ? 'critico' : autonomia < 8 ? 'atencao' : '')}
      ${fichaInd('Tempo de partida', d.tempo_medio_partida_s === null ? SEM_DADO
    : num(d.tempo_medio_partida_s, 0), 's', 'média até assumir a carga',
  d.tempo_medio_partida_s > 15 ? 'atencao' : '')}
      ${fichaInd('Sem partir há', d.dias_sem_partir === null ? SEM_DADO : num(d.dias_sem_partir, 1), 'd',
    alvoDias ? `teste a cada ${alvoDias} dias` : '', nivelTeste)}
    </div>`;

    const quando = $('#gmg-ind-quando', raiz);
    if (quando) {
      quando.textContent = d.em_corrida ? 'grupo em operação agora'
        : d.ultima_corrida ? `última partida em ${dataHora(d.ultima_corrida.inicio)}`
          : 'nenhuma partida registrada';
    }

    // ---- bateria
    const bat = d.bateria || {};
    const min = $('#gmg-bat-min', raiz);
    if (min) {
      const u = bat.ultima_queda;
      min.textContent = u ? num(u.minima, 1) : SEM_DADO;
      const caixa = min.closest('.leitura');
      caixa?.classList.toggle('anormal', !!u && u.minima < bat.limite_v);
      min.closest('.valor')?.classList.toggle('sem-dado', !u);
    }
    const graf = $('#gmg-bat-grafico', raiz);
    if (graf) graf.innerHTML = graficoBateria(bat.historico, bat.limite_v ?? 20, bat.limite_critico_v ?? 18);
    const vd = $('#gmg-bat-veredito', raiz);
    if (vd) {
      const v = vereditoBateria({ ...bat, limite_v: bat.limite_v ?? 20, limite_critico_v: bat.limite_critico_v ?? 18 });
      vd.className = `veredito ${v.nivel}`;
      vd.innerHTML = v.texto;
    }

    // ---- corridas
    const tabela = $('#gmg-corridas', raiz);
    if (tabela) {
      tabela.innerHTML = d.corridas.length ? `<table>
        <thead><tr>
          <th>Quando</th><th>Motivo</th><th>Duração</th><th>Partida</th>
          <th>Bateria</th><th>kWh</th><th>Resultado</th>
        </tr></thead>
        <tbody>${d.corridas.map((c) => {
    const ruim = /falha|desarme|não assumiu/.test(c.resultado || '');
    return `<tr class="${ruim ? 'prioridade-alta' : ''}">
              <td>${esc(dataHora(c.inicio))}</td>
              <td>${esc(c.motivo || '—')}</td>
              <td class="n">${c.duracao_s ? `${num(c.duracao_s / 60, 0)} min` : '—'}</td>
              <td class="n">${c.tempo_partida_s === null ? '—' : `${num(c.tempo_partida_s, 0)} s`}</td>
              <td class="n">${c.bateria_minima === null ? '—' : `${num(c.bateria_minima, 1)} V`}</td>
              <td class="n">${num(c.kwh, 1)}</td>
              <td>${esc(c.resultado || 'em andamento')}</td>
            </tr>`;
  }).join('')}</tbody></table>`
        : '<p class="vazio">Nenhuma partida no período.</p>';
    }

    // a tensão instantânea vem da varredura, não do histórico
    this.atualizarAgora(raiz, cfg);
  },

  /** Chamado a cada varredura pela tela do gerador. */
  atualizarAgora(raiz, cfg = estado.config.gerador || {}) {
    const id = cfg.medidor;
    const v = valor(`${id}.tensao_bateria`);
    const agora = $('#gmg-bat-agora', raiz);
    if (agora) {
      agora.textContent = v === null ? SEM_DADO : num(v, 1);
      agora.closest('.valor')?.classList.toggle('sem-dado', v === null);
    }
    const carregador = $('#gmg-bat-carregador', raiz);
    if (carregador) {
      const repousoMin = this._dados?.bateria?.repouso_minimo_v ?? cfg.bateria_repouso_min_v ?? 25.5;
      const falha = valor(`${id}.falha_carregador`);
      const est = valor(`${id}.estado`) ?? 0;
      const rodando = est >= 2 && est <= 4;   // no pré-aquecimento o alternador ainda não gira
      let texto = SEM_DADO; let cor = '';
      if (falha !== null && falha >= 0.5) { texto = 'em falha'; cor = 'var(--critico)'; }
      else if (v === null) { texto = SEM_DADO; }
      else if (rodando) { texto = 'alternador carregando'; }
      else if (v >= repousoMin) { texto = 'em flutuação'; }
      else { texto = 'não está carregando'; cor = 'var(--critico)'; }
      carregador.textContent = texto;
      carregador.style.color = cor || 'var(--tinta)';
    }
  },
};

/* Modo demonstração: o arquivo demo.html roda sem servidor, e um painel de
   indicadores vazio não mostra o produto. Os números abaixo são coerentes com
   o roteiro do simulador — inclusive a bateria se degradando. */
function simuladosDemo(dias) {
  const agora = Date.now();
  const partidas = Math.max(4, Math.round(dias / 7) * 2);
  const historico = Array.from({ length: Math.min(12, partidas) }, (_, i) => {
    const minima = 21.4 - i * 0.28 - (i > 7 ? 0.5 : 0);
    return { ts: agora - (12 - i) * 3 * 86400000, repouso: 26.9, minima, queda: 26.9 - minima };
  });
  const ultima = historico[historico.length - 1];
  return {
    medidor: (window.CONFIG_DEMO?.gerador || {}).medidor || 'gmg',
    dias,
    partidas,
    falhas_de_partida: dias >= 30 ? 1 : 0,
    horas_operacao: dias * 0.42,
    energia_kwh: dias * 0.42 * 96,
    litros_consumidos: dias * 0.42 * 34.6,
    consumo_medido_lh: 34.6,
    consumo_nominal_lh: 38,
    tempo_medio_partida_s: 9,
    pico_kw: 142,
    prontidao: 97.4,
    dias_sem_partir: 2.3,
    teste_a_cada_dias: 7,
    em_corrida: false,
    bateria: {
      repouso_minimo_v: 25.5,
      limite_v: 20,
      limite_critico_v: 18,
      ultima_queda: ultima,
      queda_media: historico.reduce((s, h) => s + h.queda, 0) / historico.length,
      pior_minima: Math.min(...historico.map((h) => h.minima)),
      historico,
    },
    ultima_corrida: {
      inicio: ultima.ts, fim: ultima.ts + 1800000, motivo: 'teste', resultado: 'normal',
      duracao_s: 1800, tempo_partida_s: 9, bateria_minima: ultima.minima, kwh: 48,
    },
    corridas: historico.slice().reverse().map((h, i) => ({
      inicio: h.ts,
      fim: h.ts + 1800000,
      motivo: i % 3 === 0 ? 'queda de rede' : 'teste',
      resultado: i === 4 ? 'falha de partida (bateria)' : 'normal',
      duracao_s: i === 4 ? 40 : 1800,
      tempo_partida_s: i === 4 ? null : 9,
      bateria_repouso: h.repouso,
      bateria_minima: h.minima,
      kwh: i === 4 ? 0 : 48,
      litros: i === 4 ? 0 : 17.3,
    })),
  };
}

export const _indicadoresInterno = { graficoBateria, vereditoBateria, simuladosDemo, fichaInd };
