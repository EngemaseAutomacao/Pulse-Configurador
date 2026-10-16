import {
  estado, esc, num, valor, equipamento, serie, $, SEM_DADO,
} from '../nucleo.js';
import { placa, leitura } from './energia.js';
import { desenharTendencia } from '../grafico.js';

/**
 * Geometria do desenho, em faixas que não se cruzam:
 *   0-60    coluna da bomba de recalque
 *   64-96   cota de altura útil
 *   110-290 corpo do reservatório
 *   300-470 rótulos dos limites, um por linha
 * Manter essas faixas é o que impede rótulo escrito por cima de rótulo.
 */
const TQ = { x: 110, larg: 180, topo: 76, base: 300 };
const alturaUtil = TQ.base - TQ.topo;
const yDoNivel = (pct) => TQ.base - (Math.min(100, Math.max(0, pct)) / 100) * alturaUtil;

/**
 * As janelas do anunciador saem das próprias tags digitais do equipamento —
 * nada de lista fixa no código. Cada tag traz no perfil a severidade
 * ("info" = estado normal, "media", "alta") e se é de lógica invertida.
 */
function digitaisDe(equipamento) {
  return (equipamento?.tags || [])
    .filter((t) => t.digital && !t.oculto)
    .map((t) => ({
      nome: t.nome,
      rotulo: t.rotulo,
      severidade: t.severidade || 'media',
      inverso: !!t.inverso,
    }));
}

export const telaAgua = {
  id: 'agua',
  isa: 'TQ-01',
  nome: 'Água',
  titulo: "Caixa d'água",
  _limpar: null,

  montar() {
    const cfg = estado.config.caixa_agua;
    const id = cfg.medidor;
    const marcas = cfg.marcas || [];
    const eq = estado.config.equipamentos.find((e) => e.id === id);
    const tag = (n) => eq?.tags.find((t) => t.nome === n);

    /**
     * Todos os rótulos da direita — limites e bocais — passam pelo mesmo
     * algoritmo: ordena por altura e empurra para baixo o que ficaria colado,
     * ligando texto e ponto real por uma linha de chamada. É o que garante que
     * "alto 97%" e "extravasor" nunca mais se escrevam um por cima do outro.
     */
    const chamadas = [
      ...marcas.map((m) => ({
        y: yDoNivel(m.valor),
        texto: `${m.rotulo} · ${m.valor}%`,
        cor: m.prioridade === 'alta' ? 'var(--critico)'
          : m.prioridade === 'media' ? 'var(--atencao)' : 'var(--tinta-3)',
        tracejado: true,
      })),
      { y: TQ.topo + 18, texto: 'extravasor', cor: 'var(--tinta-2)', bocal: true },
      { y: TQ.base - 14, texto: 'saída de consumo', cor: 'var(--tinta-2)', bocal: true },
    ].sort((a, b) => a.y - b.y);

    const X_LINHA = TQ.x + TQ.larg + 8;
    const X_TEXTO = TQ.x + TQ.larg + 54;
    let ultimo = -Infinity;
    const anotacoes = chamadas.map((c) => {
      const yTexto = Math.max(c.y, ultimo + 17);
      ultimo = yTexto;
      return `
        <line x1="${c.tracejado ? TQ.x + 6 : TQ.x + TQ.larg}" y1="${c.y}" x2="${X_LINHA}" y2="${c.y}"
              stroke="${c.cor}" stroke-width="1"${c.tracejado ? ' stroke-dasharray="5 4"' : ''} opacity=".85"/>
        <path d="M ${X_LINHA} ${c.y} L ${X_LINHA + 14} ${yTexto} H ${X_TEXTO - 6}"
              stroke="${c.cor}" stroke-width="1" fill="none" opacity=".5"/>
        <text class="rot" x="${X_TEXTO}" y="${yTexto + 3.5}" style="fill:${c.cor}">${esc(c.texto)}</text>`;
    }).join('');

    const meioTanque = (TQ.topo + TQ.base) / 2;

    return `
      <div class="grade dupla">
        <section class="bloco">
          ${placa(cfg.tag_isa || 'TQ-01', 'Reservatório', id)}
          <div class="corpo">
            <div class="rolagem">
            <svg class="desenho" viewBox="0 0 620 400" role="img"
                 aria-label="Reservatório com o nível medido e os limites de alarme">

              <!-- coluna da bomba de recalque: faixa 0-70, nada entra aqui -->
              <circle class="caixa" cx="38" cy="214" r="18"/>
              <text class="simbolo" x="38" y="218" text-anchor="middle">B1</text>
              <text class="rot" x="38" y="248" text-anchor="middle">recalque</text>
              <path class="cond" data-cond="${id}" d="M 38 196 V 44 H ${TQ.x + 46} V ${TQ.topo}"/>
              <path class="fluxo" data-fluxo="${id}" d="M 38 196 V 44 H ${TQ.x + 46} V ${TQ.topo}"
                    style="visibility:hidden"/>

              <!-- cota de altura útil: faixa 72-100 -->
              <path class="cota" d="M 84 ${TQ.topo} h 12 M 90 ${TQ.topo} V ${TQ.base} M 84 ${TQ.base} h 12"/>
              <path class="cota" d="M 87 ${TQ.topo + 7} l 3 -7 l 3 7 M 87 ${TQ.base - 7} l 3 7 l 3 -7"/>
              <text class="rot" x="76" y="${meioTanque}" text-anchor="middle"
                    transform="rotate(-90 76 ${meioTanque})">altura útil ${num(cfg.altura_util_m, 2)} m</text>

              <!-- água: desenhada antes da parede, que agora não tem preenchimento -->
              <rect id="tq-agua" class="agua" x="${TQ.x + 3}" y="${TQ.base}"
                    width="${TQ.larg - 6}" height="0" opacity=".5"/>
              <line id="tq-linha" class="agua-topo" x1="${TQ.x + 3}" y1="${TQ.base}"
                    x2="${TQ.x + TQ.larg - 3}" y2="${TQ.base}"/>

              <!-- parede dupla -->
              <rect class="parede" x="${TQ.x}" y="${TQ.topo}" width="${TQ.larg}" height="${alturaUtil}"/>
              <rect class="parede-interna" x="${TQ.x + 4}" y="${TQ.topo + 4}"
                    width="${TQ.larg - 8}" height="${alturaUtil - 8}"/>

              <!-- bocais -->
              <path class="cond" d="M ${TQ.x + TQ.larg} ${TQ.topo + 18} h 8"/>
              <path class="cond" d="M ${TQ.x + TQ.larg / 2} ${TQ.base} V 340"/>
              <path class="cond" d="M ${TQ.x + TQ.larg} ${TQ.base - 14} h 8"/>

              ${anotacoes}

              <text id="tq-pct" class="valor-desenho" x="${TQ.x + TQ.larg / 2}" y="${TQ.topo - 22}"
                    text-anchor="middle">––</text>
              <text class="rot" x="${TQ.x + TQ.larg / 2}" y="358" text-anchor="middle"
                    id="tq-volume-svg">${num(cfg.capacidade_litros, 0)} L quando cheio</text>
            </svg>
            </div>
          </div>
        </section>

        <section class="bloco">
          ${placa('LIT-01', 'Medição e comando')}
          <div class="corpo">
            <div class="leituras">
              <div class="leitura" data-leitura="${id}.nivel">
                <span class="rotulo">Nível</span>
                <span class="valor g sem-dado"><span data-tag="${id}.nivel" data-dec="1">––</span><span class="un">%</span></span>
                <div class="escala">
                  <div class="trilho">
                    <span class="barra" data-escala-tag="${id}.nivel" data-min="0" data-max="100"></span>
                    ${marcas.map((m) => `<span class="limite ${m.prioridade === 'alta' ? 'critico' : m.prioridade === 'media' ? 'atencao' : ''}"
                          style="left:${m.valor}%"></span>`).join('')}
                  </div>
                  <div class="extremos"><span>vazio</span><span>${num(cfg.capacidade_litros, 0)} L</span></div>
                </div>
              </div>
              <div class="leitura">
                <span class="rotulo">Volume armazenado</span>
                <span class="valor sem-dado"><span id="tq-volume">––</span><span class="un">L</span></span>
              </div>
              ${leitura(`${id}.coluna`, tag('coluna'))}
              ${leitura(`${id}.vazao_entrada`, tag('vazao_entrada'))}
              ${leitura(`${id}.pressao_recalque`, tag('pressao_recalque'))}
              ${leitura(`${id}.horas_bomba`, tag('horas_bomba'))}
            </div>

            <div class="anunciador" style="margin-top:14px">
              ${digitaisDe(eq).map((d) => `
                <div class="janela" data-prioridade="${d.severidade}" data-digital="${id}.${d.nome}"${
  d.inverso ? ' data-inverso="sim"' : ''}>
                  ${esc(d.rotulo)}</div>`).join('')}
            </div>
          </div>
        </section>
      </div>

      <section class="bloco">
        ${placa('TQ-01', 'Tendência de nível')}
        <div class="corpo">
          <div class="controles">
            <div class="grupo-botoes" role="group" aria-label="Período">
              ${[[6, '6 h'], [24, '24 h'], [168, '7 dias']].map(([h, r], i) => `
                <button class="botao" data-horas="${h}" aria-pressed="${i === 1}">${r}</button>`).join('')}
            </div>
            <span class="rotulo" id="tq-resumo" style="margin:0"></span>
          </div>
          <canvas id="tq-grafico"></canvas>
        </div>
      </section>`;
  },

  aoMontar(raiz) {
    const cfg = estado.config.caixa_agua;
    const tag = `${cfg.medidor}.${cfg.tag_nivel}`;
    let horas = 24;
    let pedido = 0;

    const desenhar = async () => {
      const meu = ++pedido;
      const pontos = await serie(tag, horas);
      if (meu !== pedido) return;                 // descarta resposta atrasada
      const canvas = $('#tq-grafico', raiz);
      if (!canvas || !canvas.isConnected) return;
      desenharTendencia(canvas, pontos, { unidade: '%', marcas: cfg.marcas || [] });
      const resumo = $('#tq-resumo', raiz);
      if (resumo && pontos.length) {
        const min = Math.min(...pontos.map((p) => p.min));
        const max = Math.max(...pontos.map((p) => p.max));
        resumo.textContent = `mínimo ${num(min, 1)} % · máximo ${num(max, 1)} % no período`;
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
    desenhar();
  },

  atualizar(raiz) {
    const cfg = estado.config.caixa_agua;
    const nivel = valor(`${cfg.medidor}.${cfg.tag_nivel}`);
    const eq = equipamento(cfg.medidor);

    const agua = $('#tq-agua', raiz);
    const linha = $('#tq-linha', raiz);
    const pct = $('#tq-pct', raiz);
    const volume = $('#tq-volume', raiz);
    if (!agua) return;

    if (nivel === null) {
      agua.setAttribute('height', '0');
      pct.textContent = SEM_DADO;
      pct.setAttribute('class', 'valor-desenho');
      if (volume) volume.textContent = SEM_DADO;
      return;
    }

    const y = yDoNivel(nivel);
    agua.setAttribute('y', y.toFixed(1));
    agua.setAttribute('height', (TQ.base - y).toFixed(1));
    linha.setAttribute('y1', y.toFixed(1));
    linha.setAttribute('y2', y.toFixed(1));

    pct.textContent = `${num(nivel, 1)} %`;
    const critico = (cfg.marcas || []).some((m) => m.prioridade === 'alta' && nivel < m.valor);
    pct.setAttribute('class', critico ? 'valor-desenho alerta' : 'valor-desenho');
    agua.setAttribute('opacity', eq?.online ? '.55' : '.2');

    if (volume) volume.textContent = num((nivel / 100) * cfg.capacidade_litros, 0);
    const caixaVolume = volume?.closest('.valor');
    if (caixaVolume) caixaVolume.classList.remove('sem-dado');
  },

  destruir() {
    if (this._limpar) this._limpar();
    this._limpar = null;
  },
};
