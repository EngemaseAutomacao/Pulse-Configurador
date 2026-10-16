import { estado, esc, num, dataHora, api, MODO_DEMO, $, $$ } from '../nucleo.js';
import { placa } from './energia.js';

const COLUNAS = ['int16', 'uint16', 'float_ABCD', 'float_CDAB', 'float_DCBA', 'uint32'];
const TITULOS = {
  int16: 'int16', uint16: 'uint16', float_ABCD: 'float ABCD',
  float_CDAB: 'float CDAB', float_DCBA: 'float DCBA', uint32: 'uint32',
};

export const telaEngenharia = {
  id: 'engenharia',
  isa: '',
  nome: 'Engenharia',
  titulo: 'Engenharia',
  papel: 'tecnico',
  _timer: null,
  _raiz: null,
  _aoClicar: null,
  _aoMudar: null,

  montar() {
    const eqs = estado.config.equipamentos;
    return `
      <section class="bloco">
        ${placa('', 'Varredura do barramento')}
        <div class="corpo">
          <p class="nota">Percorre os endereços procurando quem responde, na RS-485 ou
            na rede. A varredura suspende a leitura normal enquanto roda.</p>
          <div class="controles">
            <label class="rotulo">meio
              <select id="v-tipo">
                <option value="rtu">RS-485</option>
                <option value="tcp">Ethernet</option>
              </select></label>
            <span data-meio="rtu">
              <label class="rotulo">porta
                <input class="entrada" id="v-porta" value="/dev/ttyUSB0" size="14"></label>
              <label class="rotulo">baud
                <select id="v-baud">${[9600, 19200, 38400, 4800].map((b) => `<option>${b}</option>`).join('')}</select></label>
              <label class="rotulo">paridade
                <select id="v-paridade"><option value="none">nenhuma</option><option value="even">par</option><option value="odd">ímpar</option></select></label>
            </span>
            <span data-meio="tcp" hidden>
              <label class="rotulo">máquina
                <input class="entrada" id="v-host" placeholder="192.168.10.20" size="15"></label>
              <label class="rotulo">porta TCP
                <input class="entrada curta" id="v-porta-tcp" type="number" value="502" min="1" max="65535"></label>
            </span>
            <label class="rotulo">de <input class="entrada" id="v-de" type="number" value="1" min="1" max="247" size="3"></label>
            <label class="rotulo">até <input class="entrada" id="v-ate" type="number" value="16" min="1" max="247" size="3"></label>
            <button class="botao" id="v-rodar">Procurar escravos</button>
          </div>
          <p class="nota" data-meio="tcp" hidden style="margin:0 0 10px">
            Em Ethernet, o endereço de escravo costuma ser <b>1</b> (equipamento nativo) ou o
            número do escravo atrás de um gateway serial. Procurar de 1 a 16 resolve os dois casos.</p>
          <div id="v-saida"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Terminal Modbus')}
        <div class="corpo">
          <p class="nota">Lê registradores e mostra o mesmo conteúdo
            interpretado de todas as formas. A coluna que bater com o mostrador do equipamento
            é a que vai no <code>tipo</code> e na <code>ordem_palavras</code>.</p>
          <div class="controles">
            <label class="rotulo">escravo
              <select id="t-id">${eqs.map((e) => `<option value="${e.unit_id ?? ''}">${esc(e.nome)}</option>`).join('')}
                <option value="livre">outro…</option></select></label>
            <input class="entrada" id="t-id-livre" type="number" min="1" max="247" value="1" size="3" hidden>
            <label class="rotulo">função
              <select id="t-funcao">
                <option value="holding">03 holding</option>
                <option value="input">04 input</option>
                <option value="coil">01 coil</option>
                <option value="discreta">02 discreta</option>
              </select></label>
            <label class="rotulo">endereço <input class="entrada" id="t-end" type="number" value="0" min="0" size="5"></label>
            <label class="rotulo">quantidade <input class="entrada" id="t-qtd" type="number" value="8" min="1" max="125" size="3"></label>
            <button class="botao" id="t-ler">Ler</button>
            <label class="rotulo"><input type="checkbox" id="t-auto"> repetir a cada 2 s</label>
          </div>
          <div id="t-saida"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Diagnóstico da comunicação')}
        <div class="corpo">
          <div class="controles">
            <button class="botao" id="d-zerar">Zerar contadores</button>
            <span class="rotulo" id="d-resumo" style="margin:0"></span>
          </div>
          <div id="d-saida"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Equipamentos')}
        <div class="corpo">
          <p class="nota">Quantidade de medidores, endereços e limites.
            Alterar aqui reescreve a configuração da instalação e recarrega a leitura sem derrubar o serviço.</p>
          <div id="eq-tabela"></div>
          <div class="controles" style="margin-top:12px">
            <button class="botao" id="eq-add">Adicionar equipamento</button>
            <button class="botao" id="eq-validar">Conferir</button>
            <button class="botao destaque" id="eq-aplicar">Aplicar configuração</button>
            <button class="botao" id="eq-desfazer">Descartar alterações</button>
          </div>
          <div id="eq-aviso"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Seções da instalação')}
        <div class="corpo">
          <p class="nota">Os números que variam de loja para loja: tanque, consumo,
            reservatório e limites de bateria. O resto — estados, modos e lista de falhas —
            vem do perfil do equipamento. Aplicam junto com os equipamentos, no botão acima.</p>
          <div id="sec-formulario"></div>
        </div>
      </section>

      <section class="bloco">
        ${placa('', 'Perfis de equipamento')}
        <div class="corpo">
          <p class="nota">O mapa de registradores de cada modelo mora aqui.
            O arquivo da loja só aponta o perfil, o endereço e o nome do circuito.</p>
          <div id="p-saida"></div>
        </div>
      </section>`;
  },

  aoMontar(raiz) {
    const sel = $('#t-id', raiz);
    const livre = $('#t-id-livre', raiz);
    sel.addEventListener('change', () => { livre.hidden = sel.value !== 'livre'; });

    const tipoVarredura = $('#v-tipo', raiz);
    tipoVarredura.addEventListener('change', () => {
      for (const el of $$('[data-meio]', raiz)) el.hidden = el.dataset.meio !== tipoVarredura.value;
    });
    $('#v-rodar', raiz).addEventListener('click', () => this.varrer(raiz));
    $('#t-ler', raiz).addEventListener('click', () => this.ler(raiz));
    $('#t-auto', raiz).addEventListener('change', (ev) => {
      clearInterval(this._timer);
      if (ev.target.checked) this._timer = setInterval(() => this.ler(raiz), 2000);
    });
    $('#d-zerar', raiz).addEventListener('click', async () => {
      await api('/api/eng/diagnostico/zerar', { method: 'POST', headers: { 'X-Painel': '1' } }).catch(() => {});
      this.diagnostico(raiz);
    });

    // a raiz é a mesma a cada troca de tela: guarda os ouvintes para poder
    // removê-los, senão cada visita duplica o efeito de um clique
    this._raiz = raiz;
    this._aoClicar = (ev) => {
      const b = ev.target.closest('[data-eq-acao]');
      if (b) this.acaoEquipamento(raiz, b.dataset.eqAcao, Number(b.dataset.linha));
      const s = ev.target.closest('[data-secao-acao]');
      if (s) this.acaoSecao(raiz, s.dataset.secaoAcao, s.dataset.secao, Number(s.dataset.marca));
    };
    this._aoMudar = (ev) => {
      const c = ev.target.closest('[data-campo]');
      if (c) this.alterarCampo(raiz, c);
      const sec = ev.target.closest('[data-secao-campo], [data-marca-campo]');
      if (sec) this.alterarSecao(raiz, sec);
    };
    raiz.addEventListener('click', this._aoClicar);
    raiz.addEventListener('change', this._aoMudar);
    $('#eq-add', raiz).addEventListener('click', () => this.acaoEquipamento(raiz, 'adicionar'));
    $('#eq-validar', raiz).addEventListener('click', () => this.salvarEquipamentos(raiz, true));
    $('#eq-aplicar', raiz).addEventListener('click', () => this.salvarEquipamentos(raiz, false));
    $('#eq-desfazer', raiz).addEventListener('click', () => this.carregarEquipamentos(raiz));

    this.diagnostico(raiz);
    this.perfis(raiz);
    this.carregarEquipamentos(raiz);
    this._diag = setInterval(() => this.diagnostico(raiz), 5000);
  },

  /* ------------------------------------------------------------ equipamentos */

  async carregarEquipamentos(raiz) {
    try {
      const [eq, pf] = await Promise.all([api('/api/eng/equipamentos'), api('/api/eng/perfis')]);
      this._perfis = pf.perfis;
      this._porta = eq.porta_padrao;
      // cópia de trabalho: nada vai para o servidor antes de Aplicar
      this._eqs = eq.equipamentos.map((e) => ({
        ...e,
        id_anterior: e.id,
        grupo: pf.perfis.find((p) => p.nome === e.perfil)?.grupo || 'energia',
      }));
      this._secoes = {
        gerador: eq.secoes?.gerador ? { ...eq.secoes.gerador } : null,
        caixa_agua: eq.secoes?.caixa_agua ? { ...eq.secoes.caixa_agua } : null,
      };
      this._sujo = false;
      this.desenharEquipamentos(raiz);
      this.desenharSecoes(raiz);
    } catch (e) {
      $('#eq-tabela', raiz).innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  },

  desenharEquipamentos(raiz) {
    const alvo = $('#eq-tabela', raiz);
    if (!alvo) return;
    const perfis = this._perfis || [];
    if (!this._eqs?.length) {
      alvo.innerHTML = '<p class="vazio">Nenhum equipamento cadastrado. Use “Adicionar equipamento”.</p>';
      return;
    }

    alvo.innerHTML = `<table class="editor">
      <thead><tr>
        <th>Perfil</th><th>Nome</th><th>Tag</th><th>Endereço</th><th>Meio</th><th>Onde</th>
        <th>Entrada geral</th><th>Disjuntor (A)</th><th>Rodízio</th><th></th>
      </tr></thead>
      <tbody>${this._eqs.map((e, i) => {
    const energia = e.grupo === 'energia';
    // o que o equipamento não declara vem do perfil (ex.: DSE = RS-232, 19200)
    const doPerfil = perfis.find((p) => p.nome === e.perfil)?.conexao || {};
    const meio = e.conexao?.tipo === 'tcp' ? 'tcp'
      : (e.conexao?.interface ?? doPerfil.interface) === 'rs232' ? 'rs232' : 'rs485';
    const baud = e.conexao?.baud ?? doPerfil.baud ?? 9600;
    return `<tr>
          <td>${e.perfil ? `<select class="entrada" data-campo="perfil" data-linha="${i}">
              ${perfis.map((p) => `<option value="${esc(p.nome)}" ${p.nome === e.perfil ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}
            </select>` : '<span class="rotulo" style="margin:0">mapa próprio</span>'}</td>
          <td><input class="entrada larga" data-campo="nome" data-linha="${i}" value="${esc(e.nome || '')}"></td>
          <td><input class="entrada curta" data-campo="tag_isa" data-linha="${i}" value="${esc(e.tag_isa || '')}"></td>
          <td><input class="entrada curta" type="number" min="1" max="247" data-campo="unit_id" data-linha="${i}"
                     value="${e.conexao?.unit_id ?? ''}"></td>
          <td><select class="entrada" data-campo="tipo" data-linha="${i}">
            <option value="rs485" ${meio === 'rs485' ? 'selected' : ''}>RS-485</option>
            <option value="rs232" ${meio === 'rs232' ? 'selected' : ''}>RS-232</option>
            <option value="tcp" ${meio === 'tcp' ? 'selected' : ''}>Ethernet</option>
          </select></td>
          <td>${e.conexao?.tipo === 'tcp'
    ? `<input class="entrada" size="13" data-campo="host" data-linha="${i}" placeholder="192.168.10.20"
              value="${esc(e.conexao?.host || '')}">
       <input class="entrada curta" type="number" min="1" max="65535" data-campo="porta" data-linha="${i}"
              value="${e.conexao?.porta ?? 502}" title="porta TCP (502 é a padrão do Modbus)">`
    : `<input class="entrada" size="8" data-campo="porta_serial" data-linha="${i}" placeholder="COM3"
              value="${esc(e.conexao?.porta_serial || this._porta || '')}">
       <select class="entrada" data-campo="baud" data-linha="${i}" title="velocidade (igual à do equipamento)">
         ${[4800, 9600, 19200, 38400, 57600, 115200].map((b) => `<option ${b === baud ? 'selected' : ''}>${b}</option>`).join('')}
       </select>`}</td>
          <td style="text-align:center">${energia
    ? `<input type="radio" name="principal" data-campo="principal" data-linha="${i}" ${e.principal ? 'checked' : ''}>`
    : '<span class="rotulo" style="margin:0">—</span>'}</td>
          <td>${energia
    ? `<input class="entrada curta" type="number" min="1" data-campo="disjuntor" data-linha="${i}"
              value="${e.limites?.corrente_a?.max ?? ''}">`
    : '<span class="rotulo" style="margin:0">—</span>'}</td>
          <td><input class="entrada curta" type="number" min="1" max="20" data-campo="varredura_a_cada" data-linha="${i}"
                     value="${e.varredura_a_cada ?? ''}" title="lê a cada N varreduras"></td>
          <td class="n"><button class="botao" data-eq-acao="remover" data-linha="${i}">Remover</button></td>
        </tr>`;
  }).join('')}</tbody></table>
      <p class="nota" style="margin:10px 0 0">${this._eqs.length} equipamento(s) ·
        ${this._sujo ? '<b style="color:#8a5c00">alterações ainda não aplicadas</b>' : 'em dia com o servidor'}</p>`;
  },

  alterarCampo(raiz, el) {
    const i = Number(el.dataset.linha);
    const e = this._eqs?.[i];
    if (!e) return;
    const campo = el.dataset.campo;
    const v = el.value;

    if (campo === 'principal') {
      for (const x of this._eqs) x.principal = false;
      e.principal = el.checked;
    } else if (campo === 'unit_id') {
      e.conexao = { ...e.conexao, unit_id: Number(v) };
    } else if (campo === 'porta_serial') {
      e.conexao = { ...e.conexao, porta_serial: v };
    } else if (campo === 'host') {
      e.conexao = { ...e.conexao, host: v.trim() };
    } else if (campo === 'porta') {
      e.conexao = { ...e.conexao, porta: Number(v) || 502 };
    } else if (campo === 'baud') {
      e.conexao = { ...e.conexao, baud: Number(v) };
    } else if (campo === 'tipo') {
      // trocar de meio não carrega os campos do outro: serial e Ethernet têm
      // endereçamentos diferentes e misturá-los só gera configuração ambígua
      const { unit_id, timeout_ms, baud } = e.conexao || {};
      const perfil = this._perfis?.find((p) => p.nome === e.perfil);
      e.conexao = v === 'tcp'
        ? { tipo: 'tcp', host: e.conexao?.host || '', porta: e.conexao?.porta || 502, unit_id, timeout_ms }
        : {
          tipo: 'rtu',
          interface: v,
          porta_serial: e.conexao?.porta_serial || this._porta || '',
          // equipamento com endereço fixo em RS-232 (DSE: 10) já sai certo
          unit_id: v === 'rs232' && perfil?.endereco_rs232 ? perfil.endereco_rs232 : unit_id,
          timeout_ms,
          baud,
        };
    } else if (campo === 'disjuntor') {
      e.limites = v ? { ...e.limites, corrente_a: { max: Number(v) } } : {};
    } else if (campo === 'varredura_a_cada') {
      e.varredura_a_cada = v ? Number(v) : null;
    } else if (campo === 'perfil') {
      e.perfil = v;
      e.grupo = this._perfis.find((p) => p.nome === v)?.grupo || 'energia';
      if (e.grupo !== 'energia') e.principal = false;
    } else if (campo === 'nome') {
      e.nome = v;
      // o id acompanha o nome enquanto o equipamento é novo
      if (e.novo) e.id = this.idDoNome(v, i);
    } else {
      e[campo] = v;
    }
    this._sujo = true;
    this.desenharEquipamentos(raiz);
    this.desenharSecoes(raiz);
  },

  idDoNome(nome, i) {
    const base = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `eq${i + 1}`;
    let id = base;
    let n = 2;
    while (this._eqs.some((x, j) => j !== i && x.id === id)) { id = `${base}${n}`; n += 1; }
    return id;
  },

  acaoEquipamento(raiz, acao, linha) {
    if (acao === 'remover') {
      const e = this._eqs[linha];
      if (!confirm(`Remover ${e.nome || e.id}? O histórico já gravado é mantido.`)) return;
      this._eqs.splice(linha, 1);
    }
    if (acao === 'adicionar') {
      const usados = new Set(this._eqs.map((x) => x.conexao?.unit_id));
      let unit = 1;
      while (usados.has(unit) && unit < 247) unit += 1;
      const perfil = this._perfis?.[0];
      this._eqs.push({
        novo: true,
        id: this.idDoNome('novo equipamento', this._eqs.length),
        perfil: perfil?.nome || null,
        grupo: perfil?.grupo || 'energia',
        nome: 'Novo equipamento',
        tag_isa: '',
        principal: false,
        conexao: { unit_id: unit, porta_serial: this._porta },
        limites: {},
      });
    }
    this._sujo = true;
    this.desenharEquipamentos(raiz);
    this.desenharSecoes(raiz);
  },

  /* -------------------------------------------------- seções da instalação */

  /**
   * Campos de cada seção de tela. Só o que é da instalação: o que é do modelo
   * do equipamento (estados, modos, falhas) continua no perfil, e o servidor
   * recusa qualquer outro campo que chegue por aqui.
   */
  camposDaSecao(nome) {
    if (nome === 'gerador') {
      return [
        { campo: 'potencia_nominal_kw', rotulo: 'Potência nominal', un: 'kW', dica: 'da placa do gerador' },
        { campo: 'capacidade_tanque_litros', rotulo: 'Tanque', un: 'L', dica: 'volume útil do tanque de diesel' },
        { campo: 'consumo_litros_hora', rotulo: 'Consumo de catálogo', un: 'L/h', dica: 'a plena carga; o medido substitui assim que houver corrida' },
        { campo: 'teste_a_cada_dias', rotulo: 'Teste a cada', un: 'dias', dica: 'passou disso, alarme de grupo sem partir' },
        { campo: 'modo_automatico', rotulo: 'Código do modo automático', un: '', dica: 'qual valor da tag "modo" significa automático' },
        { campo: 'bateria_minima_v', rotulo: 'Bateria mínima', un: 'V', dica: 'abaixo disso o grupo não conta como disponível' },
        { campo: 'bateria_repouso_min_v', rotulo: 'Bateria em flutuação', un: 'V', dica: 'parado e com carregador bom' },
        { campo: 'bateria_partida_min_v', rotulo: 'Mínimo no arranque', un: 'V', dica: 'abaixo disso a bateria perdeu a folga' },
        { campo: 'bateria_partida_critica_v', rotulo: 'Crítico no arranque', un: 'V', dica: 'abaixo disso, programe a troca' },
      ];
    }
    return [
      { campo: 'capacidade_litros', rotulo: 'Capacidade', un: 'L', dica: 'volume útil do reservatório' },
      { campo: 'altura_util_m', rotulo: 'Altura útil', un: 'm', dica: 'entre o sensor e o extravasor' },
      { campo: 'tag_isa', rotulo: 'Tag ISA', un: '', dica: 'como está escrito na porta do painel', texto: true },
    ];
  },

  /**
   * Um equipamento recém-cadastrado ainda não tem seção: o ponto de partida vem
   * do perfil, para o técnico ver os valores usuais preenchidos e só mudar o que
   * é diferente naquela loja.
   */
  semearSecaoDoPerfil() {
    for (const e of this._eqs || []) {
      const perfil = (this._perfis || []).find((p) => p.nome === e.perfil);
      if (!perfil?.secao || !perfil.secao_padrao) continue;
      const atual = this._secoes?.[perfil.secao];
      if (atual && Object.keys(atual).length) continue;
      this._secoes = { ...this._secoes, [perfil.secao]: { ...perfil.secao_padrao } };
    }
  },

  desenharSecoes(raiz) {
    const alvo = $('#sec-formulario', raiz);
    if (!alvo) return;
    this.semearSecaoDoPerfil();
    const grupos = new Set((this._eqs || []).map((e) => e.grupo));
    const quais = [
      ['gerador', 'gerador', 'Grupo gerador', 'nível de diesel'],
      ['caixa_agua', 'agua', 'Reservatório', 'nível de água'],
    ].filter(([, grupo]) => grupos.has(grupo));

    if (!quais.length) {
      alvo.innerHTML = '<p class="vazio">Nenhuma seção a preencher: '
        + 'esta instalação não tem gerador nem reservatório cadastrado.</p>';
      return;
    }

    alvo.innerHTML = quais.map(([nome, , titulo, oQue]) => {
      const dados = this._secoes?.[nome] || {};
      const campos = this.camposDaSecao(nome).map((c) => `
        <label class="campo-secao">
          <span class="rotulo">${esc(c.rotulo)}${c.un ? ` <span class="un">(${esc(c.un)})</span>` : ''}</span>
          <input class="entrada" data-secao="${nome}" data-secao-campo="${c.campo}"
                 ${c.texto ? '' : 'type="number" step="any" min="0"'}
                 value="${esc(dados[c.campo] ?? '')}" title="${esc(c.dica)}">
          <span class="dica">${esc(c.dica)}</span>
        </label>`).join('');

      const marcas = (dados.marcas || []).map((m, i) => `
        <tr>
          <td><input class="entrada curta" type="number" min="0" max="100" step="any"
                     data-secao="${nome}" data-marca="${i}" data-marca-campo="valor" value="${esc(m.valor)}"></td>
          <td><input class="entrada larga" data-secao="${nome}" data-marca="${i}"
                     data-marca-campo="rotulo" value="${esc(m.rotulo || '')}"></td>
          <td><select class="entrada" data-secao="${nome}" data-marca="${i}" data-marca-campo="prioridade">
            ${[['alta', 'crítico'], ['media', 'atenção'], ['info', 'informativo']].map(([v, r]) => `
              <option value="${v}" ${m.prioridade === v ? 'selected' : ''}>${r}</option>`).join('')}
          </select></td>
          <td class="n"><button class="botao" data-secao-acao="remover-marca"
                                data-secao="${nome}" data-marca="${i}">Remover</button></td>
        </tr>`).join('');

      return `<div class="secao-instalacao">
        <h3 class="titulo-secao">${esc(titulo)}</h3>
        <div class="campos-secao">${campos}</div>
        <p class="rotulo" style="margin:14px 0 6px">Marcas de ${esc(oQue)} — viram as linhas
          tracejadas do desenho e os limites do alarme</p>
        <table class="editor">
          <thead><tr><th>%</th><th>Rótulo</th><th>Prioridade</th><th></th></tr></thead>
          <tbody>${marcas || `<tr><td colspan="4" class="rotulo">nenhuma marca definida</td></tr>`}</tbody>
        </table>
        <button class="botao" style="margin-top:10px" data-secao-acao="add-marca"
                data-secao="${nome}">Adicionar marca</button>
      </div>`;
    }).join('');
  },

  alterarSecao(raiz, el) {
    const nome = el.dataset.secao;
    if (!this._secoes) this._secoes = {};
    if (!this._secoes[nome]) this._secoes[nome] = {};
    const secao = this._secoes[nome];

    if (el.dataset.marca !== undefined) {
      const i = Number(el.dataset.marca);
      secao.marcas = secao.marcas || [];
      const campo = el.dataset.marcaCampo;
      secao.marcas[i] = {
        ...secao.marcas[i],
        [campo]: campo === 'valor' ? Number(el.value) : el.value,
      };
    } else {
      const campo = el.dataset.secaoCampo;
      secao[campo] = el.value === '' ? null : (el.type === 'number' ? Number(el.value) : el.value);
    }
    this._sujo = true;
    this.desenharEquipamentos(raiz);
  },

  acaoSecao(raiz, acao, nome, i) {
    if (!this._secoes[nome]) this._secoes[nome] = {};
    const secao = this._secoes[nome];
    secao.marcas = secao.marcas || [];
    if (acao === 'add-marca') secao.marcas.push({ valor: 50, rotulo: 'nova marca', prioridade: 'media' });
    if (acao === 'remover-marca') secao.marcas.splice(i, 1);
    this._sujo = true;
    this.desenharSecoes(raiz);
    this.desenharEquipamentos(raiz);
  },

  async salvarEquipamentos(raiz, apenasValidar) {
    const aviso = $('#eq-aviso', raiz);
    aviso.innerHTML = '<p class="rotulo">conferindo…</p>';
    try {
      const r = await api('/api/eng/equipamentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        body: JSON.stringify({
          equipamentos: this._eqs,
          secoes: this._secoes || {},
          apenas_validar: apenasValidar,
        }),
      });
      const avisos = (r.avisos || []).map((a) => `<li>${esc(a)}</li>`).join('');
      aviso.innerHTML = `<div class="resultado ok">
        <b>${apenasValidar ? 'Configuração válida.' : 'Configuração aplicada.'}</b>
        ${apenasValidar ? ' Nada foi alterado ainda.' : ' A leitura já está usando os novos endereços.'}
        ${avisos ? `<ul class="rotulo" style="margin:8px 0 0">${avisos}</ul>` : ''}
      </div>`;
      if (!apenasValidar) {
        this._sujo = false;
        setTimeout(() => location.reload(), 1200);
      }
    } catch (e) {
      const lista = e.dados?.erros?.length ? e.dados.erros : [e.message];
      aviso.innerHTML = `<div class="resultado ruim"><b>Não foi aplicado.</b>
        <ul class="rotulo" style="margin:8px 0 0">${lista.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    }
  },

  async varrer(raiz) {
    const saida = $('#v-saida', raiz);
    const botao = $('#v-rodar', raiz);
    botao.disabled = true;
    saida.innerHTML = '<p class="rotulo">procurando…</p>';
    try {
      const r = await api('/api/eng/varredura', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        body: JSON.stringify({
          tipo: $('#v-tipo', raiz).value,
          ...($('#v-tipo', raiz).value === 'tcp'
            ? { host: $('#v-host', raiz).value.trim(), porta: Number($('#v-porta-tcp', raiz).value) || 502 }
            : {
              porta_serial: $('#v-porta', raiz).value,
              baud: Number($('#v-baud', raiz).value),
              paridade: $('#v-paridade', raiz).value,
            }),
          de: Number($('#v-de', raiz).value),
          ate: Number($('#v-ate', raiz).value),
        }),
      });
      const configurados = new Map(estado.config.equipamentos.map((e) => [e.unit_id, e.nome]));
      saida.innerHTML = r.achados.length ? `<table>
        <thead><tr><th>Endereço</th><th>Situação</th><th>Resposta</th><th>Configurado como</th></tr></thead>
        <tbody>${r.achados.map((a) => `<tr>
          <td class="n">${a.unit_id}</td>
          <td>${a.situacao === 'respondeu' ? '<span class="selo ok">respondeu</span>'
    : '<span class="selo media">existe, recusou o pedido</span>'}</td>
          <td class="n">${a.ms} ms</td>
          <td>${esc(configurados.get(a.unit_id) || '— não está no config —')}</td>
        </tr>`).join('')}</tbody></table>
        ${r.simulado ? '<p class="rotulo">resultado simulado</p>' : ''}`
        : '<p class="vazio">Ninguém respondeu nessa faixa. Confira velocidade, paridade e fiação.</p>';
    } catch (e) {
      saida.innerHTML = `<p class="vazio" style="color:var(--critico)">${esc(e.message)}</p>`;
    } finally {
      botao.disabled = false;
    }
  },

  async ler(raiz) {
    const saida = $('#t-saida', raiz);
    const sel = $('#t-id', raiz);
    const unitId = sel.value === 'livre' ? Number($('#t-id-livre', raiz).value) : Number(sel.value);
    try {
      const r = await api('/api/eng/ler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
        body: JSON.stringify({
          unit_id: unitId,
          funcao: $('#t-funcao', raiz).value,
          endereco: Number($('#t-end', raiz).value),
          quantidade: Number($('#t-qtd', raiz).value),
        }),
      });
      const base = Number($('#t-end', raiz).value);
      saida.innerHTML = `<table>
        <thead><tr><th>Reg.</th><th>Hex</th><th>Bits</th>${COLUNAS.map((c) => `<th>${TITULOS[c]}</th>`).join('')}</tr></thead>
        <tbody>${r.leitura.map((l) => `<tr>
          <td class="n">${base + l.endereco_relativo}</td>
          <td class="n">${l.hex}</td>
          <td class="n" style="letter-spacing:.06em">${l.bits.replace(/(.{4})/g, '$1 ').trim()}</td>
          ${COLUNAS.map((c) => `<td class="n">${l[c] === undefined || l[c] === null ? '—' : num(l[c], 3)}</td>`).join('')}
        </tr>`).join('')}</tbody></table>
        <p class="rotulo">resposta em ${r.ms} ms · ${r.registradores.length} registradores</p>`;
    } catch (e) {
      saida.innerHTML = `<p class="vazio" style="color:var(--critico)">${esc(e.message)}</p>`;
    }
  },

  async diagnostico(raiz) {
    const saida = $('#d-saida', raiz);
    if (!saida || !saida.isConnected) return;
    try {
      const r = await api('/api/eng/diagnostico');
      $('#d-resumo', raiz).textContent = `${r.equipamentos.length} equipamentos · `
        + `${r.barramentos.length} barramento(s) · varredura a cada ${r.intervalo_ms} ms`;
      saida.innerHTML = `<table>
        <thead><tr><th>Equipamento</th><th>ID</th><th>Estado</th><th>Requisições</th><th>Falhas</th>
          <th>Exceções</th><th>Tempo médio</th><th>Pior tempo</th><th>Última falha</th></tr></thead>
        <tbody>${r.equipamentos.map((e) => `<tr class="${e.taxa_falha > 5 ? 'prioridade-alta' : e.taxa_falha > 0 ? 'prioridade-media' : ''}">
          <td>${esc(e.nome)}</td>
          <td class="n">${e.unit_id ?? '—'}</td>
          <td>${e.online ? '<span class="selo ok">em serviço</span>' : '<span class="selo alta">sem comunicação</span>'}</td>
          <td class="n">${e.requisicoes}</td>
          <td class="n">${e.falhas}${e.taxa_falha ? ` (${e.taxa_falha}%)` : ''}</td>
          <td class="n">${e.excecoes}</td>
          <td class="n">${e.tempo_medio ?? '—'} ms</td>
          <td class="n">${e.tempo_max || '—'} ms</td>
          <td class="n">${e.ultima_falha ? esc(`${dataHora(e.ultima_falha.ts)} — ${e.ultima_falha.mensagem}`) : '—'}</td>
        </tr>`).join('')}</tbody></table>`;
    } catch (e) {
      saida.innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  },

  async perfis(raiz) {
    const saida = $('#p-saida', raiz);
    try {
      const r = await api('/api/eng/perfis');
      const usados = new Map();
      for (const e of estado.config.equipamentos) {
        if (e.perfil) usados.set(e.perfil, (usados.get(e.perfil) || 0) + 1);
      }
      saida.innerHTML = `<table>
        <thead><tr><th>Perfil</th><th>Equipamento</th><th>Grupo</th><th>Tags</th><th>Alarmes</th><th>Em uso</th></tr></thead>
        <tbody>${r.perfis.map((p) => `<tr>
          <td class="n">${esc(p.nome)}</td>
          <td>${esc(p.titulo)}${p.observacao ? `<br><span class="rotulo">${esc(p.observacao)}</span>` : ''}</td>
          <td>${esc(p.grupo || '—')}</td>
          <td class="n">${p.tags}</td>
          <td class="n">${p.alarmes}</td>
          <td class="n">${usados.get(p.nome) || 0}</td>
        </tr>`).join('')}</tbody></table>`;
    } catch (e) {
      saida.innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  },

  destruir() {
    clearInterval(this._timer);
    clearInterval(this._diag);
    this._timer = null;
    this._diag = null;
    if (this._raiz) {
      if (this._aoClicar) this._raiz.removeEventListener('click', this._aoClicar);
      if (this._aoMudar) this._raiz.removeEventListener('change', this._aoMudar);
    }
    this._raiz = null;
    this._aoClicar = null;
    this._aoMudar = null;
  },
};

export const _eng = { MODO_DEMO, $$ };
