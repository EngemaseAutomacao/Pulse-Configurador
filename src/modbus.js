import ModbusRTU from 'modbus-serial';
import {
  FUNCOES_BIT, decodificar, montarBlocos, normalizarPorta, ehSentinela,
} from './mapa.js';
import { aplicarDerivacao } from './derivadas.js';
import { filtrarContador, TAXA_PADRAO } from './contadores.js';

/**
 * Silêncio mínimo entre dois quadros RTU: 3,5 caracteres pela norma (11 bits
 * por caractere com paridade ou 2 stops), com piso de 5 ms — conversores
 * USB-485 e CLPs como o FX3U precisam de folga para virar a linha de
 * transmissão para recepção.
 */
export function silencioEntreQuadros(conexao = {}) {
  if (conexao.tipo === 'tcp') return 0;
  if (Number.isFinite(conexao.intervalo_entre_quadros_ms)) return conexao.intervalo_entre_quadros_ms;
  return Math.max(5, Math.ceil((3.5 * 11 * 1000) / (conexao.baud || 9600)));
}

/**
 * A falha é da porta (e reabrir resolve) ou de um escravo (e reabrir só piora)?
 * Numa RS-485 a porta é de todos: timeout, CRC errado ou exceção de UM
 * equipamento não justificam fechá-la — o fecha-e-abre derrubaria pedidos dos
 * outros que estão respondendo bem. Em TCP a conexão caída é causa comum de
 * timeout, então lá reconectar continua sendo o certo.
 */
export function falhaDaPorta(erro, rtu) {
  if (!rtu) return true;
  return /port not open|not open|EIO|ENOENT|ENODEV|EACCES|EBUSY|cannot lock|disconnected|closed/i
    .test(String(erro?.message || erro));
}

/** Chave da fila: uma por porta física (serial) ou por máquina:porta (TCP). */
export function chaveDoBarramento(conexao) {
  return conexao.tipo === 'rtu'
    ? `rtu:${normalizarPorta(conexao.porta_serial)}`
    : `tcp:${conexao.host}:${conexao.porta || 502}`;
}

/**
 * Um barramento físico (uma porta serial ou uma conexão TCP).
 *
 * Tudo que fala nele passa por esta fila, uma requisição de cada vez: em RS-485
 * dois quadros ao mesmo tempo se embaralham no par trançado. Duas filas:
 *   - urgente: comando de acionamento e a leitura que confere o resultado;
 *   - normal:  varredura, heartbeat, terminal de engenharia.
 * A urgente passa na frente de tudo que ainda está esperando, mas nunca
 * interrompe um quadro já no fio — isso sim causaria colisão.
 */
class Barramento {
  constructor(conexao, { aposFechar = Promise.resolve() } = {}) {
    this.conexao = conexao;
    this.rtu = conexao.tipo !== 'tcp';
    this.cliente = new ModbusRTU();
    // guarda os bytes do pedido e da resposta em cada transação: é o que
    // permite mostrar na auditoria o quadro cru quando um eco não bate
    this.cliente.isDebugEnabled = true;
    this.conectado = false;
    this.conectando = null;
    this.encerrado = false;
    // a porta pode estar sendo fechada pelo coletor anterior (troca de configuração)
    this.aposFechar = aposFechar;

    this.urgentes = [];
    this.normais = [];
    this.ocupado = false;
    this.quemEspera = [];         // aguardarVazio()
    this.ultimoFim = 0;
    this.falhouUltima = false;
    this.entreQuadros = silencioEntreQuadros(conexao);
    this.aposFalha = this.rtu ? (conexao.silencio_apos_falha_ms ?? 150) : 0;
  }

  async conectar() {
    if (this.encerrado) throw new Error('barramento encerrado (configuração trocada)');
    if (this.conectado) return;
    if (this.conectando) return this.conectando;   // evita abrir a porta duas vezes
    const c = this.conexao;
    this.conectando = (async () => {
      await this.aposFechar;
      if (c.tipo === 'rtu') {
        await this.cliente.connectRTUBuffered(c.porta_serial, {
          baudRate: c.baud || 9600,
          parity: c.paridade || 'none',
          dataBits: c.bits_dados || 8,
          stopBits: c.bits_parada || 1,
        });
      } else {
        await this.cliente.connectTCP(c.host, { port: c.porta || 502 });
      }
      this.cliente.setTimeout(c.timeout_ms || 1500);
      this.conectado = true;
    })();
    try {
      await this.conectando;
    } finally {
      this.conectando = null;
    }
  }

  /** Fecha a porta; a promessa só resolve quando o sistema a liberou de fato. */
  desconectar() {
    this.conectado = false;
    return new Promise((resolver) => {
      const prazo = setTimeout(resolver, 2000);   // porta que não responde não trava ninguém
      try {
        this.cliente.close(() => { clearTimeout(prazo); resolver(); });
      } catch {
        clearTimeout(prazo);
        resolver();                                 // já estava fechada
      }
    });
  }

  /** Enfileira uma operação. `urgente` passa na frente do que ainda não saiu. */
  executar(tarefa, { urgente = false } = {}) {
    return new Promise((resolve, reject) => {
      (urgente ? this.urgentes : this.normais).push({ tarefa, resolve, reject });
      this.rodar();
    });
  }

  async rodar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      while (this.urgentes.length || this.normais.length) {
        const item = this.urgentes.shift() || this.normais.shift();
        await this.esperarSilencio();
        this.descartarRecebido();
        try {
          item.resolve(await item.tarefa());
          this.falhouUltima = false;
        } catch (e) {
          this.falhouUltima = true;
          item.reject(e);
        } finally {
          this.ultimoFim = Date.now();
        }
      }
    } finally {
      this.ocupado = false;
      for (const r of this.quemEspera.splice(0)) r();
    }
  }

  /**
   * Silêncio antes do próximo quadro. Depois de uma falha, bem mais longo: o
   * escravo que estourou o tempo pode estar respondendo ATRASADO, e essa
   * resposta não pode cair em cima do pedido seguinte.
   */
  esperarSilencio() {
    const folga = this.falhouUltima ? Math.max(this.aposFalha, this.entreQuadros) : this.entreQuadros;
    const falta = this.ultimoFim + folga - Date.now();
    return falta > 0 ? new Promise((r) => setTimeout(r, falta)) : Promise.resolve();
  }

  /**
   * Joga fora bytes que chegaram fora de hora. A porta "buffered" da
   * modbus-serial não limpa a recepção ao mandar um pedido novo: uma resposta
   * atrasada, do mesmo escravo e com o mesmo tamanho, seria aceita como
   * resposta do pedido seguinte — com valores de outros registradores. O CRC
   * não pega isso, porque o quadro velho é íntegro.
   * (`_buffer` é interno da biblioteca; o teste "descarte de resposta
   * atrasada" acusa se uma atualização o remover.)
   */
  descartarRecebido() {
    const porta = this.cliente._port;
    if (this.rtu && porta && Buffer.isBuffer(porta._buffer) && porta._buffer.length) {
      porta._buffer = Buffer.alloc(0);
    }
  }

  /** Resolve quando não houver nada rodando nem esperando na fila. */
  aguardarVazio() {
    if (!this.ocupado && !this.urgentes.length && !this.normais.length) return Promise.resolve();
    return new Promise((r) => this.quemEspera.push(r));
  }

  async lerBloco(unitId, bloco) {
    await this.conectar();
    this.cliente.setID(unitId);
    const qtd = bloco.fim - bloco.inicio;
    const ini = bloco.endereco_fisico ?? bloco.inicio;
    switch (bloco.funcao) {
      case 'input':    return (await this.cliente.readInputRegisters(ini, qtd)).data;
      case 'coil':     return (await this.cliente.readCoils(ini, qtd)).data;
      case 'discreta': return (await this.cliente.readDiscreteInputs(ini, qtd)).data;
      case 'holding':
      default:         return (await this.cliente.readHoldingRegisters(ini, qtd)).data;
    }
  }
}

const hex = (bytes) => (bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ') : '—');

/**
 * Confere o eco da escrita. Pela norma o escravo responde repetindo endereço e
 * valor (FC5, FC6) ou endereço e quantidade (FC15, FC16); a biblioteca não
 * compara com o pedido.
 *
 *  - ENDEREÇO diferente: é resposta de outra conversa. Erro — a escrita não
 *    pode ser dada como feita.
 *  - VALOR diferente com o endereço certo: há CLP que devolve no eco outra
 *    coisa que não o valor escrito (o FX3U da bancada responde sempre 184 e
 *    obedece normalmente). Não é erro: devolve a divergência, com os bytes
 *    crus, para a auditoria. Quem confirma o comando é a realimentação.
 */
export function conferirEco(r, { endereco, valor, valores, funcao }) {
  if (!r || typeof r !== 'object') return null;
  if (r.address !== undefined && r.address !== endereco) {
    throw new Error(`eco da escrita veio de outro registrador (esperado ${endereco}, veio ${r.address}) — escrita não confirmada`);
  }
  const [campo, esperado] = valores ? ['length', valores.length]
    : funcao === 'coil' ? ['state', valor >= 1] : ['value', valor];
  if (r[campo] === undefined || r[campo] === esperado) return null;
  return `eco com ${campo}=${r[campo]} em vez de ${esperado}`
    + ` (pedido ${hex(r.request)} · resposta ${hex(r.responses?.at(-1))})`;
}

export class Coletor {
  /**
   * @param {object} config
   * @param {{aposFechar?: Promise}} opcoes  aposFechar: promessa do coletor
   *        anterior terminar e fechar as portas. Na troca de configuração as
   *        duas instâncias não podem falar ao mesmo tempo na mesma serial.
   */
  constructor(config, { aposFechar = Promise.resolve() } = {}) {
    this.config = config;
    this.aposFechar = aposFechar;
    this.ciclo = 0;
    this.barramentos = new Map();
    this.equipamentos = config.medidores.map((m, i) => ({
      def: m,
      indice: i,
      blocos: montarBlocos(m.tags, m.padrao || {}),
      chave: chaveDoBarramento(m.conexao),
      online: false,
      erro: null,
      falhas: 0,
      ultimos: {},
      lidoEm: 0,
      hbEm: 0,
      hbContador: 0,
      contadores: {},     // estado do filtro de cada tag acumuladora
      diag: {
        requisicoes: 0, falhas: 0, excecoes: 0, tempo_total: 0, tempo_max: 0, ultima_falha: null,
        contador_recusado: 0, ultimo_contador_recusado: null,
      },
    }));
    this.pausado = null;
    this.emLeitura = Promise.resolve();
    this.reservas = new Map();     // chave do barramento → id do equipamento em comando
    this.encerrado = false;
  }

  barramentoDe(eq) {
    if (!this.barramentos.has(eq.chave)) {
      const b = new Barramento(eq.def.conexao, { aposFechar: this.aposFechar });
      // a porta é de todos os equipamentos dela: vale a maior folga que algum
      // deles pede, não só a do primeiro cadastrado
      const conexoes = this.equipamentos.filter((x) => x.chave === eq.chave).map((x) => x.def.conexao);
      b.entreQuadros = Math.max(...conexoes.map((c) => silencioEntreQuadros(c)));
      if (b.rtu) b.aposFalha = Math.max(...conexoes.map((c) => c.silencio_apos_falha_ms ?? 150));
      this.barramentos.set(eq.chave, b);
    }
    return this.barramentos.get(eq.chave);
  }

  /** Equipamentos com rodízio se revezam pelo índice, para aliviar o barramento. */
  cabeNestaVarredura(eq) {
    const n = eq.def.varredura_a_cada || 1;
    return n <= 1 || this.ciclo % n === eq.indice % n;
  }

  extrair(bloco, tag, dados) {
    const ini = tag.endereco - bloco.inicio;
    if (FUNCOES_BIT.has(bloco.funcao)) return dados[ini] ? 1 : 0;
    if (tag.bit !== null) return (dados[ini] >> tag.bit) & ((1 << (tag.largura || 1)) - 1);
    const regs = dados.slice(ini, ini + tag.palavras);
    if (tag.sentinelas && ehSentinela(regs, tag.tipo)) return null;   // "sem sensor", "fora da faixa"
    const bruto = decodificar(regs, tag.tipo, tag.ordem);
    const valor = bruto * tag.escala + tag.deslocamento;
    if (!Number.isFinite(valor)) return null;
    if (tag.faixa && (valor < tag.faixa[0] || valor > tag.faixa[1])) return null;
    if (!tag.limitar) return valor;
    return Math.min(tag.limitar[1], Math.max(tag.limitar[0], valor));
  }

  /**
   * Suspende a varredura e FECHA as portas, para a varredura de endereços abrir
   * a sua. Espera o ciclo em andamento e o que já estava na fila de cada
   * barramento: duas conversas na mesma RS-485 embaralham as respostas.
   * Pausas se somam — cada pausar() pede o seu retomar().
   */
  async pausar() {
    if (!this.pausado) {
      let liberar;
      const promessa = new Promise((r) => { liberar = r; });
      this.pausado = { promessa, liberar, pedidos: 0 };
    }
    this.pausado.pedidos += 1;
    await this.emLeitura;
    await Promise.all([...this.barramentos.values()].map((b) => b.aguardarVazio()));
    await Promise.all([...this.barramentos.values()].map((b) => b.desconectar()));
  }

  retomar() {
    if (!this.pausado) return;
    this.pausado.pedidos -= 1;
    if (this.pausado.pedidos > 0) return;
    this.pausado.liberar();
    this.pausado = null;
  }

  /** Com a porta cedida à varredura, ninguém mais pode reabri-la. */
  exigirBarramentoLivre() {
    if (this.pausado) throw new Error('barramento em uso pela varredura de endereços; tente em instantes');
  }

  /**
   * Reserva o barramento de um equipamento durante um acionamento: a varredura
   * dos OUTROS equipamentos daquele barramento fica suspensa (eles mantêm o
   * último valor e não são dados como mudos) e o fio fica só para o comando e
   * para a leitura que confere o resultado. O heartbeat continua: o watchdog do
   * CLP não pode vencer justo no meio de um comando.
   * Devolve a função que libera.
   */
  reservar(idEquipamento) {
    const eq = this.equipamentos.find((x) => x.def.id === idEquipamento);
    if (!eq) return () => {};
    const marca = Symbol(idEquipamento);
    this.reservas.set(eq.chave, marca);
    return () => { if (this.reservas.get(eq.chave) === marca) this.reservas.delete(eq.chave); };
  }

  async lerEquipamento(eq, { completo = false, urgente = false } = {}) {
    const barramento = this.barramentoDe(eq);
    const valores = { ...eq.ultimos };
    // os lentos vão a cada ~N varreduras do ciclo, contadas nas leituras DESTE
    // equipamento: pelo ciclo global, um rodízio de 4 com N = 20 caía só nos
    // índices pares e os ímpares nunca reliam energia nem THD
    const passoLento = Math.max(1, Math.round(
      (this.config.varreduras_por_leitura_lenta || 10) / (eq.def.varredura_a_cada || 1)));
    eq.leituras = (eq.leituras || 0) + 1;
    const lerLentos = completo || (eq.leituras + eq.indice) % passoLento === 0 || eq.lidoEm === 0;

    try {
      for (const bloco of eq.blocos) {
        if (bloco.lento && !lerLentos) continue;
        const t0 = Date.now();
        const dados = await barramento.executar(
          () => barramento.lerBloco(eq.def.conexao.unit_id || 1, bloco), { urgente },
        );
        const dt = Date.now() - t0;
        eq.diag.requisicoes += 1;
        eq.diag.tempo_total += dt;
        eq.diag.tempo_max = Math.max(eq.diag.tempo_max, dt);
        for (const tag of bloco.tags) {
          const v = this.extrair(bloco, tag, dados);
          valores[tag.nome] = tag.acumulador ? this.conferirContador(eq, tag, v) : v;
        }
      }
      // perfil que lê registradores "crus" (ex.: GenComm) traduz aqui para as
      // tags que a tela e os indicadores entendem: estado, falhas, rede
      aplicarDerivacao(eq.def, valores);
      eq.falhas = 0;
      eq.retomarEm = 0;
      eq.ultimos = valores;
      eq.lidoEm = Date.now();
      /* Equipamento lido por intermédio de outro (o gerador, pelo CLP da
         subestação): o CLP responder não prova que o gerador responde. Quem diz
         é o próprio CLP, num registrador de "enlace ok" — sem ele, a tela
         mostraria valores congelados como se fossem atuais. */
      const vivo = eq.def.online_quando;
      if (vivo && valores[vivo.tag] !== (vivo.igual ?? 1)) {
        eq.online = false;
        eq.erro = vivo.mensagem || `${vivo.tag} indica enlace perdido`;
      } else {
        eq.online = true;
        eq.erro = null;
      }
    } catch (e) {
      if (this.encerrado) return valores;    // troca de configuração, não é falha do equipamento
      eq.falhas += 1;
      eq.diag.falhas += 1;
      eq.diag.ultima_falha = { ts: Date.now(), mensagem: e.message };
      if (/exception|illegal/i.test(e.message)) eq.diag.excecoes += 1;
      // uma falha isolada é comum em RS-485; só declara offline na segunda seguida
      if (eq.falhas >= 2) {
        eq.online = false;
        eq.erro = e.message;
        // mudo: volta a ser perguntado só de tempos em tempos (ver lerCiclo)
        eq.retomarEm = Date.now() + (this.config.reintento_sem_comunicacao_ms ?? 10000);
        if (falhaDaPorta(e, barramento.rtu)) barramento.desconectar();
      }
    }
    return valores;
  }

  /** Contador de energia: leitura com salto impossível não chega à tela nem ao histórico. */
  conferirContador(eq, tag, v) {
    const taxa = tag.taxa_maxima ?? eq.def.padrao?.taxa_maxima_contador ?? TAXA_PADRAO;
    const agora = Date.now();
    const antes = eq.contadores[tag.nome]?.ref?.v;
    const r = filtrarContador(eq.contadores[tag.nome], v, agora, taxa);
    eq.contadores[tag.nome] = r.estado;
    if (r.recusado) {
      eq.diag.contador_recusado += 1;
      eq.diag.ultimo_contador_recusado = { ts: agora, tag: tag.nome, aceito: antes, lido: v };
      console.warn(`aviso: ${eq.def.id}.${tag.nome} ${antes} → ${v} recusado (salto impossível); aguardando confirmação`);
    } else if (r.reancorado) {
      console.warn(`aviso: ${eq.def.id}.${tag.nome} reancorado em ${v} (${antes} não se confirmou)`);
    }
    return r.valor;
  }

  /** Barramentos diferentes em paralelo; o mesmo barramento, em fila. */
  async lerTodos() {
    // em laço: uma pausa nova pode começar enquanto a anterior era liberada
    while (this.pausado) await this.pausado.promessa;
    const leitura = this.lerCiclo();
    this.emLeitura = leitura.catch(() => {});
    return leitura;
  }

  async lerCiclo() {
    this.ciclo += 1;
    const agora = Date.now();
    const leituras = await Promise.all(this.equipamentos.map(async (eq) => {
      // barramento reservado para um comando: quem está nele espera a vez.
      // Equipamento sem comunicação não é perguntado a cada ciclo: cada pedido
      // sem resposta segura a linha pelo timeout inteiro (1 s), e um endereço
      // vazio ou um CLP desligado atrasaria todos os outros da mesma RS-485
      const emEspera = !eq.online && eq.retomarEm && agora < eq.retomarEm;
      const ler = this.cabeNestaVarredura(eq) && !this.reservas.has(eq.chave) && !emEspera;
      return { eq, valores: ler ? await this.lerEquipamento(eq) : { ...eq.ultimos } };
    }));

    const saida = {};
    for (const { eq, valores } of leituras) saida[eq.def.id] = this.resumo(eq, valores);
    return saida;
  }

  resumo(eq, valores) {
    return {
      id: eq.def.id,
      nome: eq.def.nome,
      tag_isa: eq.def.tag_isa || null,
      grupo: eq.def.grupo || 'energia',
      online: eq.online,
      erro: eq.erro,
      lidoEm: eq.lidoEm,
      valores,
    };
  }

  /**
   * Lê agora um equipamento só, com todos os blocos (inclusive os lentos) e
   * pela fila urgente. É o que a confirmação de comando usa: esperar a
   * realimentação não pode custar uma varredura da planta inteira.
   */
  async lerUm(idEquipamento) {
    const eq = this.equipamentos.find((x) => x.def.id === idEquipamento);
    if (!eq) return {};
    this.exigirBarramentoLivre();
    const valores = await this.lerEquipamento(eq, { completo: true, urgente: true });
    return { [eq.def.id]: this.resumo(eq, valores) };
  }

  /**
   * Escreve o contador de prova de vida nos equipamentos que declaram
   * `heartbeat` no perfil. É uma escrita declarada em configuração, num
   * registrador fixo — diferente da escrita manual do terminal de engenharia,
   * que continua dependendo de `seguranca.escrita_modbus_liberada`.
   * Sem isso, um CLP que vigia o supervisório entende que ele morreu.
   */
  async enviarHeartbeats() {
    if (this.pausado) return;
    const agora = Date.now();
    for (const eq of this.equipamentos) {
      const hb = eq.def.heartbeat;
      if (!hb || !Number.isInteger(hb.endereco) || !eq.online) continue;
      if (agora - eq.hbEm < (hb.intervalo_s ?? 5) * 1000) continue;
      eq.hbEm = agora;
      eq.hbContador = (eq.hbContador % (hb.maximo ?? 30000)) + 1;
      try {
        const r = await this.escreverBruto({
          barramento: eq.chave,
          unit_id: eq.def.conexao.unit_id || 1,
          endereco: hb.endereco,
          valor: eq.hbContador,
        });
        // aparece no diagnóstico de Engenharia, sem contar como falha
        if (r?.ecoDivergente) eq.diag.eco_divergente = { ts: Date.now(), mensagem: `heartbeat: ${r.ecoDivergente}` };
      } catch (e) {
        eq.diag.falhas += 1;
        eq.diag.ultima_falha = { ts: Date.now(), mensagem: `heartbeat: ${e.message}` };
      }
    }
  }

  diagnostico() {
    return this.equipamentos.map((eq) => ({
      id: eq.def.id,
      nome: eq.def.nome,
      barramento: eq.chave,
      unit_id: eq.def.conexao.unit_id,
      online: eq.online,
      erro: eq.erro,
      lido_em: eq.lidoEm,
      blocos: eq.blocos.length,
      ...eq.diag,
      tempo_medio: eq.diag.requisicoes ? Math.round(eq.diag.tempo_total / eq.diag.requisicoes) : null,
      taxa_falha: eq.diag.requisicoes
        ? +(eq.diag.falhas / (eq.diag.requisicoes + eq.diag.falhas) * 100).toFixed(1) : 0,
    }));
  }

  zerarDiagnostico() {
    for (const eq of this.equipamentos) {
      eq.diag = { requisicoes: 0, falhas: 0, excecoes: 0, tempo_total: 0, tempo_max: 0, ultima_falha: null };
    }
  }

  /** Barramento pela chave, criando a fila se o equipamento ainda não foi lido. */
  barramentoPelaChave(chave) {
    if (!chave) {
      return this.barramentos.values().next().value
        || (this.equipamentos[0] && this.barramentoDe(this.equipamentos[0]));
    }
    const eq = this.equipamentos.find((x) => x.chave === chave);
    return this.barramentos.get(chave) || (eq && this.barramentoDe(eq));
  }

  /** Leitura avulsa pelo terminal de engenharia, usando a fila do barramento. */
  async lerBruto({ barramento: chave, unit_id, funcao = 'holding', endereco = 0, quantidade = 8 }) {
    this.exigirBarramentoLivre();
    // sem barramento indicado, vai pelo do equipamento cadastrado com esse
    // endereço: com o CLP na COM7 e o gerador na COM4, ler o endereço 10 no
    // primeiro barramento seria perguntar ao fio errado
    const dono = chave ? null : this.equipamentos.find((x) => (x.def.conexao.unit_id || 1) === unit_id);
    const alvo = this.barramentoPelaChave(chave || dono?.chave);
    if (!alvo) throw new Error('nenhum barramento aberto');
    const t0 = Date.now();
    const dados = await alvo.executar(() =>
      alvo.lerBloco(unit_id, { funcao, inicio: endereco, fim: endereco + quantidade }));
    return { dados, ms: Date.now() - t0 };
  }

  /**
   * Escrita: uma palavra (FC6/FC5) ou várias no mesmo quadro (FC16/FC15), com o
   * eco conferido. `urgente` é para comando de acionamento.
   */
  async escreverBruto({
    barramento: chave, unit_id, endereco, valor, valores, funcao = 'holding', urgente = false,
  }) {
    this.exigirBarramentoLivre();
    const alvo = this.barramentoPelaChave(chave);
    if (!alvo) throw new Error('nenhum barramento aberto');
    const r = await alvo.executar(async () => {
      await alvo.conectar();
      alvo.cliente.setID(unit_id);
      if (valores) {
        return funcao === 'coil'
          ? alvo.cliente.writeCoils(endereco, valores.map((v) => v >= 1))
          : alvo.cliente.writeRegisters(endereco, valores);
      }
      return funcao === 'coil'
        ? alvo.cliente.writeCoil(endereco, valor >= 1)
        : alvo.cliente.writeRegister(endereco, valor);
    }, { urgente });
    const divergencia = conferirEco(r, { endereco, valor, valores, funcao });   // lança se o endereço não bate
    if (divergencia) r.ecoDivergente = divergencia;
    return r;
  }

  /** Conexão de um equipamento pelo id, para quem precisa escrever nele. */
  conexaoDe(idEquipamento) {
    const eq = this.equipamentos.find((x) => x.def.id === idEquipamento);
    return eq ? { barramento: eq.chave, unit_id: eq.def.conexao.unit_id || 1 } : null;
  }

  listarBarramentos() {
    return [...new Set(this.equipamentos.map((e) => e.chave))];
  }

  /**
   * Encerra de vez. Devolve a promessa de que as portas estão FECHADAS: o
   * coletor novo, na troca de configuração, só abre a serial depois disso.
   * O que já estava na fila termina; nada novo abre a porta.
   */
  encerrar() {
    this.encerrado = true;
    // encerrado não volta: libera quem estiver esperando, qualquer que seja a pausa
    this.pausado?.liberar();
    this.pausado = null;
    const barramentos = [...this.barramentos.values()];
    for (const b of barramentos) b.encerrado = true;
    return Promise.all(barramentos.map(async (b) => {
      await Promise.race([b.aguardarVazio(), new Promise((r) => setTimeout(r, 5000))]);
      await b.desconectar();
    }));
  }
}
