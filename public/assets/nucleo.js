/* Núcleo do supervisório: estado, formatação, vínculos de dados e conexão.
   Os vínculos são coletados uma vez por tela e reaproveitados a cada
   varredura — nada de varrer o DOM inteiro a 1 Hz. */

export const estado = {
  usuario: null,
  config: null,
  dados: { ts: Date.now(), equipamentos: {}, alarmes: [] },
  conectado: false,
  tela: 'energia',
};

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

export const SEM_DADO = '––';

export function num(v, dec = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return SEM_DADO;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function hora(ts, comSegundos = true) {
  if (!ts) return SEM_DADO;
  return new Date(ts).toLocaleTimeString('pt-BR',
    { hour: '2-digit', minute: '2-digit', ...(comSegundos ? { second: '2-digit' } : {}) });
}

export function dataHora(ts) {
  if (!ts) return SEM_DADO;
  return new Date(ts).toLocaleString('pt-BR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duracao(ms) {
  if (!Number.isFinite(ms) || ms < 0) return SEM_DADO;
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

export const esc = (t) => String(t ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------- consultas */

export function equipamento(id) {
  return estado.dados.equipamentos[id] || null;
}

export function valor(tag) {
  const [id, nome] = String(tag).split('.');
  const eq = estado.dados.equipamentos[id];
  if (!eq || !eq.online) return null;
  const v = eq.valores[nome];
  return v === undefined ? null : v;
}

export function defTag(tag) {
  const [id, nome] = String(tag).split('.');
  const eq = estado.config.equipamentos.find((e) => e.id === id);
  return eq?.tags.find((t) => t.nome === nome) || null;
}

export function defEquipamento(id) {
  return estado.config.equipamentos.find((e) => e.id === id) || null;
}

/** Regras de alarme que apontam para uma tag, na ordem em que foram configuradas. */
export function regrasDe(tag) {
  return (estado.config.limites || []).filter((r) => r.tag === tag);
}

/** Maior limite máximo configurado para uma tag (usado como fundo de escala). */
export function limiteMax(tag) {
  const v = regrasDe(tag).map((r) => r.max).filter((x) => x !== undefined);
  return v.length ? Math.max(...v) : null;
}

export function tagsEmAlarme() {
  return new Set(estado.dados.alarmes.map((a) => a.tag));
}

/** Carga de um equipamento elétrico: maior fase sobre a corrente do disjuntor. */
export function carga(idEquipamento) {
  const eq = equipamento(idEquipamento);
  if (!eq || !eq.online) return { corrente: null, fracao: 0, online: false };
  const fases = ['corrente_a', 'corrente_b', 'corrente_c']
    .map((f) => eq.valores[f])
    .filter((v) => Number.isFinite(v));
  const corrente = fases.length ? Math.max(...fases) : null;
  const limite = limiteMax(`${idEquipamento}.corrente_a`);
  return { corrente, fracao: corrente !== null && limite ? corrente / limite : 0, online: true };
}

export function classeCarga(fracao) {
  if (fracao >= 1) return 'critico';
  if (fracao >= 0.8) return 'atencao';
  return '';
}

/* --------------------------------------------------- vínculos de dados
   Cada tela declara os vínculos no HTML com data-*; aqui eles viram uma
   lista fechada, percorrida a cada varredura sem tocar no resto do DOM. */

let vinculos = null;

export function coletarVinculos(raiz) {
  vinculos = {
    valores: $$('[data-tag]', raiz).map((el) => ({ el, tag: el.dataset.tag, dec: Number(el.dataset.dec ?? 1) })),
    leituras: $$('[data-leitura]', raiz).map((el) => ({ el, tag: el.dataset.leitura })),
    barras: $$('[data-barra]', raiz).map((el) => ({
      el, tag: el.dataset.barra, escala: Number(el.dataset.escala) || 100,
    })),
    escalas: $$('[data-escala-tag]', raiz).map((el) => ({
      el, tag: el.dataset.escalaTag,
      min: Number(el.dataset.min ?? 0), max: Number(el.dataset.max ?? 100),
      inverso: el.dataset.inverso === 'sim',
    })),
    condutores: $$('[data-cond]', raiz).map((el) => ({ el, id: el.dataset.cond })),
    fluxos: $$('[data-fluxo]', raiz).map((el) => ({ el, id: el.dataset.fluxo })),
    cargasBarra: $$('[data-carga-barra]', raiz).map((el) => ({
      el, id: el.dataset.cargaBarra, total: Number(el.dataset.larguraMax) || 100,
    })),
    cargasTexto: $$('[data-carga-txt]', raiz).map((el) => ({ el, id: el.dataset.cargaTxt })),
    leds: $$('[data-led]', raiz).map((el) => ({ el, id: el.dataset.led })),
    estados: $$('[data-estado]', raiz).map((el) => ({ el, id: el.dataset.estado })),
    digitais: $$('[data-digital]', raiz).map((el) => ({
      el, tag: el.dataset.digital, inverso: el.dataset.inverso === 'sim',
    })),
  };
}

const ehSvg = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg';

export function aplicarVinculos() {
  if (!vinculos) return;
  const emAlarme = tagsEmAlarme();

  for (const { el, tag, dec } of vinculos.valores) {
    const v = valor(tag);
    const texto = num(v, dec);
    if (el.textContent !== texto) el.textContent = texto;
    const caixa = el.closest('.valor');
    if (caixa) caixa.classList.toggle('sem-dado', v === null);
    if (ehSvg(el)) el.classList.toggle('alerta', emAlarme.has(tag));
  }

  for (const { el, tag } of vinculos.leituras) el.classList.toggle('anormal', emAlarme.has(tag));

  for (const { el, tag, escala } of vinculos.barras) {
    const v = valor(tag) ?? 0;
    el.style.width = `${Math.min(100, Math.max(0, (v / escala) * 100))}%`;
  }

  for (const { el, tag, min, max } of vinculos.escalas) {
    const v = valor(tag);
    const fr = v === null ? 0 : Math.min(1, Math.max(0, (v - min) / (max - min || 1)));
    el.style.width = `${fr * 100}%`;
    const critico = regrasDe(tag).some((r) => r.prioridade === 'alta'
      && ((r.min !== undefined && v !== null && v < r.min) || (r.max !== undefined && v !== null && v > r.max)));
    const atencao = regrasDe(tag).some((r) => r.prioridade !== 'alta'
      && ((r.min !== undefined && v !== null && v < r.min) || (r.max !== undefined && v !== null && v > r.max)));
    el.classList.toggle('critico', critico);
    el.classList.toggle('atencao', !critico && atencao);
  }

  for (const { el, id } of vinculos.condutores) {
    const { corrente, fracao } = carga(id);
    const viva = corrente !== null && corrente > 0.5;
    el.classList.toggle('energizado', viva);
    el.classList.toggle('atencao-carga', viva && fracao >= 0.8 && fracao < 1);
    el.classList.toggle('sobrecarga', viva && fracao >= 1);
  }

  for (const { el, id } of vinculos.fluxos) {
    const { corrente, fracao } = carga(id);
    const viva = corrente !== null && corrente > 0.5;
    el.style.visibility = viva ? 'visible' : 'hidden';
    el.classList.toggle('atencao-carga', viva && fracao >= 0.8 && fracao < 1);
    el.classList.toggle('sobrecarga', viva && fracao >= 1);
    el.style.animationDuration = `${(2.4 - 1.7 * Math.min(1, fracao)).toFixed(2)}s`;
  }

  for (const { el, id, total } of vinculos.cargasBarra) {
    const { fracao } = carga(id);
    el.setAttribute('width', (Math.min(1, Math.max(0, fracao)) * total).toFixed(1));
    el.style.fill = fracao >= 1 ? 'var(--critico)' : fracao >= 0.8 ? 'var(--atencao)' : 'var(--tinta)';
  }

  for (const { el, id } of vinculos.cargasTexto) {
    const { corrente, fracao, online } = carga(id);
    el.textContent = !online || corrente === null ? SEM_DADO : `${Math.round(fracao * 100)} %`;
    el.setAttribute('class', fracao >= 1 ? 'rot alerta' : 'rot');
  }

  for (const { el, id } of vinculos.leds) {
    const eq = equipamento(id);
    el.style.fill = eq?.online ? 'var(--ok)' : 'var(--critico)';
  }

  for (const { el, id } of vinculos.estados) {
    const eq = equipamento(id);
    const ok = !!eq?.online;
    el.textContent = ok ? 'em serviço' : 'sem comunicação';
    el.classList.toggle('ruim', !ok);
  }

  for (const { el, tag, inverso } of vinculos.digitais) {
    const v = valor(tag);
    const ligado = v !== null && v >= 0.5;
    const anormal = inverso ? !ligado : ligado;
    el.classList.toggle('ativa', v !== null && anormal);
  }
}

/* -------------------------------------------------------------- conexão */

const ouvintes = new Set();
export const aoAtualizar = (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); };
export function publicar() { for (const fn of ouvintes) fn(); }

let ws = null;
let tentativa = 0;

export function conectar() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => { tentativa = 0; estado.conectado = true; };
  ws.onmessage = (ev) => {
    try {
      estado.dados = JSON.parse(ev.data);
      estado.conectado = true;
      publicar();
    } catch (e) {
      console.error('pacote inválido', e);
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = (ev) => {
    estado.conectado = false;
    publicar();
    // 4001: o servidor encerrou a sessão (saída, senha trocada, usuário desativado)
    if (ev.code === 4001) { location.href = '/login'; return; }
    tentativa = Math.min(tentativa + 1, 6);
    // o navegador não mostra o 401 do handshake; a partir da segunda falha
    // seguida pergunta à API, que leva ao login se a sessão tiver acabado
    if (tentativa >= 2) api('/api/eu').catch(() => {});
    setTimeout(conectar, 1000 * tentativa);   // espera crescente, até 6 s
  };
}

export const PAPEIS = { operador: 1, tecnico: 2, admin: 3 };

/** O usuário atual alcança este papel? */
export function pode(minimo) {
  return (PAPEIS[estado.usuario?.papel] || 0) >= (PAPEIS[minimo] || 99);
}

/**
 * Toda chamada à API passa por aqui. O cabeçalho X-Painel é posto
 * automaticamente: o servidor recusa POST sem ele (é o que barra formulário
 * enviado de outro site), e depender de cada tela lembrar disso já custou um
 * botão de reconhecer alarme que não funcionava.
 */
export async function api(rota, opcoes = {}) {
  const r = await fetch(rota, {
    credentials: 'same-origin',
    ...opcoes,
    headers: {
      'X-Painel': '1',
      ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opcoes.headers || {}),
    },
  });
  if (r.status === 428) { location.href = '/login'; throw new Error('troca de senha obrigatória'); }
  const dados = await r.json().catch(() => ({}));
  // 401 normalmente é sessão perdida e leva ao login. A exceção é a senha pedida
  // no momento de acionar um comando: ali a sessão continua boa e o operador
  // precisa continuar na tela, só com o aviso de senha incorreta.
  if (r.status === 401 && dados.sessao !== 'valida') {
    location.href = '/login';
    throw new Error(dados.erro || 'sessão expirada');
  }
  if (!r.ok) {
    const e = new Error(dados.erro || (dados.erros || []).join(' · ') || `${rota}: ${r.status}`);
    e.dados = dados;          // validação devolve { erros, avisos }
    e.status = r.status;
    throw e;
  }
  return dados;
}

/* ------------------------------------------------------- séries históricas */

export const MODO_DEMO = window.DEMO_EMBUTIDO === true
  || new URLSearchParams(location.search).has('demo');

/** Série sintética para o modo demonstração, com perfil de dia comercial. */
function serieSimulada(tag, horas) {
  const base = valor(tag) ?? 50;
  const ate = Date.now();
  const n = 200;
  const passo = (horas * 3600000) / n;
  return Array.from({ length: n }, (_, i) => {
    const t = ate - (n - i) * passo;
    const h = new Date(t).getHours();
    const jornada = h >= 7 && h <= 21 ? 1 : 0.45;
    const med = base * jornada * (1 + 0.06 * Math.sin(i / 8) + (Math.random() - 0.5) * 0.03);
    const disp = Math.abs(med) * 0.05;
    return { t, med, min: med - disp, max: med + disp };
  });
}

export async function serie(tag, horas) {
  if (MODO_DEMO) return serieSimulada(tag, horas);
  try {
    const r = await api(`/api/historico?tag=${encodeURIComponent(tag)}&horas=${horas}`);
    return r.pontos;
  } catch {
    return [];
  }
}
