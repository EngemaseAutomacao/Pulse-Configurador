/**
 * Indicadores do grupo gerador.
 *
 * Um grupo gerador passa 99 % do tempo parado. O que interessa não é o valor
 * instantâneo — é saber se ele vai pegar quando a rede cair, e isso só se
 * responde com histórico:
 *
 *   prontidão        quanto do tempo o grupo esteve em condição de partir
 *                    (automático, sem falha, com diesel e com bateria)
 *   partidas         quantas houve e quantas falharam
 *   bateria          a tensão despenca durante o arranque; a profundidade dessa
 *                    queda, corrida após corrida, é o que denuncia bateria no
 *                    fim da vida ANTES de ela deixar a loja no escuro
 *   consumo medido   litros por hora reais, não os de catálogo
 *   autonomia        quantas horas ainda dá, no consumo medido
 *   dias sem partir   teste semanal é prática consagrada; o que não roda, falha
 *
 * O motor faz duas coisas por varredura:
 *   1. injeta tags calculadas no equipamento (pronto, autonomia_h, diesel_litros,
 *      dias_sem_teste) — assim histórico, alarmes, tendências e a tela as tratam
 *      como qualquer outra tag, sem código especial em lugar nenhum;
 *   2. acompanha a máquina de estados do grupo e grava uma linha por corrida.
 */

/** Tags que o supervisório calcula e acrescenta ao equipamento do gerador. */
export const TAGS_CALCULADAS = [
  {
    nome: 'pronto',
    rotulo: 'Pronto para partir',
    tipo: 'bool',
    calculada: true,
    severidade: 'info',
  },
  {
    nome: 'autonomia_h',
    rotulo: 'Autonomia estimada',
    unidade: 'h',
    calculada: true,
    decimais: 1,
  },
  {
    nome: 'diesel_litros',
    rotulo: 'Diesel no tanque',
    unidade: 'L',
    calculada: true,
    decimais: 0,
  },
  {
    nome: 'dias_sem_teste',
    rotulo: 'Dias desde a última partida',
    unidade: 'd',
    calculada: true,
    decimais: 1,
  },
];

const ESTADO = {
  PARADO: 0, PRE: 1, PARTINDO: 2, CARGA: 3, RESFRIANDO: 4, FALHA: 5,
};

const nulo = (v) => v === null || v === undefined || Number.isNaN(v);
const lig = (v) => !nulo(v) && v >= 0.5;

export class MotorGerador {
  /**
   * @param {object} cfg    seção `gerador` da configuração
   * @param {object} banco  Banco (ou equivalente) para gravar as corridas
   */
  constructor(cfg = {}, banco = null) {
    this.cfg = cfg || {};
    this.banco = banco;
    this.id = this.cfg.medidor;

    this.capacidade = this.cfg.capacidade_tanque_litros || 0;
    this.consumoNominal = this.cfg.consumo_litros_hora || 0;
    this.modoAutomatico = this.cfg.modo_automatico ?? 1;
    this.bateriaMinima = this.cfg.bateria_minima_v ?? 23;
    this.testeACada = this.cfg.teste_a_cada_dias ?? 7;
    // abaixo desta marca o grupo não é considerado pronto
    this.reserva = (this.cfg.marcas || [])
      .filter((m) => m.prioridade === 'alta')
      .reduce((menor, m) => Math.max(menor, m.valor), 0) || 0;
    this.falhas = this.cfg.falhas || [];

    this.corrida = null;    // { id, inicio, bateriaMinima, ... }
    this.anterior = null;   // última amostra vista, para integrar no tempo

    // uma corrida pode ter ficado aberta num desligamento do servidor
    const aberta = this.id ? banco?.corridaAberta?.(this.id) : null;
    if (aberta) {
      this.corrida = {
        id: aberta.id,
        inicio: aberta.inicio,
        motivo: aberta.motivo,
        bateriaRepouso: aberta.bateria_repouso,
        bateriaMinima: aberta.bateria_minima,
        tempoPartida: aberta.tempo_partida_s,
        kwh: aberta.kwh || 0,
        litros: aberta.litros || 0,
        picoKw: aberta.pico_kw || 0,
        nivelInicial: aberta.nivel_inicial,
        assumiu: aberta.tempo_partida_s !== null,
        recuperada: true,
      };
    }
  }

  /** Tensão de bateria considerada normal com o grupo parado e carregador bom. */
  get bateriaRepousoMinima() { return this.cfg.bateria_repouso_min_v ?? 25.5; }

  /* Limites da tensão durante o arranque (sistema de 24 V). Abaixo do primeiro
     a bateria já não tem folga; abaixo do segundo, o próximo arranque é loteria. */
  get bateriaPartidaMinima() { return this.cfg.bateria_partida_min_v ?? 20; }

  get bateriaPartidaCritica() { return this.cfg.bateria_partida_critica_v ?? 18; }

  /**
   * Chamado a cada varredura. Recebe o mapa de equipamentos e o instante;
   * devolve as tags calculadas (e as injeta no equipamento, para que sigam pelo
   * mesmo caminho das tags lidas).
   */
  avaliar(equipamentos, ts = Date.now()) {
    const eq = this.id ? equipamentos?.[this.id] : null;
    if (!eq) return null;
    if (!eq.online) { this.anterior = null; return null; }

    const v = eq.valores || {};
    const estado = nulo(v.estado) ? null : Math.round(v.estado);
    const nivel = nulo(v.nivel_diesel) ? null : v.nivel_diesel;
    const bateria = nulo(v.tensao_bateria) ? null : v.tensao_bateria;
    const potencia = nulo(v.potencia) ? 0 : v.potencia;

    const rodando = this.estaRodando(v, estado);
    this.acompanhar({
      ts, v, estado, nivel, bateria, potencia, rodando,
    });

    const litros = nivel === null || !this.capacidade ? null : (nivel / 100) * this.capacidade;
    const consumo = this.consumoMedido() || this.consumoNominal;
    const calculadas = {
      pronto: this.prontoParaPartir(eq, v, estado, nivel, bateria) ? 1 : 0,
      autonomia_h: litros === null || !consumo ? null : litros / consumo,
      diesel_litros: litros,
      dias_sem_teste: this.diasSemPartir(ts),
    };
    for (const [nome, valor] of Object.entries(calculadas)) {
      if (valor !== null) eq.valores[nome] = valor;
    }
    return calculadas;
  }

  /** Está girando? Confia no estado, mas aceita rotação como segunda opinião. */
  estaRodando(v, estado) {
    if (estado !== null) return estado >= ESTADO.PRE && estado <= ESTADO.RESFRIANDO;
    if (!nulo(v.rotacao)) return v.rotacao > 200;
    return lig(v.disjuntor_fechado);
  }

  /**
   * Prontidão: o grupo consegue partir agora?
   * É um E de condições — basta uma faltar para o grupo não ser confiável, e é
   * isso que a tela mostra em vez de dez números soltos.
   */
  prontoParaPartir(eq, v, estado, nivel, bateria) {
    if (!eq.online) return false;
    if (estado === ESTADO.FALHA) return false;
    if (!nulo(v.modo) && Math.round(v.modo) !== this.modoAutomatico) return false;
    if (this.falhas.some((f) => lig(v[f]))) return false;
    if (nivel !== null && this.reserva && nivel < this.reserva) return false;
    if (bateria !== null && bateria < this.bateriaMinima) return false;
    return true;
  }

  /** Máquina de estados das corridas. */
  acompanhar({
    ts, v, estado, nivel, bateria, potencia, rodando,
  }) {
    const antes = this.anterior;
    this.anterior = {
      ts, estado, nivel, bateria, rodando,
    };

    // Só abre corrida quando vê uma PARTIDA: parado -> pré-aquecendo/partindo.
    // Sem isso, um grupo que desarma e volta para "resfriando" abriria uma
    // segunda corrida fantasma, sem arranque, poluindo a contagem e a média de
    // bateria. A exceção é a primeira amostra depois de o servidor subir: aí a
    // corrida é registrada mesmo sem ter visto o arranque.
    const viuPartida = estado === null || estado <= ESTADO.PARTINDO || antes === null
      || (antes && !antes.rodando && antes.estado === ESTADO.PARADO);
    if (rodando && !this.corrida && viuPartida) {
      this.corrida = {
        inicio: ts,
        motivo: this.motivoDaPartida(v),
        bateriaRepouso: antes?.bateria ?? bateria,
        bateriaMinima: bateria,
        tempoPartida: null,
        kwh: 0,
        litros: 0,
        picoKw: 0,
        nivelInicial: nivel,
        assumiu: false,
      };
      this.corrida.id = this.banco?.abrirCorrida?.({
        medidor: this.id,
        inicio: ts,
        motivo: this.corrida.motivo,
        resultado: 'em andamento',
        bateria_repouso: this.corrida.bateriaRepouso ?? null,
        nivel_inicial: nivel,
      });
      return;
    }

    if (!this.corrida) return;
    const c = this.corrida;
    const dt = antes ? Math.min(60000, ts - antes.ts) / 1000 : 0;   // s, com teto

    if (rodando) {
      // a queda de bateria acontece no arranque; guarda-se o mínimo da corrida
      if (bateria !== null && (c.bateriaMinima === null || bateria < c.bateriaMinima)) {
        c.bateriaMinima = bateria;
      }
      if (!c.assumiu && (estado === ESTADO.CARGA || lig(v.disjuntor_fechado))) {
        c.assumiu = true;
        c.tempoPartida = (ts - c.inicio) / 1000;
      }
      if (potencia > 0 && dt) c.kwh += (potencia * dt) / 3600;
      if (potencia > c.picoKw) c.picoKw = potencia;
      if (nivel !== null && antes?.nivel != null && antes.nivel > nivel && this.capacidade) {
        c.litros += ((antes.nivel - nivel) / 100) * this.capacidade;
      }
      this.salvarParcial(c);
      return;
    }

    // parou: fecha a corrida e classifica o que aconteceu
    const falhaAtiva = this.falhas.find((f) => lig(v[f]));
    const resultado = c.assumiu
      ? (falhaAtiva ? `desarme por ${this.rotuloDaFalha(falhaAtiva)}` : 'normal')
      : (falhaAtiva ? `falha de partida (${this.rotuloDaFalha(falhaAtiva)})` : 'não assumiu carga');

    this.banco?.atualizarCorrida?.(c.id, {
      fim: ts,
      resultado,
      bateria_minima: c.bateriaMinima ?? null,
      tempo_partida_s: c.tempoPartida,
      duracao_s: (ts - c.inicio) / 1000,
      kwh: c.kwh,
      litros: c.litros,
      pico_kw: c.picoKw,
      nivel_final: nivel,
    });
    this.corrida = null;
  }

  motivoDaPartida(v) {
    if (!nulo(v.rede_presente) && !lig(v.rede_presente)) return 'queda de rede';
    // o código de cada modo é do controlador: no mapa genérico 2 é teste e 0 é
    // manual; no Deep Sea 3/6 são teste e 2 é manual. O perfil diz quais são
    const modo = nulo(v.modo) ? null : Math.round(v.modo);
    if (modo !== null && (this.cfg.modos_teste ?? [2]).includes(modo)) return 'teste';
    if (modo !== null && (this.cfg.modos_manual ?? [0]).includes(modo)) return 'partida manual';
    return 'exercício';
  }

  rotuloDaFalha(nome) {
    return String(nome).replace(/^falha_/, '').replace(/_/g, ' ');
  }

  /** Grava o andamento de tempos em tempos, para não perder tudo num tombo. */
  salvarParcial(c) {
    if (!this.banco?.atualizarCorrida || !c.id) return;
    const agora = Date.now();
    if (c._salvoEm && agora - c._salvoEm < 30000) return;
    c._salvoEm = agora;
    this.banco.atualizarCorrida(c.id, {
      bateria_minima: c.bateriaMinima ?? null,
      tempo_partida_s: c.tempoPartida,
      kwh: c.kwh,
      litros: c.litros,
      pico_kw: c.picoKw,
      duracao_s: (agora - c.inicio) / 1000,
    });
  }

  /** L/h realmente medidos nas corridas com consumo e duração confiáveis. */
  consumoMedido(dias = 180) {
    if (!this.banco?.corridas || !this.id) return null;
    const lista = this.banco.corridas(this.id, Date.now() - dias * 86400000, 400)
      .filter((c) => c.duracao_s > 600 && c.litros > 0);
    if (!lista.length) return null;
    const horas = lista.reduce((s, c) => s + c.duracao_s / 3600, 0);
    const litros = lista.reduce((s, c) => s + c.litros, 0);
    return horas > 0.25 ? litros / horas : null;
  }

  diasSemPartir(ts = Date.now()) {
    if (this.corrida) return 0;
    const ultima = this.banco?.ultimaCorrida?.(this.id);
    if (!ultima) return null;
    return Math.max(0, (ts - (ultima.fim || ultima.inicio)) / 86400000);
  }

  /**
   * Resumo do período para a tela e para relatório.
   * Tudo que um gestor de manutenção pergunta numa reunião.
   */
  indicadores(dias = 30, ts = Date.now()) {
    const desde = ts - dias * 86400000;
    const corridas = this.banco?.corridas ? this.banco.corridas(this.id, desde, 500) : [];
    const fechadas = corridas.filter((c) => c.fim);
    const comCarga = fechadas.filter((c) => c.tempo_partida_s !== null);
    const falhas = fechadas.filter((c) => /falha de partida|não assumiu/.test(c.resultado || ''));

    const soma = (campo, lista = fechadas) => lista.reduce((s, c) => s + (c[campo] || 0), 0);
    const media = (campo, lista) => {
      const vals = lista.map((c) => c[campo]).filter((x) => x !== null && x !== undefined);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const horas = soma('duracao_s') / 3600;
    const litros = soma('litros');
    const prontidao = this.banco?.mediaDaTag
      ? this.banco.mediaDaTag(`${this.id}.pronto`, desde, ts)
      : null;

    const ultima = corridas[0] || this.banco?.ultimaCorrida?.(this.id) || null;
    const quedas = fechadas
      .filter((c) => c.bateria_repouso != null && c.bateria_minima != null)
      .map((c) => ({
        ts: c.inicio,
        repouso: c.bateria_repouso,
        minima: c.bateria_minima,
        queda: c.bateria_repouso - c.bateria_minima,
      }));

    return {
      medidor: this.id,
      dias,
      partidas: fechadas.length + (this.corrida ? 1 : 0),
      falhas_de_partida: falhas.length,
      taxa_sucesso: fechadas.length ? (fechadas.length - falhas.length) / fechadas.length : null,
      horas_operacao: horas,
      energia_kwh: soma('kwh'),
      litros_consumidos: litros,
      consumo_medido_lh: horas > 0.25 ? litros / horas : null,
      consumo_nominal_lh: this.consumoNominal || null,
      tempo_medio_partida_s: media('tempo_partida_s', comCarga),
      pico_kw: fechadas.reduce((m, c) => Math.max(m, c.pico_kw || 0), 0) || null,
      prontidao: prontidao ? prontidao.media * 100 : null,
      dias_sem_partir: this.diasSemPartir(ts),
      teste_a_cada_dias: this.testeACada,
      em_corrida: !!this.corrida,
      bateria: {
        repouso_minimo_v: this.bateriaRepousoMinima,
        limite_v: this.bateriaPartidaMinima,
        limite_critico_v: this.bateriaPartidaCritica,
        ultima_queda: quedas[0] || null,
        queda_media: quedas.length
          ? quedas.reduce((s, q) => s + q.queda, 0) / quedas.length : null,
        pior_minima: quedas.length ? Math.min(...quedas.map((q) => q.minima)) : null,
        historico: quedas.slice(0, 20).reverse(),
      },
      ultima_corrida: ultima ? {
        inicio: ultima.inicio,
        fim: ultima.fim,
        motivo: ultima.motivo,
        resultado: ultima.resultado,
        duracao_s: ultima.duracao_s,
        tempo_partida_s: ultima.tempo_partida_s,
        bateria_minima: ultima.bateria_minima,
        kwh: ultima.kwh,
      } : null,
      corridas: corridas.slice(0, 20).map((c) => ({
        inicio: c.inicio,
        fim: c.fim,
        motivo: c.motivo,
        resultado: c.resultado,
        duracao_s: c.duracao_s,
        tempo_partida_s: c.tempo_partida_s,
        bateria_repouso: c.bateria_repouso,
        bateria_minima: c.bateria_minima,
        kwh: c.kwh,
        litros: c.litros,
      })),
    };
  }
}
