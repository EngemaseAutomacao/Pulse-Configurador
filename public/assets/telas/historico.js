import { estado, esc, num, serie, $ } from '../nucleo.js';
import { placa } from './energia.js';
import { desenharComparacao, PALETA_SERIES } from '../grafico.js';

// sem prazo fixo de histórico (vai até o disco apertar): os períodos longos
// mostram o que houver; de 7 dias para cima vêm das médias de 5 min
const PERIODOS = [[1, '1 h'], [6, '6 h'], [24, '24 h'], [168, '7 dias'], [720, '30 dias'], [2160, '90 dias'], [8760, '1 ano']];
const HIST_MAX_SERIES = PALETA_SERIES.length;

/** Comparações prontas, montadas a partir das tags que cada equipamento tem. */
function histAtalhos() {
  const saida = [];
  const eqs = estado.config.equipamentos;
  const conjunto = (eq, nomes) => nomes.filter((n) => eq.tags.some((t) => t.nome === n)).map((n) => `${eq.id}.${n}`);
  for (const eq of eqs) {
    const correntes = conjunto(eq, ['corrente_a', 'corrente_b', 'corrente_c', 'corrente_n']);
    if (correntes.length >= 2) saida.push({ id: `${eq.id}:correntes`, rotulo: `${eq.nome} · correntes das fases`, tags: correntes });
    const fn = conjunto(eq, ['tensao_an', 'tensao_bn', 'tensao_cn']);
    if (fn.length >= 2) saida.push({ id: `${eq.id}:tensoes`, rotulo: `${eq.nome} · tensões fase-neutro`, tags: fn });
    const ff = conjunto(eq, ['tensao_ab', 'tensao_bc', 'tensao_ca']);
    if (ff.length >= 2) saida.push({ id: `${eq.id}:tensoes_ff`, rotulo: `${eq.nome} · tensões fase-fase`, tags: ff });
    const energias = conjunto(eq, ['energia_ativa', 'energia_aparente']);
    if (energias.length === 2) saida.push({ id: `${eq.id}:energias`, rotulo: `${eq.nome} · energia ativa e aparente`, tags: energias });
    const potencias = conjunto(eq, ['potencia_ativa', 'potencia_aparente']);
    if (potencias.length === 2) saida.push({ id: `${eq.id}:potencias`, rotulo: `${eq.nome} · potência ativa e aparente`, tags: potencias });
    const thdI = conjunto(eq, ['thd_corrente', 'thd_corrente_b', 'thd_corrente_c']);
    if (thdI.length >= 2) saida.push({ id: `${eq.id}:thd_corrente`, rotulo: `${eq.nome} · THD de corrente das fases`, tags: thdI });
    const thdV = conjunto(eq, ['thd_tensao', 'thd_tensao_b', 'thd_tensao_c']);
    if (thdV.length >= 2) saida.push({ id: `${eq.id}:thd_tensao`, rotulo: `${eq.nome} · THD de tensão das fases`, tags: thdV });
    const ih = conjunto(eq, ['corrente_harmonica_a', 'corrente_harmonica_b', 'corrente_harmonica_c']);
    if (ih.length >= 2) saida.push({ id: `${eq.id}:harmonicas`, rotulo: `${eq.nome} · corrente harmônica das fases`, tags: ih });
  }
  // rastrear quem polui: os setores lado a lado (a entrada fica de fora — o THD
  // dela é sobre outra base, e assim cabem os 8 setores no gráfico)
  const setores = eqs.filter((e) => (e.grupo || 'energia') === 'energia' && !e.principal);
  const deTodos = (nome) => setores.filter((e) => e.tags.some((t) => t.nome === nome)).map((e) => `${e.id}.${nome}`);
  const ihSetores = deTodos('corrente_harmonica');
  if (ihSetores.length >= 2) {
    saida.unshift({ id: 'setores:harmonica', rotulo: 'Corrente harmônica de cada setor (maior fase)', tags: ihSetores.slice(0, HIST_MAX_SERIES) });
  }
  const thdSetores = deTodos('thd_corrente');
  if (thdSetores.length >= 2) {
    saida.unshift({ id: 'setores:thd', rotulo: 'THD de corrente (I1) de cada setor', tags: thdSetores.slice(0, HIST_MAX_SERIES) });
  }
  const potencias = eqs.filter((e) => (e.grupo || 'energia') === 'energia' && e.tags.some((t) => t.nome === 'potencia_ativa'))
    .sort((a, b) => Number(!!b.principal) - Number(!!a.principal))
    .map((e) => `${e.id}.potencia_ativa`);
  if (potencias.length >= 2) {
    saida.unshift({ id: 'todos:potencia', rotulo: 'Potência ativa de todos os medidores', tags: potencias.slice(0, HIST_MAX_SERIES) });
  }
  return saida;
}

/** mín · méd · máx do período de uma série agregada */
function histEstat(pontos) {
  if (!pontos?.length) return null;
  return {
    min: Math.min(...pontos.map((p) => p.min)),
    max: Math.max(...pontos.map((p) => p.max)),
    med: pontos.reduce((s, p) => s + p.med, 0) / pontos.length,
  };
}

export const telaHistorico = {
  id: 'historico',
  isa: '',
  nome: 'Histórico',
  titulo: 'Histórico',
  _limpar: null,
  _series: null,      // [{ tag, cor }] — a cor fica com a grandeza enquanto ela estiver no gráfico
  _horas: 24,

  montar() {
    const grupos = { energia: 'Energia', subestacao: 'Subestação', agua: 'Água', gerador: 'Gerador' };
    const opcoes = Object.entries(grupos).map(([g, rotulo]) => {
      const itens = estado.config.equipamentos
        .filter((e) => (e.grupo || 'energia') === g)
        .flatMap((e) => e.tags
          // grandeza com valor numérico: o fator de potência não tem unidade, mas
          // entra; ficam de fora só os sinais liga/desliga, os códigos de estado
          // e os registros internos ocultos sem unidade (ex.: alarmes do DSE)
          .filter((t) => !t.digital && !t.enum && (t.unidade !== '' || !t.oculto))
          .map((t) => `<option value="${e.id}.${t.nome}">${esc(e.nome)} · ${esc(t.rotulo)}</option>`));
      return itens.length ? `<optgroup label="${rotulo}">${itens.join('')}</optgroup>` : '';
    }).join('');
    const atalhos = histAtalhos();

    if (!this._series) {
      const principal = estado.config.equipamentos.find((e) => e.principal);
      this._series = principal ? [{ tag: `${principal.id}.potencia_ativa`, cor: PALETA_SERIES[0] }] : [];
    }

    return `
      <section class="bloco">
        ${placa('', 'Tendência')}
        <div class="corpo">
          <div class="controles">
            <select id="hist-tag" aria-label="Adicionar grandeza ao gráfico">
              <option value="">+ adicionar grandeza ao gráfico…</option>${opcoes}
            </select>
            ${atalhos.length ? `<select id="hist-atalho" aria-label="Comparação pronta">
              <option value="">comparação pronta…</option>
              ${atalhos.map((a) => `<option value="${esc(a.id)}">${esc(a.rotulo)}</option>`).join('')}
            </select>` : ''}
            <div class="grupo-botoes" role="group" aria-label="Período">
              ${PERIODOS.map(([h, r]) => `<button class="botao" data-horas="${h}"
                    aria-pressed="${h === this._horas}">${r}</button>`).join('')}
            </div>
          </div>
          <div class="hist-series" id="hist-series" aria-label="Grandezas no gráfico"></div>
          <div class="hist-paineis" id="hist-paineis"></div>
        </div>
      </section>`;
  },

  aoMontar(raiz) {
    const sel = $('#hist-tag', raiz);
    const atalho = $('#hist-atalho', raiz);
    let pedido = 0;
    let dados = new Map();        // tag → pontos do último desenho
    let geometrias = [];          // por painel, para o mouse virar instante

    const defDe = (tag) => {
      const [id, nome] = String(tag).split('.');
      const eq = estado.config.equipamentos.find((e) => e.id === id);
      const t = eq?.tags.find((x) => x.nome === nome);
      return t ? { eq, t } : null;
    };

    const desenharEtiquetas = () => {
      const alvo = $('#hist-series', raiz);
      if (!alvo) return;
      alvo.innerHTML = this._series.map((s, i) => {
        const d = defDe(s.tag);
        const e = histEstat(dados.get(s.tag));
        const casas = d?.t.decimais ?? 1;
        const un = d?.t.unidade || '';
        return `<span class="hist-chip">
          <i style="background:${s.cor}" aria-hidden="true"></i>
          <b>${esc(d ? `${d.eq.nome} · ${d.t.rotulo}` : s.tag)}</b>
          <span class="hist-chip-num">${e ? `mín ${num(e.min, casas)} · méd ${num(e.med, casas)} · máx ${num(e.max, casas)} ${esc(un)}` : 'sem registro'}</span>
          <button class="hist-tirar" data-tirar="${i}" title="tirar do gráfico" aria-label="tirar ${esc(d?.t.rotulo || s.tag)} do gráfico">×</button>
        </span>`;
      }).join('') + (this._series.length > 1
        ? '<button class="botao" data-limpar-series>limpar</button>' : '')
        + (this._series.length >= HIST_MAX_SERIES ? `<span class="rotulo" style="margin:0">máximo de ${HIST_MAX_SERIES} grandezas</span>` : '');
      alvo.querySelectorAll('[data-tirar]').forEach((b) => b.addEventListener('click', () => {
        this._series.splice(Number(b.dataset.tirar), 1);
        desenhar();
      }));
      alvo.querySelectorAll('[data-limpar-series]').forEach((b) => b.addEventListener('click', () => {
        this._series = this._series.slice(0, 1);
        desenhar();
      }));
    };

    const desenhar = async () => {
      const meu = ++pedido;
      const tags = this._series.map((s) => s.tag);
      const lidos = await Promise.all(tags.map((t) => serie(t, this._horas)));
      if (meu !== pedido) return;
      dados = new Map(tags.map((t, i) => [t, lidos[i] || []]));
      desenharEtiquetas();

      const area = $('#hist-paineis', raiz);
      if (!area || !area.isConnected) return;
      if (!this._series.length) {
        area.innerHTML = '<p class="vazio">Escolha uma grandeza na lista acima.</p>';
        return;
      }
      // um painel por unidade: corrente e potência nunca dividem o mesmo eixo
      const porUnidade = new Map();
      for (const s of this._series) {
        const un = defDe(s.tag)?.t.unidade || '';
        if (!porUnidade.has(un)) porUnidade.set(un, []);
        porUnidade.get(un).push(s);
      }
      const paineis = [...porUnidade.entries()];
      const altura = paineis.length === 1 ? 320 : paineis.length === 2 ? 230 : 190;
      area.innerHTML = paineis.map(([un], i) => `
        <div class="hist-painel">
          <div class="hist-area" data-painel="${i}">
            <canvas id="hist-c-${i}" style="height:${altura}px" aria-label="Gráfico em ${esc(un || 'sem unidade')}"></canvas>
            <div class="hist-cruz" id="hist-cruz-${i}" hidden></div>
          </div>
        </div>`).join('') + '<div class="hist-dica" id="hist-dica" hidden></div>';

      // mesmo intervalo em todos os painéis: os tempos ficam alinhados na vertical
      const todos = [...dados.values()].filter((p) => p.length);
      const t0 = todos.length ? Math.min(...todos.map((p) => p[0].t)) : 0;
      const t1 = todos.length ? Math.max(...todos.map((p) => p[p.length - 1].t)) : 0;
      geometrias = paineis.map(([un, lista], i) => {
        const canvas = $(`#hist-c-${i}`, raiz);
        if (!canvas) return null;
        const marcas = lista.length === 1 ? (estado.config.limites || [])
          .filter((r) => r.tag === lista[0].tag)
          .flatMap((r) => [
            r.min !== undefined ? { valor: r.min, rotulo: `mín ${r.min}`, prioridade: r.prioridade } : null,
            r.max !== undefined ? { valor: r.max, rotulo: `máx ${r.max}`, prioridade: r.prioridade } : null,
          ].filter(Boolean)) : [];
        const g = desenharComparacao(canvas, lista.map((s) => ({
          pontos: dados.get(s.tag), cor: s.cor, unidade: un,
        })), { t0, t1, marcas, unidade: un });
        return g ? { ...g, lista } : null;
      });
      ligarMouse();
    };

    // linha vertical em todos os painéis + valores de todas as séries no instante
    const ligarMouse = () => {
      const dica = $('#hist-dica', raiz);
      raiz.querySelectorAll('.hist-area').forEach((areaP) => {
        const indice = Number(areaP.dataset.painel);
        areaP.addEventListener('mousemove', (ev) => {
          const g = geometrias[indice];
          if (!g || !areaP.getBoundingClientRect) return;
          const caixa = areaP.getBoundingClientRect();
          const x = ev.clientX - caixa.left;
          if (x < g.esquerda || x > g.esquerda + g.largura) { esconder(); return; }
          const t = g.t0 + ((x - g.esquerda) / g.largura) * (g.t1 - g.t0);
          geometrias.forEach((gg, j) => {
            const cruz = $(`#hist-cruz-${j}`, raiz);
            if (!cruz || !gg) return;
            cruz.hidden = false;
            cruz.style.left = `${gg.esquerda + ((t - gg.t0) / (gg.t1 - gg.t0)) * gg.largura}px`;
          });
          const linhas = this._series.map((s) => {
            const p = dados.get(s.tag) || [];
            if (!p.length) return null;
            let maisPerto = p[0];
            for (const q of p) if (Math.abs(q.t - t) < Math.abs(maisPerto.t - t)) maisPerto = q;
            const d = defDe(s.tag);
            return `<div><i style="background:${s.cor}"></i>${esc(d ? `${d.eq.nome} · ${d.t.rotulo}` : s.tag)}
              <b>${num(maisPerto.med, d?.t.decimais ?? 1)} ${esc(d?.t.unidade || '')}</b></div>`;
          }).filter(Boolean);
          const quando = new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          dica.innerHTML = `<div class="hist-dica-hora">${quando}</div>${linhas.join('')}`;
          dica.hidden = false;
          const areaTotal = $('#hist-paineis', raiz).getBoundingClientRect();
          const largDica = dica.offsetWidth || 220;
          const xPag = ev.clientX - areaTotal.left;
          const esq = xPag + 16 + largDica > areaTotal.width ? xPag - largDica - 16 : xPag + 16;
          // tela estreita: nem à direita nem à esquerda cabe inteira — encosta na borda
          dica.style.left = `${Math.max(0, Math.min(esq, areaTotal.width - largDica))}px`;
          dica.style.top = `${ev.clientY - areaTotal.top + 12}px`;
        });
        areaP.addEventListener('mouseleave', () => esconder());
      });
      function esconder() {
        raiz.querySelectorAll('.hist-cruz').forEach((c) => { c.hidden = true; });
        if (dica) dica.hidden = true;
      }
    };

    const adicionar = (tag) => {
      if (!tag || this._series.some((s) => s.tag === tag) || this._series.length >= HIST_MAX_SERIES) return;
      // primeira cor livre: tirar uma grandeza não pinta as outras de novo
      const usadas = new Set(this._series.map((s) => s.cor));
      this._series.push({ tag, cor: PALETA_SERIES.find((c) => !usadas.has(c)) });
    };

    sel.addEventListener('change', () => {
      adicionar(sel.value);
      sel.value = '';
      desenhar();
    });
    if (atalho) {
      atalho.addEventListener('change', () => {
        const a = histAtalhos().find((x) => x.id === atalho.value);
        atalho.value = '';
        if (!a) return;
        this._series = [];
        for (const tag of a.tags) adicionar(tag);
        desenhar();
      });
    }
    raiz.querySelectorAll('[data-horas]').forEach((b) => b.addEventListener('click', () => {
      this._horas = Number(b.dataset.horas);
      raiz.querySelectorAll('[data-horas]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      desenhar();
    }));

    let temporizador = null;
    const aoRedimensionar = () => { clearTimeout(temporizador); temporizador = setTimeout(desenhar, 180); };
    window.addEventListener('resize', aoRedimensionar, { passive: true });
    this._limpar = () => {
      window.removeEventListener('resize', aoRedimensionar);
      clearTimeout(temporizador);
      pedido += 1;
    };
    // grandeza que sumiu da configuração (equipamento removido) sai da comparação
    this._series = this._series.filter((s) => defDe(s.tag));
    desenhar();
  },

  destruir() {
    if (this._limpar) this._limpar();
    this._limpar = null;
  },
};
