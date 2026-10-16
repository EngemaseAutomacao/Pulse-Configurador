import { esc, api, MODO_DEMO, estado, $, $$ } from '../nucleo.js';
import { placa } from './energia.js';

/**
 * Bloco de acionamento.
 *
 * Um botão que abre ou fecha disjuntor não pode ser um clique só. O padrão aqui
 * é o mesmo de um comando de painel:
 *   - o botão fica desabilitado enquanto houver intertravamento, e a razão
 *     aparece escrita ao lado — o operador não fica adivinhando;
 *   - acionar exige dois toques, e o segundo tem prazo: passou, volta ao normal;
 *   - o servidor revalida tudo antes de escrever, então uma tela desatualizada
 *     não consegue mandar o que o processo não permite;
 *   - o resultado é conferido pela realimentação do equipamento.
 */

const PRAZO_CONFIRMACAO = 8000;

/**
 * Tempo mínimo entre armar e confirmar. A confirmação tem que ser um SEGUNDO
 * gesto humano: sem esta folga, um duplo clique, uma tecla presa, um toque que
 * repica na tela ou um ouvinte ligado duas vezes viram comando de disjuntor
 * saindo no primeiro clique. Ninguém confirma de propósito em 400 ms.
 */
const ESPERA_MINIMA = 400;

export const blocoComandos = (idEquipamento = null) => `
  <section class="bloco" data-comandos="${idEquipamento || 'todos'}">
    ${placa('', 'Acionamento')}
    <div class="corpo">
      <div id="cmd-lista"><p class="nota">carregando…</p></div>
      <div id="cmd-resultado"></div>
    </div>
  </section>`;

export const comandos = {
  _armado: null,       // { medidor, nome, desde, ate }
  _relogio: null,
  _raiz: null,
  _aoClicar: null,
  _aoTeclar: null,
  _lista: [],

  /** Há comando declarado para este equipamento? */
  async existem(idEquipamento) {
    if (MODO_DEMO) return false;
    try {
      const r = await api('/api/comandos');
      return r.liberados && r.comandos.some((c) => c.medidor === idEquipamento);
    } catch {
      return false;
    }
  },

  /**
   * A tela é remontada no mesmo elemento a cada troca de tela, então os
   * ouvintes PRECISAM ser guardados e removidos: dois ouvintes no mesmo lugar
   * fazem um clique chamar clicar() duas vezes — a primeira arma, a segunda
   * executa, e o disjuntor abre sem ninguém ter confirmado.
   */
  aoMontar(raiz, idEquipamento = null) {
    this.destruir();                       // nunca dois ouvintes no mesmo lugar
    this._raiz = raiz;
    this._id = idEquipamento;
    this._usuario = estado.usuario?.login || null;

    // o botão leva equipamento E comando: perfis repetem nomes ("ligar",
    // "desligar"), e só o nome faria o botão de um disjuntor acionar outro
    this._aoClicar = (ev) => {
      const b = ev.target.closest('[data-cmd]');
      if (b) this.clicar(raiz, b.dataset.medidor, b.dataset.cmd);
      if (ev.target.closest('[data-cmd-cancelar]')) this.desarmar(raiz);
    };
    // Enter no campo de senha confirma, como em qualquer formulário
    this._aoTeclar = (ev) => {
      const campo = ev.target.closest('[data-cmd-senha]');
      if (campo && ev.key === 'Enter') {
        ev.preventDefault();
        this.clicar(raiz, campo.dataset.medidor, campo.dataset.cmdSenha);
      }
    };
    raiz.addEventListener('click', this._aoClicar);
    raiz.addEventListener('keydown', this._aoTeclar);

    this.carregar(raiz);
    this._relogio = setInterval(() => this.carregar(raiz), 2000);
  },

  destruir() {
    clearInterval(this._relogio);
    this._relogio = null;
    if (this._raiz) {
      if (this._aoClicar) this._raiz.removeEventListener('click', this._aoClicar);
      if (this._aoTeclar) this._raiz.removeEventListener('keydown', this._aoTeclar);
    }
    this._raiz = null;
    this._aoClicar = null;
    this._aoTeclar = null;
    this._armado = null;
  },

  async carregar(raiz) {
    const alvo = $('#cmd-lista', raiz);
    if (!alvo || !alvo.isConnected) return;
    try {
      const r = await api('/api/comandos');
      // sem equipamento indicado, a tela mostra todos os acionamentos da planta
      this._lista = this._id ? r.comandos.filter((c) => c.medidor === this._id) : r.comandos;
      this._emCurso = r.em_curso || null;
      this.desenhar(raiz);
    } catch (e) {
      alvo.innerHTML = `<p class="nota">${esc(e.message)}</p>`;
    }
  },

  desenhar(raiz) {
    const alvo = $('#cmd-lista', raiz);
    if (!alvo) return;
    // o bloco se redesenha a cada 2 s: sem isso, a senha em digitação sumiria
    const campoAntes = $('[data-cmd-senha]', raiz);
    const senhaEmDigitacao = campoAntes?.value || '';
    const tinhaFoco = document.activeElement === campoAntes;
    if (!this._lista.length) {
      alvo.innerHTML = '<p class="nota">Nenhum acionamento liberado nesta instalação.</p>';
      return;
    }
    const agora = Date.now();
    // o servidor aceita um acionamento por vez; avisar antes evita a recusa
    const emCurso = this._emCurso
      ? `<p class="nota">Em andamento: ${esc(this._emCurso.rotulo)} (${esc(this._emCurso.equipamento)}),
         por ${esc(this._emCurso.quem)}. Novos acionamentos aguardam a confirmação.</p>`
      : '';
    alvo.innerHTML = `${emCurso}<div class="comandos">${this._lista.map((c) => {
      const armado = this._armado?.medidor === c.medidor && this._armado?.nome === c.nome
        && this._armado.ate > agora;
      const restante = armado ? Math.ceil((this._armado.ate - agora) / 1000) : 0;
      const bloqueado = !c.disponivel;
      return `
        <div class="comando ${c.perigoso ? 'perigoso' : ''} ${armado ? 'armado' : ''}">
          <div class="comando-linha">
            <button class="botao acionar" data-medidor="${esc(c.medidor)}" data-cmd="${esc(c.nome)}" ${bloqueado ? 'disabled' : ''}>
              ${armado ? `Confirmar em ${restante} s` : esc(c.rotulo)}
            </button>
            ${armado ? '<button class="botao" data-cmd-cancelar="1">Cancelar</button>' : ''}
            <div class="comando-estado">
              ${this._id ? '' : `<span class="rotulo" style="margin-bottom:3px">${esc(c.equipamento)}</span>`}
              ${c.impedimentos.length
    ? `<span class="motivo">${c.impedimentos.map(esc).join(' · ')}</span>`
    : !c.autorizado
      ? `<span class="motivo">exige perfil ${esc(c.papel)}</span>`
      : armado
        ? `<span class="motivo aviso">${c.exige_senha
          ? 'digite sua senha e toque de novo' : 'toque de novo para executar'}</span>`
        : `<span class="nota" style="margin:0">${esc(c.descricao || 'pronto para acionar')}</span>`}
              ${c.causa ? `<span class="rotulo" style="margin:4px 0 0">último disparo: ${esc(c.causa)}</span>` : ''}
            </div>
          </div>
          ${armado && c.exige_senha ? `
            <div class="comando-senha">
              <label class="rotulo" for="cmd-senha">Confirme com sua senha</label>
              <input class="entrada" type="password" id="cmd-senha" autocomplete="current-password"
                     data-medidor="${esc(c.medidor)}" data-cmd-senha="${esc(c.nome)}" placeholder="senha de ${esc(this._usuario || 'usuário')}">
            </div>` : ''}
        </div>`;
    }).join('')}</div>`;

    const campo = $('[data-cmd-senha]', raiz);
    if (campo) {
      campo.value = senhaEmDigitacao;
      if (tinhaFoco || !senhaEmDigitacao) campo.focus();
    }
  },

  clicar(raiz, medidor, nome) {
    const c = this._lista.find((x) => x.medidor === medidor && x.nome === nome);
    if (!c || !c.disponivel) return;
    const agora = Date.now();
    const armado = this._armado?.medidor === medidor && this._armado?.nome === nome
      && this._armado.ate > agora;
    if (!armado) {
      // primeiro toque: arma e espera a confirmação
      this._armado = {
        medidor: c.medidor, nome, desde: agora, ate: agora + PRAZO_CONFIRMACAO,
      };
      this.desenhar(raiz);
      return;
    }
    // confirmação cedo demais não é confirmação: é o mesmo toque chegando duas
    // vezes. Continua armado, esperando o gesto de verdade.
    if (agora - this._armado.desde < ESPERA_MINIMA) return;
    const campo = $('[data-cmd-senha]', raiz);
    const senha = campo?.value || '';
    if (c.exige_senha && !senha) {
      campo?.focus();
      return;
    }
    this._armado = null;
    this.executar(raiz, c, senha);
  },

  desarmar(raiz) {
    this._armado = null;
    this.desenhar(raiz);
  },

  async executar(raiz, c, senha = '') {
    const saida = $('#cmd-resultado', raiz);
    saida.innerHTML = `<div class="resultado"><b>${esc(c.rotulo)}</b> — enviando ao equipamento…</div>`;
    try {
      const r = await api('/api/comandos/executar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        // a senha vai só nesta requisição e não fica guardada em lugar nenhum
        body: JSON.stringify({ medidor: c.medidor, comando: c.nome, confirmado: true, senha }),
      });
      saida.innerHTML = `<div class="resultado ${r.confirmado === false ? 'atencao' : 'ok'}">
        <b>${esc(c.rotulo)}</b> — ${esc(r.mensagem)}</div>`;
    } catch (e) {
      saida.innerHTML = `<div class="resultado ruim"><b>Comando recusado.</b> ${esc(e.message)}</div>`;
    }
    this.carregar(raiz);
  },
};

export const _comandosInterno = { PRAZO_CONFIRMACAO, ESPERA_MINIMA, $$ };
