import {
  estado, esc, num, valor, equipamento, serie, $, SEM_DADO,
} from '../nucleo.js';
import { placa, leitura, estadoVazio } from './energia.js';
import { desenharTendencia } from '../grafico.js';
import {
  blocoIndicadores, blocoBateria, blocoCorridas, indicadores,
} from './indicadores.js';

// tanque de diesel desenhado em corte
const TQD = { x: 34, larg: 96, topo: 34, base: 214 };
const yDoNivelDiesel = (pct) => TQD.base - (Math.min(100, Math.max(0, pct)) / 100) * (TQD.base - TQD.topo);

// a bateria saiu daqui: virou bloco próprio, com a queda no arranque
// só aparecem as que o perfil do controlador tem: as do fim da lista vêm de
// controladores mais completos (Deep Sea) e não existem no mapa genérico
const PARAMETROS = ['rotacao', 'frequencia', 'tensao_ab', 'potencia',
  'pressao_oleo', 'temperatura', 'horimetro',
  'carga_pct', 'fator_potencia', 'temperatura_oleo', 'energia_kwh', 'partidas', 'potencia_rede'];

const SEM_GERADOR = {
  mensagem: 'Nenhum grupo gerador está cadastrado nesta instalação.',
  passos: [
    'Ligue a USCA do gerador na RS-485 e, em <b>Engenharia → Varredura</b>, '
      + 'descubra em que endereço ela responde.',
    'Em <b>Engenharia → Equipamentos</b>, acrescente o gerador escolhendo o perfil da marca '
      + '(<b>gerador-generico</b> serve de ponto de partida) e informe o endereço.',
    'Na configuração da unidade, preencha a seção <b>gerador</b> com a capacidade do tanque, '
      + 'o consumo e as marcas de nível — é dela que saem autonomia e indicadores.',
  ],
};

export const telaGerador = {
  id: 'gerador',
  isa: 'GMG-01',
  nome: 'Gerador',
  titulo: 'Grupo gerador diesel',
  _limpar: null,
  _primeira: null,

  montar() {
    const cfg = estado.config.gerador;
    const id = cfg?.medidor;
    const eq = id ? (estado.config.equipamentos || []).find((e) => e.id === id) : null;
    // a tela pode estar no menu antes do grupo existir (telas.gerador = true):
    // em vez de sumir ou quebrar, ela explica o que falta para instalá-lo
    if (!cfg || !eq) return estadoVazio({ isa: 'GMG-01', titulo: 'Grupo gerador', ...SEM_GERADOR });
    const tag = (n) => eq?.tags.find((t) => t.nome === n);
    const marcas = cfg.marcas || [];

    const riscos = marcas.map((m) => {
      const y = yDoNivelDiesel(m.valor);
      const cor = m.prioridade === 'alta' ? 'var(--critico)' : 'var(--atencao)';
      return `<line x1="${TQD.x - 6}" y1="${y}" x2="${TQD.x + TQD.larg + 8}" y2="${y}"
                    stroke="${cor}" stroke-width="1" stroke-dasharray="5 4"/>
              <text class="rot" x="${TQD.x + TQD.larg + 12}" y="${y + 3}" style="fill:${cor}">${esc(m.rotulo)}</text>`;
    }).join('');

    const falhas = (cfg.falhas || []).filter((n) => tag(n));

    return `
      <div class="grade dupla">
        <section class="bloco">
          ${placa(eq?.tag_isa || 'GMG-01', 'Grupo gerador', id)}
          <div class="corpo">
            <div class="dados-linha" style="margin-bottom:14px">
              <div class="dado">
                <span class="rotulo">Estado</span>
                <span class="n" id="gmg-estado">––</span>
              </div>
              <div class="dado">
                <span class="rotulo">Modo</span>
                <span class="n" id="gmg-modo">––</span>
              </div>
              <div class="dado">
                <span class="rotulo">Rede da concessionária</span>
                <span class="n" id="gmg-rede">––</span>
              </div>
              <div class="dado">
                <span class="rotulo">Autonomia estimada</span>
                <span class="n" id="gmg-autonomia">––</span>
              </div>
              ${tag('disjuntor_fechado') ? `<div class="dado">
                <span class="rotulo">Disjuntores</span>
                <span class="n" id="gmg-disjuntores">––</span>
              </div>` : ''}
            </div>
            <div class="leituras">
              ${PARAMETROS.filter((n) => tag(n)).map((n) => leitura(`${id}.${n}`, tag(n))).join('')}
            </div>
          </div>
        </section>

        <section class="bloco">
          ${placa('TQ-02', 'Tanque de diesel')}
          <div class="corpo" style="display:flex;gap:18px;align-items:flex-start">
            <svg class="desenho" viewBox="0 0 250 250" style="width:250px;flex:0 0 auto"
                 role="img" aria-label="Tanque de diesel e nível medido">
              <rect id="gmg-diesel" class="diesel" x="${TQD.x + 2}" y="${TQD.base}" width="${TQD.larg - 4}" height="0" opacity=".6"/>
              <rect class="parede" x="${TQD.x}" y="${TQD.topo}" width="${TQD.larg}" height="${TQD.base - TQD.topo}"/>
              <rect class="parede-interna" x="${TQD.x + 4}" y="${TQD.topo + 4}"
                    width="${TQD.larg - 8}" height="${TQD.base - TQD.topo - 8}"/>
              ${riscos}
              <text class="rot" x="${TQD.x + TQD.larg / 2}" y="${TQD.base + 18}" text-anchor="middle">
                ${num(cfg.capacidade_tanque_litros, 0)} L · ${num(cfg.consumo_litros_hora, 0)} L/h</text>
              <text id="gmg-pct" class="valor-desenho" x="${TQD.x + TQD.larg / 2}" y="${TQD.topo - 12}"
                    text-anchor="middle">––</text>
            </svg>
            <div style="flex:1;min-width:0">
              <div class="leituras">
                ${leitura(`${id}.nivel_diesel`, tag('nivel_diesel'), { grande: true })}
                <div class="leitura">
                  <span class="rotulo">Diesel no tanque</span>
                  <span class="valor sem-dado"><span id="gmg-litros">––</span><span class="un">L</span></span>
                </div>
              </div>
              <div class="escala" style="margin-top:12px">
                <div class="trilho">
                  <span class="barra" data-escala-tag="${id}.nivel_diesel" data-min="0" data-max="100"></span>
                  ${marcas.map((m) => `<span class="limite ${m.prioridade === 'alta' ? 'critico' : 'atencao'}"
                        style="left:${m.valor}%"></span>`).join('')}
                </div>
                <div class="extremos"><span>0 %</span><span>100 %</span></div>
              </div>
            </div>
          </div>
        </section>
      </div>

      ${blocoIndicadores()}

      <div class="grade dupla">
        ${blocoBateria()}
        ${blocoCorridas()}
      </div>

      <section class="bloco">
        ${placa('GMG-01', 'Anunciador de falhas')}
        <div class="corpo">
          <div class="anunciador">
            ${falhas.map((n) => {
    const t = tag(n);
    const prio = ['falha_bateria', 'falha_carregador'].includes(n) ? 'media' : 'alta';
    return `<div class="janela" data-prioridade="${prio}" data-digital="${id}.${n}" data-falha="${n}">
                        ${esc(t.rotulo)}</div>`;
  }).join('')}
          </div>
        </div>
      </section>

      <section class="bloco">
        ${placa('TQ-02', 'Tendência do nível de diesel')}
        <div class="corpo">
          <div class="controles">
            <div class="grupo-botoes" role="group" aria-label="Período">
              ${[[24, '24 h'], [168, '7 dias'], [720, '30 dias']].map(([h, r], i) => `
                <button class="botao" data-horas="${h}" aria-pressed="${i === 1}">${r}</button>`).join('')}
            </div>
            <span class="rotulo" id="gmg-resumo" style="margin:0"></span>
          </div>
          <canvas id="gmg-grafico"></canvas>
        </div>
      </section>`;
  },

  aoMontar(raiz) {
    const cfg = estado.config.gerador;
    if (!cfg?.medidor || !$('#gmg-grafico', raiz)) return;   // tela em estado vazio
    const tag = `${cfg.medidor}.${cfg.tag_nivel}`;
    let horas = 168;
    let pedido = 0;

    const desenhar = async () => {
      const meu = ++pedido;
      const pontos = await serie(tag, horas);
      if (meu !== pedido) return;
      const canvas = $('#gmg-grafico', raiz);
      if (!canvas || !canvas.isConnected) return;
      desenharTendencia(canvas, pontos, { unidade: '%', marcas: cfg.marcas || [] });
      const resumo = $('#gmg-resumo', raiz);
      if (resumo && pontos.length) {
        const consumido = pontos[0].med - pontos[pontos.length - 1].med;
        resumo.textContent = consumido > 0.5
          ? `consumo no período: ${num((consumido / 100) * cfg.capacidade_tanque_litros, 0)} L`
          : 'sem consumo relevante no período';
      }
    };

    raiz.querySelectorAll('[data-horas]').forEach((b) => b.addEventListener('click', () => {
      horas = Number(b.dataset.horas);
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
    this._primeira = null;
    desenhar();
    indicadores.aoMontar(raiz);
  },

  atualizar(raiz) {
    const cfg = estado.config.gerador;
    if (!cfg?.medidor) return;
    const id = cfg.medidor;
    const eq = equipamento(id);
    const nivel = valor(`${id}.nivel_diesel`);

    // tanque
    const tanque = $('#gmg-diesel', raiz);
    const pct = $('#gmg-pct', raiz);
    const litros = $('#gmg-litros', raiz);
    if (tanque) {
      if (nivel === null) {
        tanque.setAttribute('height', '0');
        if (pct) { pct.textContent = SEM_DADO; pct.setAttribute('class', 'valor-desenho'); }
        if (litros) litros.textContent = SEM_DADO;
      } else {
        const y = yDoNivelDiesel(nivel);
        tanque.setAttribute('y', y.toFixed(1));
        tanque.setAttribute('height', (TQD.base - y).toFixed(1));
        const critico = (cfg.marcas || []).some((m) => m.prioridade === 'alta' && nivel < m.valor);
        if (pct) {
          pct.textContent = `${num(nivel, 1)} %`;
          pct.setAttribute('class', critico ? 'valor-desenho alerta' : 'valor-desenho');
        }
        if (litros) {
          litros.textContent = num((nivel / 100) * cfg.capacidade_tanque_litros, 0);
          litros.closest('.valor')?.classList.remove('sem-dado');
        }
      }
    }

    // estado, modo, rede e autonomia
    const estadoTxt = $('#gmg-estado', raiz);
    const modoTxt = $('#gmg-modo', raiz);
    const redeTxt = $('#gmg-rede', raiz);
    const autonomia = $('#gmg-autonomia', raiz);
    const iEstado = valor(`${id}.estado`);
    const iModo = valor(`${id}.modo`);
    const rede = valor(`${id}.rede_presente`);

    if (estadoTxt) {
      const lista = cfg.estados || [];
      estadoTxt.textContent = iEstado === null ? SEM_DADO : (lista[iEstado] ?? `código ${iEstado}`);
      estadoTxt.style.color = iEstado === 5 ? 'var(--critico)'
        : iEstado === 3 ? 'var(--ok)' : 'var(--tinta)';
    }
    if (modoTxt) {
      const lista = cfg.modos || [];
      modoTxt.textContent = iModo === null ? SEM_DADO : (lista[iModo] ?? `código ${iModo}`);
      modoTxt.style.color = iModo !== null && iModo !== 1 ? 'var(--atencao)' : 'var(--tinta)';
    }
    if (redeTxt) {
      redeTxt.textContent = rede === null ? SEM_DADO : (rede >= 0.5 ? 'presente' : 'ausente');
      redeTxt.style.color = rede !== null && rede < 0.5 ? 'var(--critico)' : 'var(--tinta)';
    }
    if (autonomia) {
      const consumo = cfg.consumo_litros_hora || 0;
      if (nivel === null || !consumo) autonomia.textContent = SEM_DADO;
      else {
        const h = ((nivel / 100) * cfg.capacidade_tanque_litros) / consumo;
        autonomia.textContent = `${num(h, 1)} h em plena carga`;
        autonomia.style.color = h < 4 ? 'var(--critico)' : h < 8 ? 'var(--atencao)' : 'var(--tinta)';
      }
    }

    // controladores que informam os disjuntores (DSE8620 pelos LEDs virtuais)
    const disjuntores = $('#gmg-disjuntores', raiz);
    if (disjuntores) {
      const gerador = valor(`${id}.disjuntor_fechado`);
      const rede = valor(`${id}.disjuntor_rede_fechado`);
      const txt = (v) => (v === null ? '––' : v >= 0.5 ? 'fechado' : 'aberto');
      // os dois fechados = em paralelo com a rede, operação normal no 8620
      disjuntores.textContent = rede === null ? `gerador ${txt(gerador)}`
        : gerador >= 0.5 && rede >= 0.5 ? 'em paralelo com a rede'
          : `gerador ${txt(gerador)} · rede ${txt(rede)}`;
    }

    indicadores.atualizarAgora(raiz, cfg);

    // primeira falha: a janela que acendeu primeiro fica marcada, como no anunciador físico
    const janelas = Array.from(raiz.querySelectorAll('[data-falha]'));
    const ativas = janelas.filter((j) => j.classList.contains('ativa'));
    if (!ativas.length) this._primeira = null;
    else if (!this._primeira || !ativas.includes(this._primeira)) [this._primeira] = ativas;
    for (const j of janelas) j.classList.toggle('primeira', j === this._primeira && ativas.length > 1);

    if (eq && !eq.online) {
      for (const j of janelas) j.classList.remove('ativa', 'primeira');
    }
  },

  destruir() {
    if (this._limpar) this._limpar();
    this._limpar = null;
    this._primeira = null;
    indicadores.destruir();
  },
};
