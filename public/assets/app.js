import {
  estado, $, esc, dataHora, api, conectar, aoAtualizar, publicar,
  coletarVinculos, aplicarVinculos, MODO_DEMO, pode,
} from './nucleo.js';
import { telaEnergia } from './telas/energia.js';
import { telaUnifilar } from './telas/unifilar.js';
import { telaConsumo } from './telas/consumo.js';
import { telaAgua } from './telas/agua.js';
import { telaGerador } from './telas/gerador.js';
import { telaHistorico } from './telas/historico.js';
import { telaAlarmes } from './telas/alarmes.js';
import { telaEngenharia } from './telas/engenharia.js';
import { telaUsuarios } from './telas/usuarios.js';

const CATALOGO = [telaEnergia, telaUnifilar, telaConsumo, telaAgua, telaGerador,
  telaHistorico, telaAlarmes, telaEngenharia, telaUsuarios];

// Energia e Unifilar são o esqueleto do produto e ficam sempre no menu: sem
// medidor configurado elas mostram o que falta fazer, em vez de sumir. Água e
// Gerador dependem do equipamento, porque sem reservatório ou sem grupo gerador
// não há o que desenhar. Engenharia e Usuários dependem do papel.
const EXIGE_GRUPO = { agua: 'agua', gerador: 'gerador' };
const EXIGE_SECAO = { agua: 'caixa_agua', gerador: 'gerador' };
let TELAS = [];

/**
 * Quais telas entram no menu.
 *
 * Por padrão, Água e Gerador só aparecem quando existem de verdade — loja sem
 * reservatório não precisa de uma tela de reservatório. Mas na hora de instalar
 * é o contrário: o técnico quer a tela antes do equipamento, para seguir o guia.
 * Daí o `telas` da configuração, que manda em cima da regra automática:
 *   "telas": { "gerador": true }    mostra sempre, com o guia quando faltar
 *   "telas": { "agua": false }      esconde mesmo havendo equipamento
 */
function telasDisponiveis() {
  const grupos = new Set((estado.config.equipamentos || []).map((e) => e.grupo));
  const pedido = estado.config.telas || {};
  return CATALOGO.filter((t) => {
    if (t.papel && (MODO_DEMO || !pode(t.papel))) return false;
    if (pedido[t.id] === false) return false;
    if (pedido[t.id] === true) return true;
    const grupo = EXIGE_GRUPO[t.id];
    if (grupo && !grupos.has(grupo)) return false;
    const secao = EXIGE_SECAO[t.id];
    if (secao && !estado.config[secao]) return false;
    return true;
  });
}
const GRUPO_DA_TELA = { energia: 'energia', unifilar: 'energia', agua: 'agua', gerador: 'gerador' };

let telaAtual = null;
let raiz = null;
/**
 * Sirene no padrão de anunciador, e não um bipe solto:
 *   ligado         chave do posto (botão da coluna). Desligada, nada soa.
 *   silenciadoEm   conjunto de alarmes que o operador já calou. Alarme NOVO
 *                  muda o conjunto e a sirene volta — silenciar não pode
 *                  desarmar o anunciador para o resto do turno.
 *   proximoToque   a sirene repete enquanto houver alarme não reconhecido.
 * Reconhecer também cala, porque o alarme deixa de estar pendente.
 */
let som = { ligado: true, ctx: null, silenciadoEm: '', proximoToque: 0 };

const INTERVALO_SIRENE = { alta: 3000, media: 9000, baixa: 0 };

/** Identidade do conjunto pendente: muda quando entra ou sai um alarme. */
const chaveDoConjunto = (pendentes) => pendentes.map((a) => a.id).sort().join(',');

function atualizarSirene(pendentes) {
  const chave = chaveDoConjunto(pendentes);
  if (chave !== som.silenciadoEm && som.silenciadoEm) som.silenciadoEm = '';   // entrou alarme novo
  const silenciado = som.silenciadoEm === chave && chave !== '';

  const maisGrave = pendentes.reduce((m, a) => ((PESO[a.prioridade] || 0) > (PESO[m?.prioridade] || 0) ? a : m), null);
  const intervalo = INTERVALO_SIRENE[maisGrave?.prioridade] || 0;

  if (!pendentes.length || silenciado || !som.ligado || !intervalo) {
    som.proximoToque = 0;
    return { silenciado, tocando: false };
  }
  const agora = Date.now();
  if (agora >= som.proximoToque) {
    som.proximoToque = agora + intervalo;
    apitar(maisGrave.prioridade);
  }
  return { silenciado, tocando: true };
}

function silenciar() {
  som.silenciadoEm = chaveDoConjunto((estado.dados.alarmes || []).filter((a) => !a.reconhecido));
  som.proximoToque = 0;
  desenhar();
}

/* ------------------------------------------------------------- navegação */

function montarMenu() {
  const menu = $('#menu');
  menu.innerHTML = TELAS.map((t) => `
    <button class="item" data-tela="${t.id}" aria-current="${t.id === estado.tela ? 'page' : 'false'}">
      <span class="contagem" data-contagem="${t.id}" hidden></span>
      <span class="isa">${esc(t.isa || '')}</span>
      <span class="nome">${esc(t.nome)}</span>
    </button>`).join('');
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tela]');
    if (b) abrir(b.dataset.tela);
  });
}

/** Guarda a tela na URL. Aberto direto do disco (file://) o navegador recusa
    replaceState, e isso não pode derrubar a interface. */
function guardarNaUrl(id) {
  if (location.protocol === 'file:') return;
  if (location.hash.slice(1) === id) return;
  try {
    history.replaceState(null, '', `#${id}`);
  } catch {
    /* origem opaca ou navegação bloqueada: a tela funciona igual */
  }
}

function abrir(id) {
  // hash apontando para uma tela que esta instalação não tem cai na primeira
  const tela = TELAS.find((t) => t.id === id) || TELAS[0];
  if (!tela || tela === telaAtual) return;
  telaAtual?.destruir?.();
  telaAtual = tela;
  estado.tela = id;

  $('#titulo-tela').textContent = tela.titulo;
  $('#isa-tela').textContent = tela.isa || '';
  $('#isa-tela').hidden = !tela.isa;
  document.querySelectorAll('[data-tela]').forEach((b) => b.setAttribute('aria-current', b.dataset.tela === id ? 'page' : 'false'));

  guardarNaUrl(id);
  raiz.innerHTML = tela.montar();
  coletarVinculos(raiz);
  tela.aoMontar?.(raiz);
  desenhar();
  raiz.scrollTop = 0;
}

/* --------------------------------------------------- cabeçalho e alarmes */

const PESO = { alta: 3, media: 2, baixa: 1 };

function grupoDoAlarme(a) {
  const id = String(a.tag).split('.')[0];
  const eq = estado.config.equipamentos.find((e) => e.id === id);
  return eq?.grupo || 'energia';
}

function atualizarCabecalho() {
  const alarmes = estado.dados.alarmes || [];
  const pior = alarmes.reduce((m, a) => ((PESO[a.prioridade] || 0) > (PESO[m?.prioridade] || 0) ? a : m), null);
  const primeiro = alarmes.reduce((m, a) => (!m || a.inicio < m.inicio ? a : m), null);

  const faixa = $('#faixa-alarme');
  faixa.classList.toggle('visivel', alarmes.length > 0);
  if (alarmes.length) {
    // reconhecer não resolve o alarme: o operador diz "estou ciente" e a faixa
    // recua para um aviso discreto, mas continua ali enquanto a condição durar
    const pendentes = alarmes.filter((a) => !a.reconhecido);
    const tudoCiente = pendentes.length === 0;

    faixa.dataset.nivel = pior.prioridade;
    faixa.classList.toggle('ciente', tudoCiente);
    $('#faixa-quando').textContent = dataHora(primeiro.inicio);
    $('#faixa-msg').textContent = primeiro.mensagem;
    $('#faixa-resto').textContent = [
      alarmes.length > 1 ? `e mais ${alarmes.length - 1} ativo(s)` : '',
      tudoCiente ? '· reconhecido, aguardando normalizar' : '',
    ].filter(Boolean).join(' ');

    const btnRec = $('#faixa-reconhecer');
    btnRec.hidden = tudoCiente;
    btnRec.textContent = pendentes.length > 1 ? `Reconhecer ${pendentes.length}` : 'Reconhecer';
  } else {
    faixa.classList.remove('ciente');
  }

  const pendentesAgora = alarmes.filter((a) => !a.reconhecido);
  const sirene = atualizarSirene(pendentesAgora);
  const btnSilenciar = $('#faixa-silenciar');
  btnSilenciar.textContent = !som.ligado ? 'Som desligado'
    : sirene.silenciado ? 'Silenciado'
      : 'Silenciar';
  btnSilenciar.classList.toggle('apagado', !som.ligado || sirene.silenciado);
  btnSilenciar.disabled = !som.ligado || sirene.silenciado || !pendentesAgora.length;

  // contadores por tela
  const porGrupo = {};
  for (const a of alarmes) {
    const g = grupoDoAlarme(a);
    porGrupo[g] = (porGrupo[g] || 0) + 1;
  }
  for (const t of TELAS) {
    const el = document.querySelector(`[data-contagem="${t.id}"]`);
    if (!el) continue;
    const n = t.id === 'alarmes' ? alarmes.length : (porGrupo[GRUPO_DA_TELA[t.id]] || 0);
    el.hidden = n === 0;
    el.textContent = n;
  }

  const led = $('#led-conexao');
  led.className = `led ${!estado.conectado ? 'critico' : alarmes.some((a) => a.prioridade === 'alta') ? 'critico'
    : alarmes.length ? 'atencao' : 'ok'}`;
  $('#txt-conexao').textContent = !estado.conectado ? 'servidor fora do ar'
    : alarmes.length ? `${alarmes.length} alarme(s) ativo(s)` : 'operação normal';

}

function apitar(prioridade = 'alta') {
  if (!som.ligado || !som.ctx) return;
  const ctx = som.ctx;
  // o navegador suspende o contexto quando a aba perde o foco
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  // alta: dois toques rápidos e agudos. média: um toque grave.
  const toques = prioridade === 'alta' ? [[0, 880], [0.18, 880]] : [[0, 520]];
  for (const [atraso, hz] of toques) {
    const t0 = ctx.currentTime + atraso;
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = hz;
    ganho.gain.setValueAtTime(0.0001, t0);
    ganho.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    osc.connect(ganho).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  }
}

function desenhar() {
  atualizarCabecalho();
  aplicarVinculos();
  if (!telaAtual || !raiz) return;
  if (telaAtual.aoReceberDados) telaAtual.aoReceberDados(raiz);
  else telaAtual.atualizar?.(raiz);
}

/* ------------------------------------------------ modo demonstração local */

const pendentesDemo = new Map();
const inicioDemo = new Map();

function avaliarAlarmesDemo(equipamentos) {
  const agora = Date.now();
  const ativos = [];
  (estado.config.limites || []).forEach((r, i) => {
    const chave = `${r.tag || r.medidor}#${i}`;
    let violado = false;
    let v = null;

    if (r.comunicacao) {
      const eq = equipamentos[r.medidor];
      if (!eq) return;
      violado = !eq.online;
      v = eq.online ? 1 : 0;
    } else {
      const [id, nome] = String(r.tag).split('.');
      const eq = equipamentos[id];
      if (!eq || !eq.online) { pendentesDemo.delete(chave); inicioDemo.delete(chave); return; }
      v = eq.valores[nome];
      if (v === null || v === undefined) return;
      violado = r.digital
        ? (r.inverso ? v < 0.5 : v >= 0.5)
        : ((r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max));
    }

    if (!violado) { pendentesDemo.delete(chave); inicioDemo.delete(chave); return; }

    const desde = pendentesDemo.get(chave) ?? agora;
    pendentesDemo.set(chave, desde);
    if (agora - desde < (r.atraso_s ?? 0) * 1000) return;
    if (!inicioDemo.has(chave)) inicioDemo.set(chave, agora);

    ativos.push({
      id: i + 1,
      tag: r.tag || r.medidor,
      mensagem: r.mensagem,
      prioridade: r.prioridade || 'media',
      valor: v,
      limite: r.comunicacao ? 'sem resposta'
        : r.digital ? (r.inverso ? 'esperado ligado' : 'esperado desligado')
          : [r.min !== undefined ? `mín ${r.min}` : null, r.max !== undefined ? `máx ${r.max}` : null]
            .filter(Boolean).join(' · '),
      inicio: inicioDemo.get(chave),
      fim: null,
      reconhecido: 0,
    });
  });
  return ativos.sort((a, b) => a.inicio - b.inicio);
}

async function iniciarDemo() {
  const { CONFIG_DEMO, Simulador } = window.DEMO_RECURSOS;
  estado.config = CONFIG_DEMO;
  const sim = new Simulador(CONFIG_DEMO, { roteiro: true });
  const ciclo = async () => {
    const equipamentos = await sim.lerTodos();
    estado.dados = { ts: Date.now(), equipamentos, alarmes: avaliarAlarmesDemo(equipamentos), simulado: true };
    estado.conectado = true;
    publicar();
  };
  await ciclo();
  setInterval(ciclo, 1000);
}

/* ------------------------------------------------------------- inicialização */

/**
 * Logos: assets/marcas/cliente.(svg|png|webp) no cabeçalho e
 * assets/marcas/engemase.(...) no rodapé da coluna. O arquivo do cliente é de
 * cada instalação; o que não existir simplesmente não aparece (nada de ícone
 * de imagem quebrada). No demo, que é um arquivo só, vêm embutidos.
 */
function mostrarMarcas() {
  const embutidas = window.DEMO_RECURSOS?.MARCAS || null;
  document.querySelectorAll('img[data-marca]').forEach((img) => {
    const nome = img.dataset.marca;
    const fontes = embutidas
      ? [embutidas[nome]].filter(Boolean)
      : ['svg', 'png', 'webp'].map((x) => `assets/marcas/${nome}.${x}`);
    if (!fontes.length) return;
    let i = 0;
    img.onload = () => {
      img.hidden = false;
      const caixa = img.closest('[data-marca-caixa]');
      if (caixa) caixa.hidden = false;
    };
    img.onerror = () => { i += 1; if (i < fontes.length) img.src = fontes[i]; };
    img.src = fontes[0];
  });
}

async function iniciar() {
  raiz = $('#tela');
  mostrarMarcas();

  if (MODO_DEMO && window.DEMO_RECURSOS) {
    await iniciarDemo();
  } else {
    const eu = await api('/api/eu');
    estado.usuario = eu.usuario;
    estado.config = await api('/api/config');
    try { estado.dados = await api('/api/valores'); } catch { /* primeira varredura ainda não veio */ }
    conectar();
  }

  TELAS = telasDisponiveis();
  $('#planta').textContent = estado.config.planta;
  $('#usuario').textContent = estado.usuario
    ? `${estado.usuario.nome} · ${estado.usuario.papel}`
    : 'demonstração';
  $('#btn-sair').hidden = !estado.usuario;
  if (estado.config.simulado || MODO_DEMO) $('#faixa-sim').hidden = false;
  // na demonstração não há servidor: o simulador roda no próprio navegador
  if (MODO_DEMO) $('#faixa-sim').textContent = 'Demonstração — valores simulados no navegador, sem servidor e sem equipamentos';

  montarMenu();
  aoAtualizar(desenhar);

  $('#faixa-reconhecer').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = 'reconhecendo…';
    try {
      await telaAlarmes.reconhecer(null);
      // marca localmente para a faixa responder no mesmo instante, sem
      // depender de a próxima varredura chegar
      for (const a of estado.dados.alarmes) a.reconhecido = 1;
    } finally {
      b.disabled = false;
      desenhar();
    }
  });
  $('#faixa-silenciar').addEventListener('click', silenciar);
  $('#btn-sair').addEventListener('click', async () => {
    await api('/api/sair', { method: 'POST', headers: { 'X-Painel': '1' } }).catch(() => {});
    location.href = '/login';
  });
  $('#btn-som').addEventListener('click', () => {
    som.ligado = !som.ligado;
    som.proximoToque = 0;
    $('#btn-som').textContent = `Som: ${som.ligado ? 'ligado' : 'desligado'}`;
    desenhar();
  });

  // o navegador só libera áudio depois de um gesto do operador
  // o navegador só libera áudio depois de um gesto do operador
  const liberarSom = () => {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!som.ctx && Audio) som.ctx = new Audio();
    if (som.ctx?.state === 'suspended') som.ctx.resume().catch(() => {});
    document.removeEventListener('click', liberarSom);
    document.removeEventListener('keydown', liberarSom);
  };
  document.addEventListener('click', liberarSom);
  document.addEventListener('keydown', liberarSom);

  /**
   * Atalho de tela pelos números 1 a 9. Nunca quando o operador está digitando:
   * sem isso, teclar "1" num campo de endereço Modbus ou de senha troca a tela
   * e o que ele escreveu se perde.
   */
  const digitando = (alvo) => {
    if (!alvo || alvo === document.body) return false;
    if (alvo.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(alvo.tagName);
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (digitando(ev.target) || digitando(document.activeElement)) return;
    if (ev.key.length !== 1) return;
    const i = Number(ev.key);
    if (Number.isInteger(i) && i >= 1 && i <= TELAS.length) {
      ev.preventDefault();
      abrir(TELAS[i - 1].id);
    }
  });

  setInterval(() => {
    $('#relogio').textContent = dataHora(Date.now());
    // a sirene repete por conta própria: não depende de chegar pacote novo
    atualizarSirene((estado.dados.alarmes || []).filter((a) => !a.reconhecido));
  }, 1000);
  $('#relogio').textContent = dataHora(Date.now());

  const inicial = () => location.hash.slice(1) || TELAS[0]?.id;
  abrir(inicial());
  window.addEventListener('hashchange', () => abrir(inicial()));
}

function mostrarFalha(titulo, detalhe) {
  document.body.innerHTML = `<div style="padding:28px;font-family:system-ui;max-width:70ch">
    <h1 style="font-size:19px;margin:0 0 8px">${esc(titulo)}</h1>
    <pre style="white-space:pre-wrap;font-size:12px;color:#555">${esc(detalhe)}</pre>
    <p style="font-size:13px;color:#555">Recarregue a página. Se persistir, informe a mensagem acima.</p>
  </div>`;
}

window.addEventListener('error', (ev) => {
  if (!document.querySelector('#menu')?.children.length) {
    mostrarFalha('Falha ao iniciar o supervisório', ev.message || String(ev.error));
  }
});

iniciar().catch((e) => mostrarFalha('Não foi possível carregar o supervisório', e.stack || e.message));
