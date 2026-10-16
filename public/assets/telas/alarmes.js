import {
  estado, esc, num, dataHora, duracao, api, MODO_DEMO, $,
} from '../nucleo.js';
import { placa } from './energia.js';

/** Estado de reconhecimento do modo demonstração (sem servidor). */
const reconhecidosDemo = new Set();

function tabela(linhas, { encerrados }) {
  if (!linhas.length) {
    return `<p class="vazio">${encerrados
      ? 'Nenhuma ocorrência registrada no período.'
      : 'Nenhum alarme ativo. Todas as grandezas dentro dos limites.'}</p>`;
  }
  return `<table>
    <thead><tr>
      <th>Início</th><th>Prioridade</th><th>Ocorrência</th><th>Valor</th><th>Limite</th>
      <th>${encerrados ? 'Fim' : 'Duração'}</th><th></th>
    </tr></thead>
    <tbody>${linhas.map((a) => `
      <tr class="prioridade-${esc(a.prioridade)}">
        <td class="n">${dataHora(a.inicio)}</td>
        <td><span class="selo ${esc(a.prioridade)}">${esc(a.prioridade)}</span></td>
        <td>${esc(a.mensagem)}</td>
        <td class="n">${num(a.valor, 1)}</td>
        <td class="n">${esc(a.limite || '—')}</td>
        <td class="n">${encerrados
    ? (a.fim ? dataHora(a.fim) : '<span class="selo alta">em curso</span>')
    : duracao(Date.now() - a.inicio)}</td>
        <td class="n">${encerrados ? ''
    : (a.reconhecido
      ? '<span class="selo ok">reconhecido</span>'
      : `<button class="botao" data-reconhecer="${a.id}">Reconhecer</button>`)}</td>
      </tr>`).join('')}</tbody></table>`;
}

export const telaAlarmes = {
  id: 'alarmes',
  isa: '',
  nome: 'Alarmes',
  titulo: 'Alarmes',
  _historico: [],

  montar() {
    return `
      <section class="bloco">
        ${placa('', 'Alarmes ativos')}
        <div class="corpo">
          <div class="controles">
            <button class="botao" id="rec-todos">Reconhecer todos</button>
            <span class="nota" style="margin:0">o reconhecimento fica registrado com data e hora</span>
          </div>
          <div id="lista-ativos"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Ocorrências recentes')}
        <div class="corpo"><div id="lista-historico"></div></div>
      </section>`;
  },

  aoMontar(raiz) {
    // o container é permanente: o ouvinte precisa ser removido ao sair da tela,
    // senão sobra um por visita e passa a responder nas outras telas
    this._clique = async (ev) => {
      const btn = ev.target.closest('[data-reconhecer]');
      if (btn) { await this.reconhecer(Number(btn.dataset.reconhecer)); this.atualizar(raiz); return; }
      if (ev.target.id === 'rec-todos') { await this.reconhecer(null); this.atualizar(raiz); }
    };
    raiz.addEventListener('click', this._clique);
    this._raiz = raiz;
    this.carregarHistorico().then(() => this.atualizar(raiz));
  },

  destruir() {
    if (this._clique && this._raiz) this._raiz.removeEventListener('click', this._clique);
    this._clique = null;
    this._raiz = null;
    this._proximo = 0;
  },

  async reconhecer(id) {
    if (MODO_DEMO) {
      const alvos = id === null ? estado.dados.alarmes : estado.dados.alarmes.filter((a) => a.id === id);
      for (const a of alvos) { reconhecidosDemo.add(a.tag); a.reconhecido = 1; }
      return;
    }
    try {
      await api('/api/alarmes/reconhecer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id === null ? {} : { id }),
      });
    } catch (e) {
      console.error('falha ao reconhecer', e);
    }
  },

  async carregarHistorico() {
    if (MODO_DEMO) { this._historico = estado.dados.alarmes; return; }
    try {
      const r = await api('/api/alarmes');
      this._historico = r.historico;
    } catch {
      this._historico = [];
    }
  },

  atualizar(raiz) {
    const ativos = estado.dados.alarmes.map((a) => (MODO_DEMO
      ? { ...a, reconhecido: reconhecidosDemo.has(a.tag) ? 1 : a.reconhecido }
      : a));
    const alvo = $('#lista-ativos', raiz);
    if (alvo) alvo.innerHTML = tabela(ativos, { encerrados: false });
    const hist = $('#lista-historico', raiz);
    if (hist) hist.innerHTML = tabela(MODO_DEMO ? ativos : this._historico, { encerrados: true });
  },

  aoReceberDados(raiz) {
    // recarrega o histórico só de vez em quando; os ativos vêm no próprio pacote
    if (!this._proximo || Date.now() > this._proximo) {
      this._proximo = Date.now() + 15000;
      this.carregarHistorico().then(() => this.atualizar(raiz));
    } else {
      this.atualizar(raiz);
    }
  },
};

export const _alarmesInterno = { reconhecidosDemo, tabela };
