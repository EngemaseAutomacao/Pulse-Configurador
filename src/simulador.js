/**
 * Simulador de planta para o modo --sem-modbus.
 * Reproduz energia, caixa d'água e grupo gerador com comportamento plausível,
 * incluindo partida do gerador e ciclo de recalque, para validar telas e alarmes.
 */

// Quanto do disjuntor cada circuito usa no pico do dia
const USO_DO_DISJUNTOR = {
  padaria: 0.30, acougue: 0.35, frios: 0.42, refrigerados: 0.78,
  congelados: 0.42, climatizacao: 0.38, iluminacao: 0.35, carregadores: 0.18,
};
const COM_COMPRESSOR = ['frios', 'refrigerados', 'congelados', 'climatizacao'];
// THD de corrente típico de cada carga (%): inversores e fontes chaveadas poluem mais
const THD_DO_SETOR = {
  padaria: 9, acougue: 7, frios: 14, refrigerados: 12,
  congelados: 13, climatizacao: 32, iluminacao: 22, carregadores: 38,
};
// mesma conta de src/derivadas.js (derivarHarmonicas), repetida pelo mesmo motivo
// de palavrasDeclaradas abaixo
const harmonica = (i, thd) => (Math.abs(i) * (thd / 100)) / Math.sqrt(1 + (thd / 100) ** 2);
function preencherHarmonicas(v) {
  const fases = [['a', 'thd_corrente'], ['b', 'thd_corrente_b'], ['c', 'thd_corrente_c']];
  const maiores = [];
  for (const [f, tagThd] of fases) {
    if (!(`corrente_harmonica_${f}` in v)) continue;
    const i = v[`corrente_${f}`];
    const thd = v[tagThd];
    v[`corrente_harmonica_${f}`] = i === undefined || thd === undefined ? null : harmonica(i, thd);
    if (v[`corrente_harmonica_${f}`] !== null) maiores.push(v[`corrente_harmonica_${f}`]);
  }
  if ('corrente_harmonica' in v) v.corrente_harmonica = maiores.length ? Math.max(...maiores) : null;
}

const entre = (v, min, max) => Math.min(max, Math.max(min, v));

// mesma regra de src/comandos.js (palavrasDoComando). Repetida aqui porque este
// arquivo também roda no demo.html, como script clássico, sem import
const palavrasDeclaradas = (c) => (Array.isArray(c.valores) ? c.valores
  : c.complemento ? [c.valor, (~c.valor) & 0xffff] : [c.valor]);

export class Simulador {
  /**
   * @param {object} config
   * @param {{roteiro?: boolean}} opcoes  roteiro: encena ocorrências para
   *        demonstração (nível baixo, diesel na reserva, falha no gerador).
   *        Não usar em comissionamento: mascara o comportamento real.
   */
  constructor(config, opcoes = {}) {
    this.config = config;
    this.roteiro = !!opcoes.roteiro;
    // no servidor a lista vem como "medidores"; na configuração pública
    // entregue ao navegador ela se chama "equipamentos"
    this.lista = config.medidores ?? config.equipamentos ?? [];
    this.t = Math.floor(Math.random() * 200);
    this.energias = {};
    this.disjuntores = Object.fromEntries(
      (config.unifilar?.saidas || []).map((s) => [s.medidor, parseFloat(s.disjuntor) || 100]),
    );
    // estado interno das utilidades
    this.agua = { nivel: 25 + Math.random() * 65, bomba: false, horas: 4820 };
    // estado do disjuntor, que os comandos mudam de verdade em bancada
    this.disjuntor = { ligado: true, remoto: true, falha: false };
    // estado dos digitais que o operador consegue mudar por comando
    this.estadoDigital = { disjuntor_ligado: true };
    // causa do último disparo e permissivo do relé, para exercitar o
    // religamento seletivo: 2 = sobretensão (religável), 1 = sobrecorrente (não)
    this.protecao = { causa: 0, permite_religar: true };
    this.diesel = { nivel: 30 + Math.random() * 55, horimetro: 312 };
    if (this.roteiro) {
      this.agua.nivel = 26;      // logo abaixo do limite de nível baixo
      this.diesel.nivel = 38;    // abaixo da reserva operacional
    }
  }

  async lerTodos() {
    this.t += 1;
    const t = this.t;
    const carga = 0.62 + 0.18 * Math.sin(t / 180) + 0.05 * Math.sin(t / 23);
    const normalizada = Math.min(1, carga / 0.85);

    const saida = {};
    const principal = this.lista.find((m) => m.principal) || this.lista[0];

    for (const m of this.lista) {
      // o CLP da subestação (disjuntor) usa o mesmo painel simulado do CLP
      // de utilidades: a simulação devolve só as tags que ele tem mapeadas
      const valores = m.grupo === 'agua' || m.grupo === 'subestacao' ? this.simularAgua(m)
        : m.grupo === 'gerador' ? this.simularGerador(m, carga)
          : this.simularEnergia(m, m.id === principal.id, normalizada, t);
      saida[m.id] = {
        id: m.id, nome: m.nome, tag_isa: m.tag_isa || null, grupo: m.grupo || 'energia',
        online: true, erro: null, lidoEm: Date.now(), valores,
      };
    }

    this.fecharEntrada(saida, principal.id);
    return saida;
  }

  simularEnergia(m, ehGeral, normalizada, t) {
    const ruido = (a) => (Math.random() - 0.5) * a;
    const ciclo = COM_COMPRESSOR.includes(m.id)
      ? 0.78 + 0.22 * Math.sign(Math.sin(t / 40 + m.id.length))
      : 1;
    const nominal = this.disjuntores[m.id] || 100;
    const corrente = ehGeral ? 0 : nominal * (USO_DO_DISJUNTOR[m.id] ?? 0.35) * normalizada * ciclo;
    const potencia = (Math.sqrt(3) * 380 * corrente * 0.94) / 1000;
    const valores = {};

    for (const tag of m.tags) {
      switch (tag.nome) {
        case 'tensao_an': valores[tag.nome] = 220.5 + ruido(2.4); break;
        case 'tensao_bn': valores[tag.nome] = 219.2 + ruido(2.4); break;
        case 'tensao_cn': valores[tag.nome] = 221.8 + ruido(2.4); break;
        case 'tensao_ab': valores[tag.nome] = 381.4 + ruido(3); break;
        case 'tensao_bc': valores[tag.nome] = 379.8 + ruido(3); break;
        case 'tensao_ca': valores[tag.nome] = 382.1 + ruido(3); break;
        case 'corrente_a': valores[tag.nome] = corrente + ruido(4); break;
        case 'corrente_b': valores[tag.nome] = corrente * 0.94 + ruido(4); break;
        case 'corrente_c': valores[tag.nome] = corrente * 1.05 + ruido(4); break;
        case 'corrente_n': valores[tag.nome] = corrente * 0.09 + ruido(2); break;
        case 'potencia_ativa': valores[tag.nome] = potencia; break;
        case 'potencia_reativa': valores[tag.nome] = potencia * 0.34; break;
        case 'potencia_aparente': valores[tag.nome] = potencia * 1.06; break;
        // o FP passeia em torno do limite contratual: exercita alarme e normalização
        case 'fp': valores[tag.nome] = 0.929 + 0.021 * Math.sin(t / 45) + ruido(0.006); break;
        case 'frequencia': valores[tag.nome] = 60 + ruido(0.06); break;
        case 'demanda': valores[tag.nome] = potencia * 0.97; break;
        case 'thd_tensao': valores[tag.nome] = 3.4 + ruido(1.2); break;
        case 'thd_tensao_b': valores[tag.nome] = 3.1 + ruido(1.2); break;
        case 'thd_tensao_c': valores[tag.nome] = 3.7 + ruido(1.2); break;
        case 'thd_corrente': valores[tag.nome] = (THD_DO_SETOR[m.id] ?? 7.8) + ruido(2.4); break;
        case 'thd_corrente_b': valores[tag.nome] = (THD_DO_SETOR[m.id] ?? 7.8) * 0.9 + ruido(2.4); break;
        case 'thd_corrente_c': valores[tag.nome] = (THD_DO_SETOR[m.id] ?? 7.8) * 1.1 + ruido(2.4); break;
        case 'corrente_harmonica':
        case 'corrente_harmonica_a':
        case 'corrente_harmonica_b':
        case 'corrente_harmonica_c': valores[tag.nome] = null; break;   // preenchidas no fim
        case 'sequencia_fase': valores[tag.nome] = 0; break;
        case 'energia_ativa':
        case 'energia_reativa':
        case 'energia_aparente': {
          const chave = `${m.id}.${tag.nome}`;
          // aparente = ativa / FP (~0,94); reativa ≈ 34 % da ativa
          const fator = { energia_ativa: 1, energia_reativa: 0.34, energia_aparente: 1.06 }[tag.nome];
          const inicial = ehGeral ? { energia_ativa: 128450, energia_reativa: 41200, energia_aparente: 136160 }[tag.nome] : 12800 * fator;
          const incremento = (potencia * fator) / 3600;
          this.energias[chave] = (this.energias[chave] ?? inicial) + incremento;
          valores[tag.nome] = this.energias[chave];
          break;
        }
        default: valores[tag.nome] = 0;
      }
    }
    preencherHarmonicas(valores);
    return valores;
  }

  /** Caixa d'água: consumo contínuo e bomba de recalque em automático. */
  simularAgua(m) {
    const a = this.agua;
    // proteção disparada abre o disjuntor, como no equipamento real
    if (this.roteiro && this.t % 300 >= 240 && this.t % 300 < 270) {
      this.disjuntor.ligado = false;
      this.estadoDigital.disjuntor_ligado = false;
      // alterna a causa entre religável e não religável, para a tela mostrar
      // os dois comportamentos ao longo da demonstração
      const religavel = Math.floor(this.t / 300) % 2 === 0;
      this.protecao.causa = religavel ? 2 : 1;
      this.protecao.permite_religar = religavel;
    }
    // no roteiro o ciclo é acelerado e trabalha em torno do limite de nível baixo
    const ritmo = this.roteiro ? 4 : 1;
    const liga = this.roteiro ? 24 : 60;
    const desliga = this.roteiro ? 60 : 97;
    const consumo = (0.030 + Math.random() * 0.012) * ritmo;   // %/s
    const recalque = 0.115 * ritmo;                            // %/s com a bomba ligada
    if (a.nivel < liga) a.bomba = true;
    if (a.nivel >= desliga) a.bomba = false;
    a.nivel = entre(a.nivel - consumo + (a.bomba ? recalque : 0), 0, 100);
    if (a.bomba) a.horas += 1 / 3600;

    const cap = this.config.caixa_agua?.capacidade_litros ?? 20000;
    const altura = this.config.caixa_agua?.altura_util_m ?? 2.5;

    // a leitura bruta é obtida invertendo a escala da própria tag configurada,
    // para o simulador acompanhar qualquer sensor sem código novo
    const tagNivel = (m?.tags || []).find((t) => t.nome === 'nivel');
    const escala = tagNivel?.escala ?? 1;
    const offset = tagNivel?.offset ?? 0;

    const candidatos = {
      nivel: a.nivel,
      nivel_bruto: Math.round((a.nivel - offset) / (escala || 1)),
      coluna: (a.nivel / 100) * altura,
      vazao_entrada: a.bomba ? 18 + Math.random() * 1.5 : 0,
      pressao_recalque: a.bomba ? 32 + Math.random() * 2 : 1.2,
      horas_bomba: Math.floor(a.horas),
      volume_litros: (a.nivel / 100) * cap,
      status: 0,
      bomba_ligada: a.bomba ? 1 : 0,
      bomba_falha: 0,
      boia_baixo: a.nivel < 12 ? 1 : 0,
      boia_alto: a.nivel > 98 ? 1 : 0,
      sensor_falha: 0,
      modo_automatico: 1,
      // painel de disjuntor (CLP FX3U). O estado responde aos comandos; no
      // roteiro a proteção ainda dispara sozinha por um trecho, para mostrar
      // o intertravamento recusando o religamento.
      disjuntor_ligado: this.estadoDigital.disjuntor_ligado ? 1 : 0,
      disjuntor_falha: (this.roteiro && this.t % 300 >= 240 && this.t % 300 < 270) || this.disjuntor.falha ? 1 : 0,
      modo_remoto: this.disjuntor.remoto ? 1 : 0,
      // permissivo vindo do contato do relé, e o código da causa do disparo:
      // é o par que sustenta o religamento seletivo por tipo de falta
      permite_religar: this.protecao.permite_religar ? 1 : 0,
      causa_disparo: this.protecao.causa,
      saida_y0: a.bomba ? 1 : 0,
      saida_y1: a.nivel > 50 ? 1 : 0,
    };

    // devolve só o que o equipamento realmente tem mapeado
    const valores = {};
    for (const tag of m?.tags || []) {
      if (tag.calculada) continue;          // quem preenche é o motor de indicadores
      valores[tag.nome] = candidatos[tag.nome] ?? 0;
    }
    return (m?.tags?.length) ? valores : candidatos;
  }

  /**
   * Grupo gerador. A cada 4 min de simulação a rede "cai" e o grupo cumpre o
   * ciclo completo: partida, assunção de carga, retorno da rede e resfriamento.
   */
  simularGerador(m, carga) {
    const fase = this.t % 240;
    // um ciclo em cada dois é teste semanal com a rede presente: o supervisório
    // precisa distinguir partida por queda de rede de partida por exercício
    const ciclo = Math.floor(this.t / 240);
    const ensaio = ciclo % 2 === 1;
    const redeCaiu = !ensaio && fase >= 180 && fase < 232;
    let estado = 0;              // 0 parado 1 pré-aquecendo 2 partindo 3 em carga 4 resfriando 5 falha
    if (fase >= 180 && fase < 184) estado = 1;
    else if (fase >= 184 && fase < 190) estado = 2;
    else if (fase >= 190 && fase < 226) estado = 3;
    else if (fase >= 226 && fase < 232) estado = 4;

    // roteiro: durante a carga o motor perde pressão de óleo e o grupo desarma.
    // Desarmado, ele fica em falha até o fim da janela — grupo que disparou não
    // volta sozinho para a carga, e o supervisório precisa ver isso assim.
    const desarme = this.roteiro && fase >= 206 && fase < 232;
    if (desarme) estado = 5;
    const rodando = (estado >= 2 && estado <= 4);
    const emCarga = estado === 3;
    const ruido = (a) => (Math.random() - 0.5) * a;
    const nominal = this.config.gerador?.potencia_nominal_kw ?? 180;
    const potencia = emCarga ? nominal * (0.45 + 0.25 * carga) : 0;

    if (rodando) {
      this.diesel.horimetro += 1 / 3600;
      const consumo = this.config.gerador?.consumo_litros_hora ?? 38;
      const tanque = this.config.gerador?.capacidade_tanque_litros ?? 500;
      this.diesel.nivel = entre(this.diesel.nivel - (consumo / tanque) * 100 / 3600, 0, 100);
    }
    const nivel = this.diesel.nivel;

    return {
      tensao_ab: emCarga ? 380 + ruido(4) : 0,
      tensao_bc: emCarga ? 379 + ruido(4) : 0,
      tensao_ca: emCarga ? 381 + ruido(4) : 0,
      corrente_a: emCarga ? (potencia * 1000) / (Math.sqrt(3) * 380 * 0.9) + ruido(6) : 0,
      corrente_b: emCarga ? (potencia * 1000) / (Math.sqrt(3) * 380 * 0.9) * 0.97 + ruido(6) : 0,
      corrente_c: emCarga ? (potencia * 1000) / (Math.sqrt(3) * 380 * 0.9) * 1.03 + ruido(6) : 0,
      frequencia: rodando ? (estado === 2 ? 30 + ruido(8) : 60 + ruido(0.2)) : 0,
      potencia,
      rotacao: rodando ? (estado === 2 ? 900 + ruido(200) : 1800 + ruido(12)) : 0,
      tensao_bateria: this.tensaoDaBateria(estado, ruido),
      pressao_oleo: rodando ? 4.2 + ruido(0.4) : 0,
      temperatura: rodando ? entre(60 + (fase - 184) * 0.7, 40, 88) + ruido(2) : 28 + ruido(2),
      nivel_diesel: nivel,
      horimetro: Math.floor(this.diesel.horimetro),
      estado,
      // código de modo do controlador configurado (genérico: 2 = teste; DSE: 3)
      modo: ensaio && fase >= 178 && fase < 234
        ? (this.config.gerador?.modos_teste?.[0] ?? 2)
        : (this.config.gerador?.modo_automatico ?? 1),
      disjuntor_fechado: emCarga ? 1 : 0,
      rede_presente: redeCaiu ? 0 : 1,
      falha_partida: 0,
      falha_sobrevelocidade: 0,
      falha_pressao_oleo: desarme ? 1 : 0,
      falha_temperatura: 0,
      falha_bateria: 0,
      falha_combustivel: nivel < 25 ? 1 : 0,
      falha_emergencia: 0,
      falha_carregador: 0,
      falha_sobrecarga: 0,
      falha_tensao: 0,
    };
  }

  /**
   * Tensão da bateria. O detalhe que importa é o arranque: o motor de partida
   * puxa centenas de ampères e a tensão despenca por alguns segundos. A
   * profundidade dessa queda é o que denuncia bateria no fim da vida, então a
   * simulação precisa reproduzi-la — sem isso o indicador não teria o que medir.
   *   parado com carregador bom  ~26,9 V
   *   arranque                   ~20,5 V (e pior a cada corrida, no roteiro)
   *   rodando, alternador        ~27,5 V
   */
  tensaoDaBateria(estado, ruido) {
    if (estado === 2) {
      const desgaste = this.roteiro ? Math.min(3.2, Math.floor(this.t / 240) * 0.45) : 0;
      return 20.5 - desgaste + ruido(0.4);
    }
    // no pré-aquecimento o motor ainda não gira: quem segura a tensão é o carregador
    if (estado >= 2 && estado <= 4) return 27.5 + ruido(0.2);
    return 26.9 + ruido(0.15);
  }

  /** A entrada geral tem que fechar com a soma dos alimentadores. */
  fecharEntrada(saida, idGeral) {
    const g = saida[idGeral];
    if (!g) return;
    const alimentadores = Object.values(saida).filter((x) => x.grupo === 'energia' && x.id !== idGeral);
    if (!alimentadores.length) return;
    const soma = (campo) => alimentadores.reduce((s, x) => s + (x.valores[campo] || 0), 0);

    for (const fase of ['corrente_a', 'corrente_b', 'corrente_c']) {
      if (g.valores[fase] !== undefined) g.valores[fase] = soma(fase);
    }
    const P = soma('potencia_ativa');
    const fp = g.valores.fp ?? 0.94;
    if (g.valores.potencia_ativa !== undefined) g.valores.potencia_ativa = P;
    if (g.valores.potencia_aparente !== undefined) g.valores.potencia_aparente = P / fp;
    if (g.valores.potencia_reativa !== undefined) {
      g.valores.potencia_reativa = Math.sqrt(Math.max(0, (P / fp) ** 2 - P ** 2));
    }
    if (g.valores.demanda !== undefined) g.valores.demanda = P * 0.97;
    if (g.valores.corrente_n !== undefined) {
      const { corrente_a: a = 0, corrente_b: b = 0, corrente_c: c = 0 } = g.valores;
      const media = (a + b + c) / 3;
      g.valores.corrente_n = (Math.abs(a - media) + Math.abs(b - media) + Math.abs(c - media)) * 0.9;
    }
    // THD da entrada a partir das harmônicas dos setores (soma aritmética:
    // pior caso, harmônicas todas em fase)
    for (const [f, tagThd] of [['a', 'thd_corrente'], ['b', 'thd_corrente_b'], ['c', 'thd_corrente_c']]) {
      const i = g.valores[`corrente_${f}`];
      if (g.valores[tagThd] === undefined || !i) continue;
      const ih = Math.min(soma(`corrente_harmonica_${f}`), i * 0.99);
      g.valores[tagThd] = (ih / Math.sqrt(i ** 2 - ih ** 2)) * 100;
    }
    preencherHarmonicas(g.valores);
  }

  encerrar() {}
}

/* O modo simulado responde às mesmas chamadas de engenharia do coletor real,
   para que a tela funcione igual em demonstração e em bancada. */
Object.assign(Simulador.prototype, {
  listarBarramentos() { return ['rtu:/dev/ttyUSB0 (simulado)']; },

  diagnostico() {
    return this.lista.map((m, i) => ({
      id: m.id,
      nome: m.nome,
      barramento: 'rtu:/dev/ttyUSB0 (simulado)',
      unit_id: m.conexao?.unit_id ?? i + 1,
      online: true,
      erro: null,
      lido_em: Date.now(),
      blocos: 2,
      requisicoes: 100 + this.t,
      falhas: 0,
      excecoes: 0,
      tempo_medio: 40 + (i % 5) * 7,
      tempo_max: 120 + (i % 3) * 30,
      taxa_falha: 0,
      ultima_falha: null,
    }));
  },

  zerarDiagnostico() {},
  async pausar() {},
  retomar() {},

  /** Mesmo contrato do coletor real: só o equipamento pedido. */
  async lerUm(id) {
    const leitura = await this.lerTodos();
    return leitura[id] ? { [id]: leitura[id] } : {};
  },

  async varrer({ de = 1, ate = 32, tipo = 'rtu', host = '' } = {}) {
    const achados = [];
    for (const m of this.lista) {
      const id = m.conexao?.unit_id;
      // a varredura simulada respeita o meio: quem está na serial não aparece
      // quando se procura na rede, como aconteceria em campo
      const meio = m.conexao?.tipo === 'tcp' ? 'tcp' : 'rtu';
      if (meio !== tipo) continue;
      if (tipo === 'tcp' && host && m.conexao?.host && m.conexao.host !== host) continue;
      if (id >= de && id <= ate) {
        achados.push({ unit_id: id, situacao: 'respondeu', ms: 30 + Math.round(Math.random() * 40), dados: [0, 0] });
      }
    }
    return achados;
  },

  async lerBruto({ unit_id, endereco = 0, quantidade = 8 }) {
    const eq = this.lista.find((m) => m.conexao?.unit_id === unit_id);
    if (!eq) throw new Error(`escravo ${unit_id} não respondeu (simulado)`);
    const leitura = await this.lerTodos();
    const valores = leitura[eq.id].valores;
    // devolve os registradores como o equipamento devolveria, a partir das tags
    const dados = new Array(quantidade).fill(0);
    const desloc = eq.padrao?.deslocamento_endereco ?? 0;   // endereço no fio, como o equipamento real
    for (const tag of eq.tags) {
      if (tag.calculada) continue;
      const i = tag.endereco + desloc - endereco;
      if (i < 0 || i >= quantidade) continue;
      const v = valores[tag.nome];
      if (v === undefined || v === null) continue;
      if (Number.isInteger(tag.bit)) { if (v >= 0.5) dados[i] |= (1 << tag.bit); continue; }
      const escala = tag.escala ?? 1;
      if ((tag.tipo || eq.padrao?.tipo) === 'float32') {
        const b = Buffer.alloc(4);
        b.writeFloatBE(v / escala, 0);
        // na ordem de palavras do equipamento (o 7KT0310 manda a palavra baixa primeiro)
        const cdab = (tag.ordem_palavras || eq.padrao?.ordem_palavras) === 'CDAB';
        dados[i] = b.readUInt16BE(cdab ? 2 : 0);
        if (i + 1 < quantidade) dados[i + 1] = b.readUInt16BE(cdab ? 0 : 2);
      } else {
        dados[i] = Math.round(v / escala) & 0xffff;
      }
    }
    return { dados, ms: 35 };
  },

  /**
   * Em bancada a escrita é aceita e reflete no estado simulado, senão não dá
   * para exercitar comando nenhum sem o equipamento na mesa.
   */
  /**
   * Escrita simulada. O efeito de cada comando é deduzido do próprio
   * `confirma_com` declarado no perfil: se o comando diz que confirma com
   * `disjuntor_ligado = 1`, é isso que o simulador passa a devolver. Assim a
   * bancada exercita o caminho completo sem código específico por equipamento.
   */
  async escreverBruto({ endereco, valor, valores }) {
    // com várias palavras (complemento, dois bits) o simulador faz o papel do
    // CLP: só obedece se o quadro inteiro bater com o declarado no comando
    const enviadas = valores || [valor];
    const cmd = this.lista
      .flatMap((m) => (m.comandos || []))
      .find((c) => c.endereco === endereco
        && JSON.stringify(palavrasDeclaradas(c)) === JSON.stringify(enviadas));

    const efeito = cmd?.confirma_com;
    if (efeito && Object.prototype.hasOwnProperty.call(this.estadoDigital, efeito.tag)) {
      // o painel leva um instante para responder, como no equipamento real
      const alvo = efeito.igual >= 0.5;
      setTimeout(() => {
        this.estadoDigital[efeito.tag] = alvo;
        // religou: o relé rearma e o registro de causa volta a zero
        if (efeito.tag === 'disjuntor_ligado' && alvo) {
          this.protecao.causa = 0;
          this.protecao.permite_religar = true;
        }
      }, 600);
    }
    // o eco que um escravo real devolveria (FC16: endereço e quantidade)
    return valores ? { address: endereco, length: valores.length } : { address: endereco, value: valor };
  },

  conexaoDe(id) {
    return this.lista.some((m) => m.id === id)
      ? { barramento: 'rtu:simulado', unit_id: this.lista.find((m) => m.id === id).conexao?.unit_id || 1 }
      : null;
  },
});

/* O simulador ignora o heartbeat: não há CLP para vigiar nada em bancada. */
Simulador.prototype.enviarHeartbeats = async function enviarHeartbeats() {};
