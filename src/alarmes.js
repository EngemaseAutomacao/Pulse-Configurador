/**
 * Motor de alarmes.
 *
 * Tipos de regra:
 *   analógica  { tag, min?, max? }        — fora de faixa
 *   digital    { tag, digital, inverso? } — bit em 1 (ou em 0, se inverso)
 *   comunicação{ medidor, comunicacao }   — equipamento sem resposta
 *
 * Recursos: banda morta de 1% (analógicas) e atraso de confirmação (atraso_s),
 * que evitam alarme piscando no limite e ruído de leitura.
 */
export class MotorAlarmes {
  constructor(regras, banco) {
    this.banco = banco;
    this.regras = regras.map((r, i) => ({
      ...r,
      chave: r.chave || `${r.tag || r.medidor}#${i}`,
      banda: r.banda ?? 0.01,
      atrasoMs: (r.atraso_s ?? 0) * 1000,
      prioridade: r.prioridade || 'media',
    }));
    this.ativos = new Map();     // chave da regra -> id no banco
    this.pendentes = new Map();  // chave da regra -> instante em que a condição apareceu

    // reconcilia com o que ficou aberto no banco antes de um reinício
    for (const a of banco.alarmesAtivos()) {
      const regra = this.regras.find((r) => (r.tag || r.medidor) === a.tag && r.mensagem === a.mensagem);
      if (regra && !this.ativos.has(regra.chave)) this.ativos.set(regra.chave, a.id);
      else banco.fecharAlarme(a.id, Date.now());
    }
  }

  /** Avalia a condição bruta da regra. Devolve { violado, valor } ou null se não dá para julgar. */
  julgar(regra, equipamentos, jaAtivo) {
    if (regra.comunicacao) {
      const eq = equipamentos[regra.medidor];
      if (!eq) return null;
      return { violado: !eq.online, valor: eq.online ? 1 : 0 };
    }

    const [id, nome] = String(regra.tag).split('.');
    const eq = equipamentos[id];
    if (!eq || !eq.online) return null;            // sem dado: quem alarma é a regra de comunicação
    const valor = eq.valores[nome];
    if (valor === null || valor === undefined) return null;

    if (regra.digital) {
      const ligado = valor >= 0.5;
      return { violado: regra.inverso ? !ligado : ligado, valor };
    }

    // histerese: para sair do alarme é preciso voltar 1% para dentro da faixa.
    // Em faixa estreita (frequência 59,5–60,5 Hz) 1% do limite é 0,6 Hz: as duas
    // folgas se cruzariam e o alarme nunca mais fecharia. Cada folga fica no
    // máximo em 1/4 da largura da faixa
    const largura = regra.min !== undefined && regra.max !== undefined ? regra.max - regra.min : Infinity;
    const folgaMin = regra.min !== undefined ? Math.min(Math.abs(regra.min * regra.banda), largura / 4) : 0;
    const folgaMax = regra.max !== undefined ? Math.min(Math.abs(regra.max * regra.banda), largura / 4) : 0;
    const violado = jaAtivo
      ? (regra.min !== undefined && valor < regra.min + folgaMin)
        || (regra.max !== undefined && valor > regra.max - folgaMax)
      : (regra.min !== undefined && valor < regra.min)
        || (regra.max !== undefined && valor > regra.max);
    return { violado, valor };
  }

  textoLimite(regra) {
    if (regra.comunicacao) return 'sem resposta';
    if (regra.digital) return regra.inverso ? 'esperado ligado' : 'esperado desligado';
    return [
      regra.min !== undefined ? `mín ${regra.min}` : null,
      regra.max !== undefined ? `máx ${regra.max}` : null,
    ].filter(Boolean).join(' · ');
  }

  avaliar(equipamentos, ts = Date.now()) {
    for (const regra of this.regras) {
      const idAtivo = this.ativos.get(regra.chave);
      const jaAtivo = idAtivo !== undefined;
      const juizo = this.julgar(regra, equipamentos, jaAtivo);
      if (!juizo) { this.pendentes.delete(regra.chave); continue; }
      const { violado, valor } = juizo;

      if (violado && !jaAtivo) {
        // atraso de confirmação: a condição precisa se manter por atraso_s
        const desde = this.pendentes.get(regra.chave) ?? ts;
        this.pendentes.set(regra.chave, desde);
        if (ts - desde < regra.atrasoMs) continue;
        this.pendentes.delete(regra.chave);
        this.ativos.set(regra.chave, this.banco.abrirAlarme({
          tag: regra.tag || regra.medidor,
          mensagem: regra.mensagem,
          prioridade: regra.prioridade,
          valor,
          limite: this.textoLimite(regra),
          inicio: ts,
        }));
      } else if (!violado && jaAtivo) {
        this.pendentes.delete(regra.chave);
        this.banco.fecharAlarme(idAtivo, ts);
        this.ativos.delete(regra.chave);
      } else if (violado && jaAtivo) {
        this.banco.atualizarValorAlarme(idAtivo, valor);
      } else {
        this.pendentes.delete(regra.chave);
      }
    }
    return this.banco.alarmesAtivos();
  }
}
