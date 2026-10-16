/* Gráfico de tendência em canvas puro — sem CDN, porque a rede da
   instalação costuma ser isolada. As cores vêm das variáveis do tema
   (claro ou escuro), lidas a cada desenho: trocar o tema redesenha certo. */

const lerVar = (nome, padrao) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(nome).trim() || padrao;
  } catch {
    return padrao;
  }
};

function coresDoTema() {
  return {
    linha: lerVar('--tinta', '#0c2340'),
    banda: lerVar('--banda-grafico', 'rgba(12, 35, 64, .12)'),
    grade: lerVar('--linha', '#e3e8ee'),
    texto: lerVar('--tinta-3', '#7f8a9d'),
    fundo: lerVar('--tela', '#ffffff'),
    critico: lerVar('--critico', '#c62f35'),
    atencao: lerVar('--atencao', '#d99000'),
    atencaoTexto: lerVar('--atencao-texto', '#8a5c00'),
  };
}

export function desenharTendencia(canvas, pontos, { unidade = '', marcas = [] } = {}) {
  const CORES = coresDoTema();
  const dpr = window.devicePixelRatio || 1;
  const larg = canvas.clientWidth;
  const alt = canvas.clientHeight;
  if (!larg || !alt) return;
  canvas.width = Math.round(larg * dpr);
  canvas.height = Math.round(alt * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CORES.fundo;
  ctx.fillRect(0, 0, larg, alt);

  const m = { e: 56, d: 14, c: 12, b: 24 };
  const w = larg - m.e - m.d;
  const h = alt - m.c - m.b;

  if (!pontos || pontos.length < 2) {
    ctx.fillStyle = CORES.texto;
    ctx.font = '13px Manrope, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem registro no período.', larg / 2, alt / 2 - 8);
    ctx.fillText('O histórico começa a gravar assim que o servidor lê o equipamento.', larg / 2, alt / 2 + 12);
    return;
  }

  const t0 = pontos[0].t;
  const t1 = pontos[pontos.length - 1].t;
  let vMin = Math.min(...pontos.map((p) => p.min), ...marcas.map((x) => x.valor));
  let vMax = Math.max(...pontos.map((p) => p.max), ...marcas.map((x) => x.valor));
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return;
  if (vMax - vMin < 1e-6) { vMax += 1; vMin -= 1; }
  const folga = (vMax - vMin) * 0.1;
  vMin -= folga; vMax += folga;

  const px = (t) => m.e + ((t - t0) / (t1 - t0 || 1)) * w;
  const py = (v) => m.c + h - ((v - vMin) / (vMax - vMin)) * h;

  ctx.font = '11px ui-monospace, monospace';
  ctx.strokeStyle = CORES.grade;
  ctx.fillStyle = CORES.texto;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = vMin + ((vMax - vMin) * i) / 4;
    const y = Math.round(py(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(m.e, y); ctx.lineTo(m.e + w, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(escala(v), m.e - 8, y);
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const varreDias = (t1 - t0) > 86400000;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    const d = new Date(t);
    const rot = varreDias
      ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(rot, Math.min(Math.max(px(t), m.e + 16), m.e + w - 16), m.c + h + 7);
  }

  // linhas de limite configuradas (alarme)
  for (const marca of marcas) {
    const y = Math.round(py(marca.valor)) + 0.5;
    if (y < m.c || y > m.c + h) continue;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = marca.prioridade === 'alta' ? CORES.critico : CORES.atencao;
    ctx.beginPath(); ctx.moveTo(m.e, y); ctx.lineTo(m.e + w, y); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = marca.prioridade === 'alta' ? CORES.critico : CORES.atencaoTexto;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(marca.rotulo, m.e + 4, y - 2);
  }

  // faixa mínimo–máximo do período agregado
  ctx.beginPath();
  pontos.forEach((p, i) => (i ? ctx.lineTo(px(p.t), py(p.max)) : ctx.moveTo(px(p.t), py(p.max))));
  for (let i = pontos.length - 1; i >= 0; i--) ctx.lineTo(px(pontos[i].t), py(pontos[i].min));
  ctx.closePath();
  ctx.fillStyle = CORES.banda;
  ctx.fill();

  ctx.beginPath();
  pontos.forEach((p, i) => (i ? ctx.lineTo(px(p.t), py(p.med)) : ctx.moveTo(px(p.t), py(p.med))));
  ctx.strokeStyle = CORES.linha;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const ultimo = pontos[pontos.length - 1];
  ctx.beginPath();
  ctx.arc(px(ultimo.t), py(ultimo.med), 3, 0, Math.PI * 2);
  ctx.fillStyle = CORES.linha;
  ctx.fill();

  const texto = `${escala(ultimo.med)} ${unidade}`.trim();
  ctx.font = '600 12px ui-monospace, monospace';
  const lt = ctx.measureText(texto).width;
  const bx = Math.min(px(ultimo.t) + 8, m.e + w - lt - 10);
  const by = Math.min(Math.max(py(ultimo.med) - 20, m.c), m.c + h - 20);
  ctx.fillStyle = CORES.linha;
  ctx.fillRect(bx, by, lt + 10, 18);
  ctx.fillStyle = CORES.fundo;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(texto, bx + 5, by + 9);
}

/* Cores das séries na comparação do Histórico. Ordem fixa e validada para
   daltonismo sobre o fundo #e8eae5 (pior par vizinho ΔE 9,1). Laranja,
   verde-água, amarelo e rosa ficam abaixo de 3:1 no fundo claro: por isso cada
   série tem legenda com o nome e, até 4 séries, o valor escrito na ponta. */
export const PALETA_SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

/**
 * Várias séries com a MESMA unidade num eixo só (quem tem unidade diferente vai
 * para outro painel — nunca dois eixos verticais no mesmo gráfico).
 *   series: [{ pontos, cor, rotulo, unidade }]   pontos = [{ t, min, med, max }]
 *   t0, t1: o mesmo intervalo em todos os painéis, para os tempos se alinharem
 * Devolve a geometria, para a tela converter a posição do mouse em instante.
 */
export function desenharComparacao(canvas, series, { t0, t1, marcas = [], unidade = '' } = {}) {
  const CORES = coresDoTema();
  const dpr = window.devicePixelRatio || 1;
  const larg = canvas.clientWidth;
  const alt = canvas.clientHeight;
  if (!larg || !alt) return null;
  canvas.width = Math.round(larg * dpr);
  canvas.height = Math.round(alt * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CORES.fundo;
  ctx.fillRect(0, 0, larg, alt);

  const rotularPonta = series.length <= 4;
  const m = { e: 56, d: rotularPonta ? 92 : 14, c: 12, b: 24 };
  const w = larg - m.e - m.d;
  const h = alt - m.c - m.b;
  const comDados = series.filter((s) => s.pontos && s.pontos.length >= 2);
  if (!comDados.length || !(t1 > t0)) {
    ctx.fillStyle = CORES.texto;
    ctx.font = '13px Manrope, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem registro no período.', larg / 2, alt / 2);
    return null;
  }

  const sozinha = comDados.length === 1;
  const valores = comDados.flatMap((s) => s.pontos.flatMap((p) => (sozinha ? [p.min, p.max] : [p.med])));
  let vMin = Math.min(...valores, ...(sozinha ? marcas.map((x) => x.valor) : []));
  let vMax = Math.max(...valores, ...(sozinha ? marcas.map((x) => x.valor) : []));
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return null;
  if (vMax - vMin < 1e-6) { vMax += 1; vMin -= 1; }
  const folga = (vMax - vMin) * 0.1;
  // grandeza que nunca fica negativa (corrente, tensão) não ganha eixo abaixo de zero
  const semNegativo = vMin >= 0;
  vMin -= folga; vMax += folga;
  if (semNegativo && vMin < 0) vMin = 0;
  const px = (t) => m.e + ((t - t0) / (t1 - t0)) * w;
  const py = (v) => m.c + h - ((v - vMin) / (vMax - vMin)) * h;

  ctx.font = '11px ui-monospace, monospace';
  ctx.strokeStyle = CORES.grade;
  ctx.fillStyle = CORES.texto;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = vMin + ((vMax - vMin) * i) / 4;
    const y = Math.round(py(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(m.e, y); ctx.lineTo(m.e + w, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(escala(v), m.e - 8, y);
  }
  if (unidade) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(unidade, 4, 2);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const varreDias = (t1 - t0) > 86400000;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    const d = new Date(t);
    const rot = varreDias
      ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(rot, Math.min(Math.max(px(t), m.e + 16), m.e + w - 16), m.c + h + 7);
  }

  // limites de alarme só com uma série: com várias, não se sabe de qual é a linha
  if (sozinha) {
    for (const marca of marcas) {
      const y = Math.round(py(marca.valor)) + 0.5;
      if (y < m.c || y > m.c + h) continue;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = marca.prioridade === 'alta' ? CORES.critico : CORES.atencao;
      ctx.beginPath(); ctx.moveTo(m.e, y); ctx.lineTo(m.e + w, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = marca.prioridade === 'alta' ? CORES.critico : CORES.atencaoTexto;
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(marca.rotulo, m.e + 4, y - 2);
    }
    // faixa mínimo–máximo, como na tendência de uma grandeza só
    const p = comDados[0].pontos;
    ctx.beginPath();
    p.forEach((q, i) => (i ? ctx.lineTo(px(q.t), py(q.max)) : ctx.moveTo(px(q.t), py(q.max))));
    for (let i = p.length - 1; i >= 0; i--) ctx.lineTo(px(p[i].t), py(p[i].min));
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = comDados[0].cor;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const s of comDados) {
    ctx.beginPath();
    s.pontos.forEach((q, i) => (i ? ctx.lineTo(px(q.t), py(q.med)) : ctx.moveTo(px(q.t), py(q.med))));
    ctx.strokeStyle = s.cor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // valor na ponta de cada linha (até 4), empurrando os rótulos para não encavalar
  if (rotularPonta) {
    const pontas = comDados.map((s) => {
      const u = s.pontos[s.pontos.length - 1];
      return { s, x: px(u.t), yLinha: py(u.med), y: py(u.med), texto: escala(u.med) };
    }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < pontas.length; i++) pontas[i].y = Math.max(pontas[i].y, pontas[i - 1].y + 15);
    const excesso = pontas.length ? pontas[pontas.length - 1].y - (m.c + h) : 0;
    if (excesso > 0) for (const p of pontas) p.y -= excesso;
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const p of pontas) {
      ctx.fillStyle = p.s.cor;
      ctx.beginPath(); ctx.arc(p.x, p.yLinha, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(m.e + w + 6, p.y - 1, 8, 2);
      ctx.fillStyle = CORES.linha;          // texto em tinta, não na cor da série
      ctx.textAlign = 'left';
      ctx.fillText(p.texto, m.e + w + 18, p.y);
    }
  }
  return { t0, t1, esquerda: m.e, largura: w };
}

function escala(v) {
  const abs = Math.abs(v);
  const casas = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
