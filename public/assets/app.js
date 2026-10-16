import {
  estado, $, esc, dataHora, api, conectar, aoAtualizar,
  coletarVinculos, aplicarVinculos, pode,
} from './nucleo.js';
import { telaInicio } from './telas/inicio.js';
import { telaEquipamentos, telaNuvem, telaComunicacao } from './telas/engenharia.js';
import { telaUsuarios } from './telas/usuarios.js';

/*
 * O Pulse Configurador é só a configuração do gateway. As leituras, gráficos,
 * alarmes (com notificação) e relatórios ficam no Engemase Pulse, na nuvem.
 */
const CATALOGO = [telaInicio, telaEquipamentos, telaNuvem, telaComunicacao, telaUsuarios];

let TELAS = [];

/** Quais telas entram no menu: as que o papel de quem entrou alcança. */
function telasDisponiveis() {
  return CATALOGO.filter((t) => !t.papel || pode(t.papel));
}

let telaAtual = null;
let raiz = null;
/* ------------------------------------------------------------- navegação */

/* Ícones do menu: os mesmos traços do Engemase Pulse (Lucide, licença ISC). */
const ICONE_SVG = (corpo) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corpo}</svg>`;
const ICONES = {
  inicio: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  equipamentos: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  nuvem: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  comunicacao: '<path d="M2 12h3"/><path d="M19 12h3"/><path d="M12 2v3"/><path d="M12 19v3"/><rect x="7" y="7" width="10" height="10" rx="2"/>',
  usuarios: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
/** Seções do menu, como no Pulse. A ordem segue o CATALOGO. */
const SECAO_DA_TELA = {
  inicio: 'Gateway',
  equipamentos: 'Configuração', nuvem: 'Configuração', comunicacao: 'Configuração',
  usuarios: 'Acesso',
};

function montarMenu() {
  const menu = $('#menu');
  let secao = null;
  menu.innerHTML = TELAS.map((t) => {
    const nova = SECAO_DA_TELA[t.id] || '';
    const titulo = nova && nova !== secao ? `<span class="secao-menu">${esc(nova)}</span>` : '';
    secao = nova;
    return `${titulo}
    <button class="item" data-tela="${t.id}" aria-current="${t.id === estado.tela ? 'page' : 'false'}">
      <span class="icone">${ICONES[t.id] ? ICONE_SVG(ICONES[t.id]) : ''}</span>
      <span class="rotulos">
        <span class="nome">${esc(t.nome)}</span>
        <span class="isa">${esc(t.isa || '')}</span>
      </span>
    </button>`;
  }).join('');
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

/* ------------------------------------------------------------- cabeçalho */

function atualizarCabecalho() {
  $('#led-conexao').className = `led ${estado.conectado ? 'ok' : 'critico'}`;
  $('#txt-conexao').textContent = estado.conectado ? 'gateway conectado' : 'servidor fora do ar';
}

function desenhar() {
  atualizarCabecalho();
  aplicarVinculos();
  if (!telaAtual || !raiz) return;
  if (telaAtual.aoReceberDados) telaAtual.aoReceberDados(raiz);
  else telaAtual.atualizar?.(raiz);
}

/* ------------------------------------------------------------- inicialização */

/**
 * Logos da Engemase (assets/marcas/<nome>.svg|png|webp): o símbolo no topo do
 * menu e a assinatura no rodapé. O que não existir simplesmente não aparece.
 */
function mostrarMarcas() {
  document.querySelectorAll('img[data-marca]').forEach((img) => {
    const nome = img.dataset.marca;
    const fontes = ['svg', 'png', 'webp'].map((x) => `assets/marcas/${nome}.${x}`);
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

  const eu = await api('/api/eu');
  estado.usuario = eu.usuario;
  estado.config = await api('/api/config');
  try { estado.dados = await api('/api/valores'); } catch { /* primeira varredura ainda não veio */ }
  conectar();

  TELAS = telasDisponiveis();
  $('#planta').textContent = estado.config.planta;
  $('#usuario').textContent = estado.usuario ? `${estado.usuario.nome} · ${estado.usuario.papel}` : '—';
  $('#btn-sair').hidden = !estado.usuario;
  if (estado.config.simulado) $('#faixa-sim').hidden = false;

  montarMenu();
  aoAtualizar(desenhar);

  $('#btn-sair').addEventListener('click', async () => {
    await api('/api/sair', { method: 'POST', headers: { 'X-Painel': '1' } }).catch(() => {});
    location.href = '/login';
  });

  // tema claro/escuro (assets/tema.js): automático → claro → escuro
  const NOME_TEMA = { automatico: 'automático', claro: 'claro', escuro: 'escuro' };
  const PROXIMO_TEMA = { automatico: 'claro', claro: 'escuro', escuro: 'automatico' };
  const rotularTema = () => {
    $('#btn-tema').textContent = `Tema: ${NOME_TEMA[window.PulseTema?.escolha() || 'automatico']}`;
  };
  rotularTema();
  $('#btn-tema').addEventListener('click', () => {
    window.PulseTema?.trocar(PROXIMO_TEMA[window.PulseTema.escolha()] || 'automatico');
    rotularTema();
  });

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

  setInterval(() => { $('#relogio').textContent = dataHora(Date.now()); }, 1000);
  $('#relogio').textContent = dataHora(Date.now());

  // operador não configura nada: o lugar dele é o Engemase Pulse
  if (!TELAS.length) {
    $('#titulo-tela').textContent = 'Engemase Pulse Configurador';
    raiz.innerHTML = `<section class="bloco"><div class="corpo"><p class="vazio-texto" style="margin:8px 0">
      Este é o configurador do gateway, para a equipe técnica. As leituras, os gráficos e os alarmes
      da unidade ficam no <b>Engemase Pulse</b>.</p></div></section>`;
    return;
  }

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
    mostrarFalha('Falha ao iniciar o configurador', ev.message || String(ev.error));
  }
});

iniciar().catch((e) => mostrarFalha('Não foi possível carregar o configurador', e.stack || e.message));
