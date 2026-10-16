import { estado, esc, dataHora, api, $, placa } from '../nucleo.js';

/*
 * Início: a situação do gateway, para o técnico conferir de relance — se cada
 * equipamento responde, se o envio para o Engemase Pulse está em dia e se há
 * alarme ativo. Os valores medidos não aparecem aqui: ficam no Engemase Pulse.
 */

const NOME_GRUPO = { energia: 'Energia', agua: 'Água', gerador: 'Gerador', subestacao: 'Subestação' };
const NOME_PRIORIDADE = { alta: 'crítico', media: 'atenção', baixa: 'informativo' };

export const telaInicio = {
  id: 'inicio',
  isa: '',
  nome: 'Início',
  titulo: 'Situação do gateway',
  papel: 'tecnico',
  _timer: null,

  montar() {
    return `
      <section class="bloco">
        ${placa('', 'Resumo')}
        <div class="corpo">
          <div class="indicadores" id="i-resumo"></div>
          <p class="nota" style="margin:12px 0 0">As leituras, os gráficos e os alarmes da unidade ficam no
            <b>Engemase Pulse</b>. Aqui é só a configuração do gateway.</p>
        </div>
      </section>

      <div class="grade dupla">
        <section class="bloco">
          ${placa('', 'Equipamentos')}
          <div class="corpo">
            <div id="i-equipamentos"></div>
            <div class="controles" style="margin:12px 0 0">
              <a class="botao" href="#equipamentos">Editar equipamentos</a>
              <a class="botao" href="#comunicacao">Diagnóstico da comunicação</a>
            </div>
          </div>
        </section>

        <section class="bloco">
          ${placa('', 'Ligação com o Engemase Pulse')}
          <div class="corpo">
            <div class="nuvem-estado" id="i-nuvem">carregando…</div>
            <a class="botao" href="#nuvem">Configurar a ligação</a>
            <h3 class="titulo-secao" style="margin-top:20px">Alarmes ativos no gateway</h3>
            <div id="i-alarmes"></div>
          </div>
        </section>
      </div>`;
  },

  aoMontar(raiz) {
    this.nuvem(raiz);
    this._timer = setInterval(() => this.nuvem(raiz), 10000);
  },

  async nuvem(raiz) {
    const caixa = $('#i-nuvem', raiz);
    if (!caixa) return;
    try {
      const r = await api('/api/eng/nuvem');
      this._nuvem = r;
      if (!r.ativa) caixa.innerHTML = '<span class="selo baixa">não ligado</span> Este gateway ainda não envia para o Pulse.';
      else if (r.erro) caixa.innerHTML = `<span class="selo alta">sem envio</span> ${esc(r.erro)}`;
      else if (r.ultimo_sucesso) caixa.innerHTML = `<span class="selo ok">enviando</span> último envio ${esc(dataHora(r.ultimo_sucesso))}`;
      else caixa.innerHTML = '<span class="selo media">aguardando</span> esperando o primeiro envio';
    } catch (e) {
      caixa.innerHTML = `<span class="selo alta">indisponível</span> ${esc(e.message)}`;
    }
    this.resumo(raiz);
  },

  aoReceberDados(raiz) {
    this.resumo(raiz);
    this.equipamentos(raiz);
    this.alarmes(raiz);
  },

  resumo(raiz) {
    const caixa = $('#i-resumo', raiz);
    if (!caixa) return;
    const eqs = estado.config.equipamentos || [];
    const vivos = eqs.filter((e) => estado.dados.equipamentos?.[e.id]?.online).length;
    const alarmes = estado.dados.alarmes || [];
    const n = this._nuvem;
    const nuvem = !n ? '—' : !n.ativa ? 'não ligado' : n.erro ? 'sem envio' : n.ultimo_sucesso ? 'enviando' : 'aguardando';
    const ficha = (rotulo, valor, apoio, classe = '') => `
      <div class="indicador ${classe}">
        <span class="rotulo">${esc(rotulo)}</span>
        <div class="n">${valor}</div>
        <div class="apoio">${esc(apoio)}</div>
      </div>`;
    caixa.innerHTML = [
      ficha('Equipamentos respondendo', `${vivos}<span class="un">de ${eqs.length}</span>`,
        vivos === eqs.length ? 'todos em serviço' : `${eqs.length - vivos} sem comunicação`,
        vivos < eqs.length ? 'critico' : ''),
      ficha('Envio para o Pulse', esc(nuvem), n?.ultimo_sucesso ? `último ${dataHora(n.ultimo_sucesso)}` : '',
        n && n.ativa && n.erro ? 'critico' : n && !n.ativa ? 'atencao' : ''),
      ficha('Alarmes ativos', String(alarmes.length), alarmes.length ? 'acompanhe no Engemase Pulse' : 'nenhum',
        alarmes.some((a) => a.prioridade === 'alta') ? 'critico' : alarmes.length ? 'atencao' : ''),
      ficha('Instalação', esc(estado.config.planta || '—'), estado.config.simulado ? 'modo simulado' : ''),
    ].join('');
  },

  equipamentos(raiz) {
    const caixa = $('#i-equipamentos', raiz);
    if (!caixa) return;
    const eqs = estado.config.equipamentos || [];
    if (!eqs.length) {
      caixa.innerHTML = '<p class="vazio">Nenhum equipamento cadastrado. Comece em <a href="#equipamentos">Equipamentos</a>.</p>';
      return;
    }
    caixa.innerHTML = `<table><thead><tr><th>Equipamento</th><th>Endereço</th><th>Grupo</th><th>Comunicação</th></tr></thead>
      <tbody>${eqs.map((e) => {
        const vivo = estado.dados.equipamentos?.[e.id]?.online;
        return `<tr>
          <td>${esc(e.nome)}${e.tag_isa ? ` <span class="isa-tabela">${esc(e.tag_isa)}</span>` : ''}</td>
          <td class="n">${esc(e.unit_id ?? '—')}</td>
          <td>${esc(NOME_GRUPO[e.grupo] || e.grupo || '—')}</td>
          <td>${vivo ? '<span class="selo ok">em serviço</span>' : '<span class="selo alta">sem comunicação</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  },

  alarmes(raiz) {
    const caixa = $('#i-alarmes', raiz);
    if (!caixa) return;
    const alarmes = [...(estado.dados.alarmes || [])].sort((a, b) => a.inicio - b.inicio);
    if (!alarmes.length) {
      caixa.innerHTML = '<p class="nota" style="margin:0">Nenhum alarme ativo.</p>';
      return;
    }
    caixa.innerHTML = `<table><tbody>${alarmes.slice(0, 8).map((a) => `
      <tr class="prioridade-${esc(a.prioridade)}">
        <td>${esc(a.mensagem)}</td>
        <td><span class="selo ${esc(a.prioridade)}">${esc(NOME_PRIORIDADE[a.prioridade] || a.prioridade)}</span></td>
        <td class="n">${esc(dataHora(a.inicio))}</td>
      </tr>`).join('')}</tbody></table>
      ${alarmes.length > 8 ? `<p class="nota" style="margin:8px 0 0">e mais ${alarmes.length - 8}.</p>` : ''}
      <p class="nota" style="margin:10px 0 0">Para reconhecer e ver o histórico, use o Engemase Pulse.</p>`;
  },

  destruir() {
    clearInterval(this._timer);
    this._timer = null;
  },
};
