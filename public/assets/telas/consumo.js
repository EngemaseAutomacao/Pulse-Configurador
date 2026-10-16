import { estado, esc, num, api, MODO_DEMO, $ } from '../nucleo.js';
import { placa } from './energia.js';

/**
 * Consumo de energia por setor, hora a hora.
 *
 * Forma: um gráfico de colunas por setor (pequenos múltiplos), todos na mesma
 * escala para comparar setores entre si — oito setores numa pilha só seriam
 * oito cores e nenhum setor legível. A entrada geral vem em destaque no alto,
 * com escala própria, e a tela fecha com o ranking do dia e a tabela.
 *
 * Uma cor só (o azul de informação do sistema): cada gráfico é um setor, a
 * identidade vem do título. Hora estimada pela potência e hora em andamento
 * levam hachura na mesma cor — nunca um tom mais claro, que se confunde com a
 * superfície. Cada coluna tem dica ao passar o mouse; a tabela tem tudo.
 */

// medidas em pixels reais: cada gráfico é desenhado na largura do seu painel,
// para o texto do eixo ter sempre o mesmo tamanho, no painel largo e no estreito
const CONS_H = 140;
const CONS_M = { e: 34, d: 6, c: 8, b: 18 };
const CONS_GERAL_H = 190;

/** Fim de escala "redondo": 1, 2, 2,5, 5 × 10ⁿ. */
function consEscalaRedonda(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v);
}

const consKwh = (v) => (v === null || v === undefined ? '––' : num(v, v < 10 ? 1 : 0));
// unidade da grandeza em tela: kWh (energia ativa) ou kVAh (aparente)
let consUn = 'kWh';
const consHora = (h) => `${String(h).padStart(2, '0')}h`;
const consFaixa = (h) => `${consHora(h)}–${consHora((h + 1) % 24)}`;

function consHoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function consSomarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  const x = new Date(a, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function consDiaPorExtenso(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}

/** Coluna com o topo arredondado e a base reta, crescendo da linha de base. */
function consColuna(x, y, w, base) {
  const h = base - y;
  if (h <= 0.5) return '';
  const r = Math.min(3, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** Texto da dica de uma hora. */
function consDica(s, h, extra = '') {
  const v = s.kwh[h];
  if (s.futura[h]) return '';
  if (v === null) return `${s.nome}\n${consFaixa(h)} · sem registro`;
  const obs = s.parcial[h] ? '\nhora em andamento' : s.fonte[h] === 'potencia' ? '\nestimado pela potência média' : '';
  return `${s.nome}\n${consFaixa(h)} · ${consKwh(v)} ${consUn}${obs}${extra}`;
}

/**
 * Um gráfico de 24 colunas. `topo` é o fim de escala (comum aos setores, ou
 * do próprio setor). Hit-area da coluna inteira, maior que a marca.
 */
function consGrafico(s, topo, { largura = 360, altura = CONS_H, extras = [] } = {}) {
  const CONS_W = Math.max(240, Math.round(largura));
  const pw = CONS_W - CONS_M.e - CONS_M.d;
  const ph = altura - CONS_M.c - CONS_M.b;
  const base = CONS_M.c + ph;
  const banda = pw / 24;
  const larg = Math.min(24, banda - 2);
  const y = (v) => base - (Math.max(0, v) / topo) * ph;

  const grade = [0, topo / 2, topo].map((v) => `
    <line class="cons-grade" x1="${CONS_M.e}" x2="${CONS_W - CONS_M.d}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
    <text class="cons-eixo" x="${CONS_M.e - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${num(v, topo < 10 ? 1 : 0)}</text>`).join('');
  const marcasX = [0, 6, 12, 18].map((h) => `
    <text class="cons-eixo" x="${(CONS_M.e + banda * h + banda / 2).toFixed(1)}" y="${altura - 4}" text-anchor="middle">${consHora(h)}</text>`).join('');

  let colunas = '';
  let alvos = '';
  for (let h = 0; h < 24; h++) {
    const x = CONS_M.e + banda * h + (banda - larg) / 2;
    const v = s.kwh[h];
    if (v !== null && !s.futura[h]) {
      const classe = s.parcial[h] ? 'cons-coluna parcial' : s.fonte[h] === 'potencia' ? 'cons-coluna estimada' : 'cons-coluna';
      colunas += `<path class="${classe}" d="${consColuna(x, y(Math.min(v, topo)), larg, base)}"/>`;
    } else if (!s.futura[h]) {
      // hora sem registro: um traço na base, para não confundir com "zero"
      colunas += `<line class="cons-sem-dado" x1="${x.toFixed(1)}" x2="${(x + larg).toFixed(1)}" y1="${base - 1}" y2="${base - 1}"/>`;
    }
    const dica = consDica(s, h, extras[h] || '');
    if (dica) {
      alvos += `<rect class="cons-alvo" x="${(CONS_M.e + banda * h).toFixed(1)}" y="${CONS_M.c}" width="${banda.toFixed(2)}"
                 height="${ph}" data-dica="${esc(dica)}"/>`;
    }
  }
  return `<svg class="cons-svg" width="${CONS_W}" height="${altura}" viewBox="0 0 ${CONS_W} ${altura}" role="img"
              aria-label="${esc(s.nome)}: consumo por hora, ${consKwh(s.total)} ${consUn} no dia">
    ${grade}
    <line class="cons-base" x1="${CONS_M.e}" x2="${CONS_W - CONS_M.d}" y1="${base}" y2="${base}"/>
    ${colunas}${marcasX}${alvos}
  </svg>`;
}

function consPico(s) {
  let melhor = -1;
  s.kwh.forEach((v, h) => { if (v !== null && (melhor < 0 || v > s.kwh[melhor])) melhor = h; });
  return melhor;
}

/* --------------------------------------------- demonstração (sem servidor) */

/** Dia sintético, determinístico por dia e setor: perfil de loja aberta 7h–22h. */
function consDemo(dia, grandeza = 'ativa') {
  const fatorFp = grandeza === 'aparente' ? 1.06 : 1;   // aparente ≈ ativa / FP 0,94
  const eqs = (estado.config.equipamentos || []).filter((e) => (e.grupo || 'energia') === 'energia');
  const hoje = dia === consHoje();
  const horaAgora = new Date().getHours();
  let semente = [...dia].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const acaso = () => { semente = (semente * 1103515245 + 12345) >>> 0; return (semente % 1000) / 1000; };
  const frio = /fri|refrig|congel|climat/;
  const setor = (e, i) => {
    const potencia = 6 + ((i * 37) % 23) + acaso() * 4;     // kW médio em loja aberta
    const kwh = Array.from({ length: 24 }, (_, h) => {
      const aberta = h >= 7 && h < 22 ? 1 : 0;
      const forma = frio.test(e.id) ? 0.72 + 0.28 * aberta : 0.25 + 0.75 * aberta;
      return +(potencia * fatorFp * forma * (0.92 + acaso() * 0.16)).toFixed(2);
    });
    return kwh;
  };
  const ramais = eqs.filter((e) => !e.principal).map((e, i) => ({ e, kwh: setor(e, i) }));
  const geral = eqs.find((e) => e.principal);
  const montar = (e, kwh) => {
    const futura = kwh.map((_, h) => hoje && h > horaAgora);
    const parcial = kwh.map((_, h) => hoje && h === horaAgora);
    const valores = kwh.map((v, h) => (futura[h] ? null : parcial[h] ? +(v * 0.6).toFixed(2) : v));
    const fonte = valores.map((v, h) => (v === null ? null : h === 3 ? 'potencia' : 'contador'));
    return {
      id: e.id, nome: e.nome, tag_isa: e.tag_isa, principal: !!e.principal,
      kwh: valores, fonte, parcial, futura,
      total: +valores.filter((v) => v !== null).reduce((s, v) => s + v, 0).toFixed(2),
      horas_sem_dado: 0,
    };
  };
  const setores = ramais.map((r) => montar(r.e, r.kwh));
  if (geral) {
    const soma = Array.from({ length: 24 }, (_, h) => ramais.reduce((t, r) => t + r.kwh[h], 0) * 1.06);
    setores.unshift(montar(geral, soma));
  }
  const g = setores.find((s) => s.principal);
  const naoMedido = g && grandeza === 'ativa' ? g.kwh.map((v, h) => (v === null ? null
    : +Math.max(0, v - setores.filter((s) => !s.principal).reduce((t, s) => t + (s.kwh[h] || 0), 0)).toFixed(2))) : null;
  return { dia, grandeza, unidade: grandeza === 'aparente' ? 'kVAh' : 'kWh', geral: g?.id || null, setores, nao_medido: naoMedido };
}

/* ------------------------------------------------------------------- tela */

export const telaConsumo = {
  id: 'consumo',
  isa: '',
  nome: 'Consumo',
  titulo: 'Consumo de energia',
  _dia: null,
  _grandeza: 'ativa',
  _escala: 'comum',
  _tabela: false,
  _dados: null,
  _raiz: null,
  _ouvintes: null,
  _relogio: null,
  _pedido: 0,

  montar() {
    if (!this._dia) this._dia = consHoje();
    return `
      <svg class="cons-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="cons-hachura" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" class="cons-hachura-fundo"/><line x1="0" y1="0" x2="0" y2="5" class="cons-hachura-traco"/>
          </pattern>
          <pattern id="cons-hachura-parcial" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <rect width="5" height="5" class="cons-hachura-fundo"/><line x1="0" y1="0" x2="0" y2="5" class="cons-hachura-traco"/>
          </pattern>
        </defs>
      </svg>

      <section class="bloco">
        ${placa('', 'Consumo de energia por setor')}
        <div class="corpo">
          <div class="controles">
            <div class="grupo-botoes" role="group" aria-label="Dia">
              <button class="botao" data-cons="anterior" title="Dia anterior">◀</button>
              <button class="botao" data-cons="hoje">Hoje</button>
              <button class="botao" data-cons="seguinte" title="Dia seguinte">▶</button>
            </div>
            <input class="entrada" type="date" id="cons-dia" aria-label="Dia" value="${this._dia}" max="${consHoje()}">
            <span class="rotulo" id="cons-dia-extenso" style="margin:0"></span>
            <div class="grupo-botoes" role="group" aria-label="Energia" style="margin-left:auto">
              <button class="botao" data-cons-grandeza="ativa" aria-pressed="${this._grandeza === 'ativa'}"
                      title="Energia ativa — a que gira o motor, aquece, ilumina">Ativa · kWh</button>
              <button class="botao" data-cons-grandeza="aparente" aria-pressed="${this._grandeza === 'aparente'}"
                      title="Energia aparente — ativa somada à reativa; a diferença é o efeito do fator de potência">Aparente · kVAh</button>
            </div>
          </div>
          <div id="cons-resumo"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Hora a hora')}
        <div class="corpo">
          <div class="controles">
            <div class="grupo-botoes" role="group" aria-label="Escala dos setores">
              <button class="botao" data-cons-escala="comum" aria-pressed="${this._escala === 'comum'}">Mesma escala</button>
              <button class="botao" data-cons-escala="propria" aria-pressed="${this._escala === 'propria'}">Escala de cada setor</button>
            </div>
            <button class="botao" data-cons="tabela" aria-pressed="${this._tabela}">Ver tabela</button>
            <button class="botao" data-cons="csv">Baixar CSV</button>
            <span class="cons-legenda">
              <span><i class="cons-chave"></i>medido pelo contador</span>
              <span><i class="cons-chave estimada"></i>estimado pela potência</span>
              <span><i class="cons-chave parcial"></i>hora em andamento</span>
              <span><i class="cons-chave sem-dado"></i>sem registro</span>
            </span>
          </div>
          <div id="cons-geral"></div>
          <div id="cons-paineis" class="cons-paineis"><p class="vazio">carregando…</p></div>
          <div id="cons-tabela" hidden></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Participação no dia')}
        <div class="corpo"><div id="cons-ranking"></div></div>
      </section>
      <div class="cons-dica" id="cons-dica" hidden></div>`;
  },

  aoMontar(raiz) {
    this._raiz = raiz;
    const aoClicar = (ev) => {
      const b = ev.target.closest('[data-cons], [data-cons-escala], [data-cons-grandeza]');
      if (!b) return;
      const acao = b.dataset.cons;
      if (b.dataset.consGrandeza) {
        this._grandeza = b.dataset.consGrandeza;
        raiz.querySelectorAll('[data-cons-grandeza]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.carregar(raiz);
      } else if (b.dataset.consEscala) {
        this._escala = b.dataset.consEscala;
        raiz.querySelectorAll('[data-cons-escala]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.desenhar(raiz);
      } else if (acao === 'anterior') this.irPara(raiz, consSomarDias(this._dia, -1));
      else if (acao === 'seguinte') this.irPara(raiz, consSomarDias(this._dia, 1));
      else if (acao === 'hoje') this.irPara(raiz, consHoje());
      else if (acao === 'tabela') {
        this._tabela = !this._tabela;
        b.setAttribute('aria-pressed', String(this._tabela));
        this.desenhar(raiz);
      } else if (acao === 'csv') this.baixarCsv();
    };
    const aoMudar = (ev) => {
      if (ev.target.id === 'cons-dia' && ev.target.value) this.irPara(raiz, ev.target.value);
    };
    // dica: segue o mouse sobre qualquer coluna
    const aoMover = (ev) => {
      const alvo = ev.target.closest?.('[data-dica]');
      const dica = $('#cons-dica', raiz);
      if (!dica) return;
      if (!alvo) { dica.hidden = true; return; }
      dica.textContent = alvo.dataset.dica;
      dica.hidden = false;
      const x = Math.min(ev.clientX + 14, window.innerWidth - 230);
      dica.style.left = `${x}px`;
      dica.style.top = `${ev.clientY + 14}px`;
    };
    const aoSair = () => { const d = $('#cons-dica', raiz); if (d) d.hidden = true; };
    let espera = null;
    const aoRedimensionar = () => { clearTimeout(espera); espera = setTimeout(() => this.renderizarGraficos(raiz), 150); };
    raiz.addEventListener('click', aoClicar);
    raiz.addEventListener('change', aoMudar);
    raiz.addEventListener('mousemove', aoMover);
    raiz.addEventListener('mouseleave', aoSair);
    window.addEventListener('resize', aoRedimensionar, { passive: true });
    this._ouvintes = { aoClicar, aoMudar, aoMover, aoSair, aoRedimensionar };

    // o dia de hoje se atualiza sozinho a cada minuto
    this._relogio = setInterval(() => { if (this._dia === consHoje()) this.carregar(raiz); }, 60000);
    this.carregar(raiz);
  },

  destruir() {
    clearInterval(this._relogio);
    this._relogio = null;
    if (this._raiz && this._ouvintes) {
      this._raiz.removeEventListener('click', this._ouvintes.aoClicar);
      this._raiz.removeEventListener('change', this._ouvintes.aoMudar);
      this._raiz.removeEventListener('mousemove', this._ouvintes.aoMover);
      this._raiz.removeEventListener('mouseleave', this._ouvintes.aoSair);
    }
    if (this._ouvintes) window.removeEventListener('resize', this._ouvintes.aoRedimensionar);
    this._ouvintes = null;
    this._raiz = null;
    this._pedido += 1;   // descarta resposta que chegar depois de sair da tela
  },

  irPara(raiz, dia) {
    if (dia > consHoje()) return;
    this._dia = dia;
    const campo = $('#cons-dia', raiz);
    if (campo) campo.value = dia;
    this.carregar(raiz);
  },

  async carregar(raiz) {
    const meu = ++this._pedido;
    try {
      const dados = MODO_DEMO ? consDemo(this._dia, this._grandeza)
        : await api(`/api/consumo?dia=${encodeURIComponent(this._dia)}&grandeza=${this._grandeza}`);
      if (meu !== this._pedido) return;
      this._dados = dados;
      this.desenhar(raiz);
    } catch (e) {
      const alvo = $('#cons-paineis', raiz);
      if (alvo) alvo.innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  },

  desenhar(raiz) {
    const d = this._dados;
    if (!d) return;
    consUn = d.unidade || 'kWh';
    const extenso = $('#cons-dia-extenso', raiz);
    if (extenso) extenso.textContent = consDiaPorExtenso(d.dia);
    const geral = d.setores.find((s) => s.principal) || null;
    const ramais = d.setores.filter((s) => !s.principal);
    this._graficos = new Map();

    this.desenharResumo(raiz, d, geral, ramais);

    // entrada geral, em destaque: a dica mostra a divisão da hora por setor
    const alvoGeral = $('#cons-geral', raiz);
    if (alvoGeral) {
      if (!geral) alvoGeral.innerHTML = '';
      else {
        const extras = geral.kwh.map((_, h) => {
          const partes = ramais.filter((s) => s.kwh[h] !== null).sort((a, b) => b.kwh[h] - a.kwh[h])
            .map((s) => `${s.nome}: ${consKwh(s.kwh[h])}`);
          const nm = d.nao_medido?.[h];
          return partes.length ? `\n— ${partes.join('\n— ')}${nm !== null && nm !== undefined ? `\n— não medido: ${consKwh(nm)}` : ''}` : '';
        });
        const topoG = consEscalaRedonda(Math.max(0, ...geral.kwh.filter((v) => v !== null)));
        this._graficos.set(geral.id, { s: geral, topo: topoG, altura: CONS_GERAL_H, extras });
        alvoGeral.innerHTML = `<div class="cons-painel destaque">
          ${this.cabecalho(geral, 'Entrada geral — total da instalação')}
          <div class="cons-area" data-cons-grafico="${esc(geral.id)}"></div>
        </div>`;
      }
    }

    // setores: mesma escala (compara setores) ou a de cada um (mostra o perfil)
    const paineis = $('#cons-paineis', raiz);
    if (paineis) {
      const maxComum = Math.max(0, ...ramais.flatMap((s) => s.kwh.filter((v) => v !== null)));
      paineis.innerHTML = ramais.length ? ramais.map((s) => {
        const topo = consEscalaRedonda(this._escala === 'comum' ? maxComum
          : Math.max(0, ...s.kwh.filter((v) => v !== null)));
        this._graficos.set(s.id, { s, topo, altura: CONS_H, extras: [] });
        return `<div class="cons-painel">${this.cabecalho(s)}
          <div class="cons-area" data-cons-grafico="${esc(s.id)}"></div></div>`;
      }).join('') : '<p class="vazio">Nenhum medidor de setor cadastrado.</p>';
    }
    this.renderizarGraficos(raiz);

    const tabela = $('#cons-tabela', raiz);
    if (tabela) {
      tabela.hidden = !this._tabela;
      if (this._tabela) tabela.innerHTML = this.tabelaHtml(d);
    }

    this.desenharRanking(raiz, d, geral, ramais);
  },

  /** Desenha cada gráfico na largura real do seu painel (e de novo ao redimensionar). */
  renderizarGraficos(raiz) {
    for (const area of raiz.querySelectorAll('[data-cons-grafico]')) {
      const g = this._graficos?.get(area.dataset.consGrafico);
      if (!g) continue;
      area.innerHTML = consGrafico(g.s, g.topo, { largura: area.clientWidth || 360, altura: g.altura, extras: g.extras });
    }
  },

  cabecalho(s, subtitulo = '') {
    const pico = consPico(s);
    return `<div class="cons-cabecalho">
      <div><span class="cons-nome">${esc(s.nome)}</span>${s.tag_isa ? `<span class="isa">${esc(s.tag_isa)}</span>` : ''}
        ${subtitulo ? `<div class="rotulo" style="margin:2px 0 0">${esc(subtitulo)}</div>` : ''}</div>
      <div class="cons-total"><b>${consKwh(s.total)}</b> ${consUn}
        <div class="rotulo" style="margin:0">${pico >= 0 ? `pico ${consFaixa(pico)} · ${consKwh(s.kwh[pico])} ${consUn}` : 'sem registro'}${s.horas_sem_dado ? ` · ${s.horas_sem_dado} h sem registro` : ''}</div>
      </div>
    </div>`;
  },

  desenharResumo(raiz, d, geral, ramais) {
    const alvo = $('#cons-resumo', raiz);
    if (!alvo) return;
    const somaRamais = ramais.reduce((t, s) => t + (s.total || 0), 0);
    const total = geral?.total ?? (ramais.length ? somaRamais : null);
    const ref = geral || null;
    const pico = ref ? consPico(ref) : -1;
    const maior = [...ramais].filter((s) => s.total !== null).sort((a, b) => b.total - a.total)[0];
    const nm = d.nao_medido ? d.nao_medido.filter((v) => v !== null).reduce((t, v) => t + v, 0) : null;
    const pct = (v) => (total ? `${num((v / total) * 100, 0)} % do total` : '');
    const ficha = (rotulo, valor, un, apoio) => `<div class="indicador">
      <div class="rotulo" style="margin:0 0 4px">${rotulo}</div>
      <div class="n">${valor}<span class="un">${un}</span></div>
      <div class="apoio">${apoio}</div></div>`;
    alvo.innerHTML = `<div class="indicadores">
      ${ficha(d.grandeza === 'aparente' ? 'Energia aparente do dia' : 'Consumo do dia', consKwh(total), consUn,
    geral ? 'medidor da entrada geral' : 'soma dos setores')}
      ${ficha('Hora de pico', pico >= 0 ? consFaixa(pico) : '––', '', pico >= 0 ? `${consKwh(ref.kwh[pico])} ${consUn} na entrada geral` : '')}
      ${ficha('Maior setor', maior ? esc(maior.nome) : '––', '', maior ? `${consKwh(maior.total)} ${consUn} · ${pct(maior.total)}` : '')}
      ${ficha('Não medido', nm === null ? '––' : consKwh(nm), nm === null ? '' : consUn,
    d.grandeza === 'aparente' ? 'só na energia ativa: a aparente não se soma entre setores'
      : nm === null ? 'precisa da entrada geral e de todos os setores' : `${pct(nm)} — entrada geral menos a soma dos setores`)}
    </div>`;
  },

  desenharRanking(raiz, d, geral, ramais) {
    const alvo = $('#cons-ranking', raiz);
    if (!alvo) return;
    const nm = d.nao_medido ? d.nao_medido.filter((v) => v !== null).reduce((t, v) => t + v, 0) : null;
    const linhas = ramais.filter((s) => s.total !== null).map((s) => ({ nome: s.nome, kwh: s.total, cinza: false }))
      .sort((a, b) => b.kwh - a.kwh);
    if (nm !== null) linhas.push({ nome: 'Não medido', kwh: nm, cinza: true });
    const total = geral?.total ?? linhas.reduce((t, l) => t + l.kwh, 0);
    const maximo = Math.max(...linhas.map((l) => l.kwh), 0) || 1;
    alvo.innerHTML = linhas.length ? `<div class="cons-ranking">${linhas.map((l) => `
      <div class="cons-linha">
        <span class="cons-rotulo">${esc(l.nome)}</span>
        <span class="cons-trilho"><span class="cons-barra${l.cinza ? ' cinza' : ''}" style="width:${((l.kwh / maximo) * 100).toFixed(1)}%"></span></span>
        <span class="cons-valor"><b>${consKwh(l.kwh)}</b> ${consUn}${total ? ` · ${num((l.kwh / total) * 100, 1)} %` : ''}</span>
      </div>`).join('')}</div>` : '<p class="vazio">Sem registro neste dia.</p>';
  },

  /** Linhas da tabela e do CSV: uma por hora, uma coluna por medidor. */
  linhasTabela(d) {
    const cols = [...d.setores.filter((s) => !s.principal), ...d.setores.filter((s) => s.principal)];
    const cab = ['Hora', ...cols.map((s) => s.nome), ...(d.nao_medido ? ['Não medido'] : [])];
    const horas = Array.from({ length: 24 }, (_, h) => [consFaixa(h),
      ...cols.map((s) => s.kwh[h]), ...(d.nao_medido ? [d.nao_medido[h]] : [])]);
    const totais = ['Total', ...cols.map((s) => s.total),
      ...(d.nao_medido ? [d.nao_medido.filter((v) => v !== null).reduce((t, v) => t + v, 0)] : [])];
    return { cab, horas, totais, cols };
  },

  tabelaHtml(d) {
    const { cab, horas, totais } = this.linhasTabela(d);
    return `<div class="cons-tabela"><table>
      <thead><tr>${cab.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${horas.map((l) => `<tr>${l.map((v, i) => (i ? `<td class="n">${consKwh(v)}</td>` : `<td>${v}</td>`)).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr>${totais.map((v, i) => (i ? `<td class="n"><b>${consKwh(v)}</b></td>` : '<td><b>Total</b></td>')).join('')}</tr></tfoot>
    </table><p class="nota" style="margin:8px 0 0">Valores em ${consUn}. "––" = sem registro naquela hora.</p></div>`;
  },

  /** CSV no formato do Excel brasileiro: ponto e vírgula, vírgula decimal. */
  baixarCsv() {
    const d = this._dados;
    if (!d) return;
    const { cab, horas, totais } = this.linhasTabela(d);
    const cel = (v) => (typeof v === 'number' ? v.toFixed(3).replace('.', ',') : v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const csv = [cab, ...horas, totais].map((l) => l.map(cel).join(';')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `consumo-${d.dia}-${(d.unidade || 'kWh').toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },

  aoReceberDados() {},
};

export const _consumoInterno = { consEscalaRedonda, consDemo, consColuna };
