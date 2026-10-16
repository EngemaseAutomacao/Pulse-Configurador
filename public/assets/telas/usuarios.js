import { estado, esc, dataHora, api, $, placa } from '../nucleo.js';

const DESCRICAO_PAPEIS = {
  operador: 'vê as telas e reconhece alarme',
  tecnico: 'operador + engenharia e configuração',
  admin: 'técnico + usuários e auditoria',
};

export const telaUsuarios = {
  id: 'usuarios',
  isa: '',
  nome: 'Usuários',
  titulo: 'Usuários e auditoria',
  papel: 'admin',

  montar() {
    return `
      <section class="bloco">
        ${placa('', 'Contas de acesso')}
        <div class="corpo"><div id="u-lista"></div></div>
      </section>

      <section class="bloco">
        ${placa('', 'Nova conta')}
        <div class="corpo">
          <div class="controles">
            <label class="rotulo">login <input class="entrada" id="n-login" size="14" autocapitalize="none"></label>
            <label class="rotulo">nome <input class="entrada" id="n-nome" size="20"></label>
            <label class="rotulo">papel
              <select id="n-papel">${Object.keys(DESCRICAO_PAPEIS).map((p) => `<option value="${p}">${p}</option>`).join('')}</select></label>
            <label class="rotulo">senha inicial <input class="entrada" id="n-senha" type="text" size="18"></label>
            <button class="botao" id="n-criar">Criar</button>
          </div>
          <p class="rotulo" id="n-aviso"></p>
          <ul class="nota" style="padding-left:18px">
            ${Object.entries(DESCRICAO_PAPEIS).map(([p, d]) => `<li><b>${p}</b> — ${d}</li>`).join('')}
          </ul>
          <p class="nota">A senha inicial é provisória: o sistema exige a troca no primeiro acesso.</p>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Trilha de auditoria')}
        <div class="corpo"><div id="a-lista"></div></div>
      </section>`;
  },

  // a raiz é a mesma a cada troca de tela: sem remover os ouvintes, voltar à
  // tela faz um clique valer por dois (remover usuário, trocar papel)
  aoMontar(raiz) {
    this.destruir();
    this._raiz = raiz;
    $('#n-criar', raiz).addEventListener('click', () => this.criar(raiz));
    this._aoClicar = (ev) => {
      const b = ev.target.closest('button[data-acao]');
      if (b) this.acao(raiz, b);
    };
    this._aoMudar = (ev) => {
      const s = ev.target.closest('select[data-acao]');
      if (s) this.acao(raiz, s);
    };
    raiz.addEventListener('click', this._aoClicar);
    raiz.addEventListener('change', this._aoMudar);
    this.carregar(raiz);
  },

  destruir() {
    if (this._raiz) {
      if (this._aoClicar) this._raiz.removeEventListener('click', this._aoClicar);
      if (this._aoMudar) this._raiz.removeEventListener('change', this._aoMudar);
    }
    this._raiz = null;
    this._aoClicar = null;
    this._aoMudar = null;
  },

  async carregar(raiz) {
    try {
      const { usuarios } = await api('/api/usuarios');
      $('#u-lista', raiz).innerHTML = `<table>
        <thead><tr><th>Login</th><th>Nome</th><th>Papel</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead>
        <tbody>${usuarios.map((u) => `<tr>
          <td class="n">${esc(u.login)}</td>
          <td>${esc(u.nome)}</td>
          <td><select class="entrada" data-acao="papel" data-id="${u.id}">
            ${Object.keys(DESCRICAO_PAPEIS).map((p) => `<option ${p === u.papel ? 'selected' : ''}>${p}</option>`).join('')}
          </select></td>
          <td>${u.ativo ? '<span class="selo ok">ativo</span>' : '<span class="selo alta">desativado</span>'}
              ${u.trocar_senha ? '<span class="selo media">troca pendente</span>' : ''}</td>
          <td class="n">${u.ultimo_acesso ? dataHora(u.ultimo_acesso) : 'nunca'}</td>
          <td class="n">
            <button class="botao" data-acao="senha" data-id="${u.id}">Nova senha</button>
            <button class="botao" data-acao="ativo" data-id="${u.id}" data-valor="${u.ativo ? 0 : 1}">
              ${u.ativo ? 'Desativar' : 'Reativar'}</button>
          </td>
        </tr>`).join('')}</tbody></table>`;

      const { registros } = await api('/api/auditoria?limite=120');
      $('#a-lista', raiz).innerHTML = registros.length ? `<table>
        <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhe</th><th>Origem</th></tr></thead>
        <tbody>${registros.map((r) => `<tr class="${/negado|revertida/.test(r.acao) ? 'prioridade-alta' : ''}">
          <td class="n">${dataHora(r.ts)}</td>
          <td class="n">${esc(r.usuario || '—')}</td>
          <td>${esc(r.acao)}</td>
          <td>${esc(r.detalhe || '')}</td>
          <td class="n">${esc(r.origem || '—')}</td>
        </tr>`).join('')}</tbody></table>` : '<p class="vazio">Sem registros.</p>';
    } catch (e) {
      $('#u-lista', raiz).innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  },

  async criar(raiz) {
    const corpo = {
      login: $('#n-login', raiz).value.trim(),
      nome: $('#n-nome', raiz).value.trim(),
      papel: $('#n-papel', raiz).value,
      senha: $('#n-senha', raiz).value,
    };
    try {
      await api('/api/usuarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        body: JSON.stringify(corpo),
      });
      $('#n-aviso', raiz).textContent = `conta ${corpo.login} criada`;
      for (const id of ['#n-login', '#n-nome', '#n-senha']) $(id, raiz).value = '';
      this.carregar(raiz);
    } catch (e) {
      $('#n-aviso', raiz).textContent = e.message;
    }
  },

  async acao(raiz, el) {
    const { acao, id, valor } = el.dataset;
    const corpo = {};
    if (acao === 'papel') corpo.papel = el.value;
    if (acao === 'ativo') corpo.ativo = Number(valor) === 1;
    if (acao === 'senha') {
      const nova = prompt('Senha provisória (mínimo 10 caracteres, com letra e número):');
      if (!nova) return;
      corpo.senha = nova;
    }
    try {
      await api(`/api/usuarios/${Number(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        body: JSON.stringify(corpo),
      });
      this.carregar(raiz);
    } catch (e) {
      alert(e.message);
      this.carregar(raiz);
    }
  },
};

export const _usuarios = { estado, DESCRICAO_PAPEIS };
