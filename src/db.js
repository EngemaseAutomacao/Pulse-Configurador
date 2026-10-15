import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export class Banco {
  constructor(arquivo) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    this.db = new Database(arquivo);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS amostras (
        ts INTEGER NOT NULL,
        tag TEXT NOT NULL,
        valor REAL
      );
      CREATE INDEX IF NOT EXISTS idx_amostras ON amostras (tag, ts);

      CREATE TABLE IF NOT EXISTS alarmes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL,
        mensagem TEXT NOT NULL,
        prioridade TEXT NOT NULL,
        valor REAL,
        limite TEXT,
        inicio INTEGER NOT NULL,
        fim INTEGER,
        reconhecido INTEGER DEFAULT 0,
        reconhecido_em INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alarmes ON alarmes (inicio DESC);

      /* Uma linha por corrida do grupo gerador: da partida até parar.
         É daqui que saem os indicadores — partidas, falhas de partida, horas,
         energia gerada, consumo medido e a queda de bateria no arranque. */
      CREATE TABLE IF NOT EXISTS gerador_corridas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medidor TEXT NOT NULL,
        inicio INTEGER NOT NULL,
        fim INTEGER,
        motivo TEXT,
        resultado TEXT,
        bateria_repouso REAL,
        bateria_minima REAL,
        tempo_partida_s REAL,
        duracao_s REAL,
        kwh REAL DEFAULT 0,
        litros REAL DEFAULT 0,
        pico_kw REAL DEFAULT 0,
        nivel_inicial REAL,
        nivel_final REAL
      );
      CREATE INDEX IF NOT EXISTS idx_corridas ON gerador_corridas (medidor, inicio DESC);

      /* Consumo de energia por hora fechada, por medidor e por grandeza
         ('ativa' em kWh, 'aparente' em kVAh — a coluna kwh guarda o valor na
         unidade da grandeza). Consolidado do histórico bruto (que é apagado
         depois de alguns dias); fica para sempre — 24 linhas por medidor por dia. */
      CREATE TABLE IF NOT EXISTS consumo_horario (
        medidor TEXT NOT NULL,
        grandeza TEXT NOT NULL DEFAULT 'ativa',
        hora INTEGER NOT NULL,
        kwh REAL NOT NULL,
        fonte TEXT NOT NULL,
        PRIMARY KEY (medidor, grandeza, hora)
      );

      /* Histórico longo: média, mínimo e máximo de cada 5 min, por grandeza.
         Resumido das amostras de 15 s (resumirAmostras) e usado pelos gráficos
         de vários dias — 20 vezes menor, e a consulta não segura o servidor.
         Continua existindo depois que a amostra bruta daquele dia sai. */
      CREATE TABLE IF NOT EXISTS resumo_5min (
        tag TEXT NOT NULL,
        ts INTEGER NOT NULL,
        med REAL,
        min REAL,
        max REAL,
        n INTEGER NOT NULL,
        PRIMARY KEY (tag, ts)
      ) WITHOUT ROWID;

      /* Marcadores de progresso (ex.: até onde o resumo de 5 min já foi feito). */
      CREATE TABLE IF NOT EXISTS marcas (
        nome TEXT PRIMARY KEY,
        valor INTEGER
      );
    `);
    // banco de antes da energia aparente: a tabela não tinha a grandeza. O
    // SQLite não troca chave primária com ALTER, então a tabela é refeita com o
    // que já estava gravado marcado como energia ativa
    const colunas = this.db.prepare('PRAGMA table_info(consumo_horario)').all();
    if (!colunas.some((c) => c.name === 'grandeza')) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE consumo_horario_novo (
            medidor TEXT NOT NULL,
            grandeza TEXT NOT NULL DEFAULT 'ativa',
            hora INTEGER NOT NULL,
            kwh REAL NOT NULL,
            fonte TEXT NOT NULL,
            PRIMARY KEY (medidor, grandeza, hora)
          );
          INSERT INTO consumo_horario_novo (medidor, grandeza, hora, kwh, fonte)
            SELECT medidor, 'ativa', hora, kwh, fonte FROM consumo_horario;
          DROP TABLE consumo_horario;
          ALTER TABLE consumo_horario_novo RENAME TO consumo_horario;
        `);
      })();
    }
    this.inserir = this.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)');
    // tudo por grandeza: o índice (tag, ts) responde na hora, sem varrer a tabela inteira
    this.inicioDaTag = this.db.prepare('SELECT MIN(ts) AS ts FROM amostras WHERE tag = ?');
    this.inicioDoResumoDaTag = this.db.prepare('SELECT MIN(ts) AS ts FROM resumo_5min WHERE tag = ?');
    this.resumirTag = this.db.prepare(`
      INSERT OR REPLACE INTO resumo_5min (tag, ts, med, min, max, n)
      SELECT tag, ts - (ts % ?) AS j, AVG(valor), MIN(valor), MAX(valor), COUNT(valor)
      FROM amostras
      WHERE tag = ? AND ts >= ? AND ts < ? AND valor IS NOT NULL
      GROUP BY j
    `);
    this.gravarLote = this.db.transaction((ts, pares) => {
      for (const [tag, valor] of pares) this.inserir.run(ts, tag, valor);
    });
  }

  gravarAmostras(ts, medidores) {
    const pares = [];
    for (const m of Object.values(medidores)) {
      if (!m.online) continue;
      for (const [tag, valor] of Object.entries(m.valores)) {
        if (valor !== null && valor !== undefined) pares.push([`${m.id}.${tag}`, valor]);
      }
    }
    if (pares.length) this.gravarLote(ts, pares);
  }

  /**
   * Série agregada em janelas fixas — evita mandar 100 mil pontos para o navegador.
   * O início da janela sai com % (o SQLite converte os dois lados para inteiro):
   * com "(ts / ?) * ?" o número do JavaScript entra como REAL, a divisão não
   * trunca e cada amostra virava a própria janela — 30 dias de uma grandeza
   * chegavam ao navegador como 172 mil pontos em vez de 240.
   */
  consultarSerie(tag, de, ate, pontos = 240) {
    const janela = Math.max(1000, Math.floor((ate - de) / pontos));
    // vários dias (janela de 30 min ou mais): vem do resumo de 5 min, que é 20
    // vezes menor — desde que o resumo já tenha alcançado o fim do período
    // (logo depois da atualização ele ainda está sendo montado)
    const resumoAte = this.marca('resumo_ate');
    if (janela >= 30 * 60000 && resumoAte !== null && resumoAte >= ate - 3600000) {
      return this.db.prepare(`
        SELECT ts - (ts % ?) AS t,
               SUM(med * n) / SUM(n) AS med,
               MIN(min) AS min,
               MAX(max) AS max
        FROM resumo_5min
        WHERE tag = ? AND ts BETWEEN ? AND ?
        GROUP BY t
        ORDER BY t
      `).all(janela, tag, de, ate);
    }
    return this.db.prepare(`
      SELECT ts - (ts % ?) AS t,
             AVG(valor) AS med,
             MIN(valor) AS min,
             MAX(valor) AS max
      FROM amostras
      WHERE tag = ? AND ts BETWEEN ? AND ?
      GROUP BY t
      ORDER BY t
    `).all(janela, tag, de, ate);
  }

  abrirAlarme(a) {
    return this.db.prepare(`
      INSERT INTO alarmes (tag, mensagem, prioridade, valor, limite, inicio)
      VALUES (@tag, @mensagem, @prioridade, @valor, @limite, @inicio)
    `).run(a).lastInsertRowid;
  }

  fecharAlarme(id, fim) {
    this.db.prepare('UPDATE alarmes SET fim = ? WHERE id = ? AND fim IS NULL').run(fim, id);
  }

  atualizarValorAlarme(id, valor) {
    this.db.prepare('UPDATE alarmes SET valor = ? WHERE id = ?').run(valor, id);
  }

  reconhecerAlarme(id, quando) {
    this.db.prepare('UPDATE alarmes SET reconhecido = 1, reconhecido_em = ? WHERE id = ?').run(quando, id);
  }

  reconhecerTodos(quando) {
    this.db.prepare('UPDATE alarmes SET reconhecido = 1, reconhecido_em = ? WHERE reconhecido = 0').run(quando);
  }

  alarmesAtivos() {
    return this.db.prepare('SELECT * FROM alarmes WHERE fim IS NULL ORDER BY inicio DESC').all();
  }

  historicoAlarmes(limite = 200) {
    return this.db.prepare('SELECT * FROM alarmes ORDER BY inicio DESC LIMIT ?').all(limite);
  }

  /**
   * Limpeza por idade. Sem `dias` (o padrão), o histórico bruto não tem prazo:
   * fica até o disco apertar, e quem apaga é a conferência de espaço do
   * servidor (apagarMaisAntigo), um dia por vez. Com `dias`, é um teto. O que é
   * pequeno e alimenta indicador de longo prazo tem prazo próprio:
   *   - prontidão do gerador (`*.pronto`): 120 dias, cobre o indicador de 90;
   *   - histórico de alarmes: 1 ano (ou `dias`, se maior);
   *   - corridas do gerador: 2 anos — tendência da bateria, consumo medido;
   *   - consumo por hora (consumo_horario): nunca é apagado.
   */
  limparAntigos(dias = null, agora = Date.now()) {
    const dia = 86400000;
    if (dias) {
      this.db.prepare("DELETE FROM amostras WHERE ts < ? AND tag NOT LIKE '%.pronto'").run(agora - dias * dia);
    }
    this.db.prepare("DELETE FROM amostras WHERE ts < ? AND tag LIKE '%.pronto'")
      .run(agora - Math.max(dias || 0, 120) * dia);
    this.db.prepare('DELETE FROM alarmes WHERE fim IS NOT NULL AND fim < ?').run(agora - Math.max(dias || 0, 365) * dia);
    this.db.prepare('DELETE FROM gerador_corridas WHERE fim IS NOT NULL AND fim < ?')
      .run(agora - Math.max((dias || 0) * 2, 730) * dia);
  }

  /**
   * Espaço já reservado pelo arquivo e livre por dentro (páginas de linhas
   * apagadas). O SQLite não devolve esse espaço ao disco: ele é reaproveitado
   * pelas gravações seguintes, e por isso conta como "livre" para o histórico.
   */
  livreNoArquivo() {
    return this.db.pragma('freelist_count', { simple: true }) * this.db.pragma('page_size', { simple: true });
  }

  /** Mais antigo entre as grandezas dadas (pelo índice), ou null se não há nada. */
  maisAntigo(consulta, tags) {
    let min = null;
    for (const t of tags) {
      const ts = consulta.get(t)?.ts;
      if (ts !== null && ts !== undefined && (min === null || ts < min)) min = ts;
    }
    return min;
  }

  /**
   * Início do histórico bruto. Com a lista de grandezas, uma consulta rápida
   * por grandeza; sem ela, varre a tabela (lento com o banco grande).
   */
  inicioDoHistorico(tags = null) {
    if (tags?.length) return this.maisAntigo(this.inicioDaTag, tags);
    return this.db.prepare('SELECT MIN(ts) AS ts FROM amostras').get()?.ts ?? null;
  }

  /**
   * Disco apertado: apaga o dia mais antigo do histórico bruto, sem nunca
   * descer abaixo de `minimoDias` (o consumo por hora é consolidado das últimas
   * 48 h). Devolve quantas linhas saíram — 0 quando já está no mínimo.
   */
  apagarMaisAntigo(horas = 24, minimoDias = 3, agora = Date.now(), tags = null) {
    const inicio = this.inicioDoHistorico(tags);
    if (inicio === null) return 0;
    const corte = Math.min(inicio + horas * 3600000, agora - minimoDias * 86400000);
    if (corte <= inicio) return 0;
    if (!tags?.length) return this.db.prepare('DELETE FROM amostras WHERE ts < ?').run(corte).changes;
    const apagar = this.db.prepare('DELETE FROM amostras WHERE tag = ? AND ts < ?');
    return this.db.transaction(() => tags.reduce((s, t) => s + apagar.run(t, corte).changes, 0))();
  }

  /**
   * Bruto já no mínimo e o disco ainda apertado: sai o dia mais antigo do
   * resumo de 5 min, sem descer abaixo de `minimoDias` de resumo.
   */
  apagarResumoMaisAntigo(tags, horas = 24, minimoDias = 30, agora = Date.now()) {
    const inicio = this.maisAntigo(this.inicioDoResumoDaTag, tags);
    if (inicio === null) return 0;
    const corte = Math.min(inicio + horas * 3600000, agora - minimoDias * 86400000);
    if (corte <= inicio) return 0;
    const apagar = this.db.prepare('DELETE FROM resumo_5min WHERE tag = ? AND ts < ?');
    return this.db.transaction(() => tags.reduce((s, t) => s + apagar.run(t, corte).changes, 0))();
  }

  marca(nome) {
    return this.db.prepare('SELECT valor FROM marcas WHERE nome = ?').get(nome)?.valor ?? null;
  }

  gravarMarca(nome, valor) {
    this.db.prepare('INSERT OR REPLACE INTO marcas (nome, valor) VALUES (?, ?)').run(nome, valor);
  }

  /**
   * Resume em médias de 5 min as janelas já fechadas, de onde parou até agora,
   * no máximo `maxHoras` por chamada (a primeira vez, com semanas de bruto, vai
   * em partes para não segurar o servidor). Devolve true quando está em dia.
   */
  resumirAmostras(tags, agora = Date.now(), maxHoras = 2) {
    const J = 300000;
    // janela fechada: passou do fim e mais 1 min de folga para a última gravação
    const fim = Math.floor((agora - 60000) / J) * J;
    let inicio = this.marca('resumo_ate');
    if (inicio === null) {
      const primeiro = this.inicioDoHistorico(tags);
      if (primeiro === null) return true;
      inicio = primeiro - (primeiro % J);
    }
    if (inicio >= fim) return true;
    const ate = Math.min(fim, inicio + maxHoras * 3600000);
    this.db.transaction(() => {
      for (const tag of tags) this.resumirTag.run(J, tag, inicio, ate);
      this.gravarMarca('resumo_ate', ate);
    })();
    return ate >= fim;
  }

  /* --------------------------------------------------- corridas do gerador */

  abrirCorrida(c) {
    return this.db.prepare(`
      INSERT INTO gerador_corridas
        (medidor, inicio, motivo, resultado, bateria_repouso, nivel_inicial)
      VALUES (@medidor, @inicio, @motivo, @resultado, @bateria_repouso, @nivel_inicial)
    `).run(c).lastInsertRowid;
  }

  atualizarCorrida(id, campos) {
    const chaves = Object.keys(campos);
    if (!chaves.length) return;
    this.db.prepare(`UPDATE gerador_corridas SET ${chaves.map((k) => `${k} = @${k}`).join(', ')}
                     WHERE id = @id`).run({ ...campos, id });
  }

  corridaAberta(medidor) {
    return this.db.prepare(`SELECT * FROM gerador_corridas
                            WHERE medidor = ? AND fim IS NULL ORDER BY inicio DESC LIMIT 1`).get(medidor);
  }

  corridas(medidor, desde, limite = 200) {
    return this.db.prepare(`SELECT * FROM gerador_corridas
                            WHERE medidor = ? AND inicio >= ?
                            ORDER BY inicio DESC LIMIT ?`).all(medidor, desde, limite);
  }

  ultimaCorrida(medidor) {
    return this.db.prepare(`SELECT * FROM gerador_corridas
                            WHERE medidor = ? ORDER BY inicio DESC LIMIT 1`).get(medidor);
  }

  /* ------------------------------------------------------- consumo por hora */

  /** Amostras brutas de uma tag, em ordem de tempo. */
  amostrasEntre(tag, de, ate) {
    return this.db.prepare('SELECT ts, valor FROM amostras WHERE tag = ? AND ts BETWEEN ? AND ? ORDER BY ts')
      .all(tag, de, ate);
  }

  /** Média e quantidade de amostras por hora, a partir de `de` (início de hora). */
  mediaPorHora(tag, de, ate) {
    const linhas = this.db.prepare(`
      SELECT ? + CAST((ts - ?) / 3600000 AS INTEGER) * 3600000 AS hora, AVG(valor) AS media, COUNT(*) AS amostras
      FROM amostras WHERE tag = ? AND ts >= ? AND ts < ?
      GROUP BY hora
    `).all(de, de, tag, de, ate);
    return new Map(linhas.map((l) => [l.hora, { media: l.media, amostras: l.amostras }]));
  }

  consumoGravado(medidor, de, ate, grandeza = 'ativa') {
    return this.db.prepare(`SELECT hora, kwh, fonte FROM consumo_horario
                            WHERE medidor = ? AND grandeza = ? AND hora >= ? AND hora < ? ORDER BY hora`)
      .all(medidor, grandeza, de, ate);
  }

  gravarConsumo(linhas) {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO consumo_horario (medidor, grandeza, hora, kwh, fonte)
                                 VALUES (@medidor, @grandeza, @hora, @kwh, @fonte)`);
    this.db.transaction((ls) => { for (const l of ls) ins.run({ grandeza: 'ativa', ...l }); })(linhas);
  }

  /** Média de uma tag no período — usada para prontidão (tag 0/1 vira %). */
  mediaDaTag(tag, de, ate) {
    const r = this.db.prepare(`SELECT AVG(valor) m, COUNT(*) n FROM amostras
                               WHERE tag = ? AND ts BETWEEN ? AND ?`).get(tag, de, ate);
    return r.n ? { media: r.m, amostras: r.n } : null;
  }
}

/* ------------------------------------------------------------------ acesso
   Usuários, sessões e trilha de auditoria. Fica no mesmo SQLite do histórico:
   um arquivo só para copiar, fazer backup e restaurar.                      */

export function prepararAcesso(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      nome TEXT NOT NULL,
      papel TEXT NOT NULL,
      hash TEXT NOT NULL,
      sal TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      trocar_senha INTEGER NOT NULL DEFAULT 0,
      criado_em INTEGER NOT NULL,
      ultimo_acesso INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL,
      criada_em INTEGER NOT NULL,
      expira_em INTEGER NOT NULL,
      origem TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessoes_exp ON sessoes (expira_em);
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      usuario TEXT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      origem TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auditoria ON auditoria (ts DESC);
  `);
}

Object.assign(Banco.prototype, {
  usuarioPorLogin(login) {
    return this.db.prepare('SELECT * FROM usuarios WHERE login = ? AND ativo = 1').get(login);
  },
  usuarioPorId(id) {
    return this.db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(id);
  },
  listarUsuarios() {
    return this.db.prepare(`SELECT id, login, nome, papel, ativo, trocar_senha, criado_em, ultimo_acesso
                            FROM usuarios ORDER BY login`).all();
  },
  criarUsuario(u) {
    return this.db.prepare(`INSERT INTO usuarios (login, nome, papel, hash, sal, trocar_senha, criado_em)
      VALUES (@login, @nome, @papel, @hash, @sal, @trocar_senha, @criado_em)`).run(u).lastInsertRowid;
  },
  atualizarUsuario(id, campos) {
    const chaves = Object.keys(campos);
    if (!chaves.length) return;
    this.db.prepare(`UPDATE usuarios SET ${chaves.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...campos, id });
  },
  contarAdmins() {
    return this.db.prepare("SELECT COUNT(*) n FROM usuarios WHERE papel = 'admin' AND ativo = 1").get().n;
  },

  criarSessao(s) {
    this.db.prepare(`INSERT INTO sessoes (token, usuario_id, criada_em, expira_em, origem)
                     VALUES (@token, @usuario_id, @criada_em, @expira_em, @origem)`).run(s);
  },
  sessao(token) {
    return this.db.prepare('SELECT * FROM sessoes WHERE token = ? AND expira_em > ?').get(token, Date.now());
  },
  encerrarSessao(token) {
    this.db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
  },
  encerrarSessoesDoUsuario(id) {
    this.db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  },
  limparSessoesVencidas() {
    this.db.prepare('DELETE FROM sessoes WHERE expira_em <= ?').run(Date.now());
  },

  registrar(acao, detalhe, usuario, origem) {
    this.db.prepare('INSERT INTO auditoria (ts, usuario, acao, detalhe, origem) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), usuario || null, acao, detalhe || null, origem || null);
  },
  auditoria(limite = 200) {
    return this.db.prepare('SELECT * FROM auditoria ORDER BY ts DESC LIMIT ?').all(limite);
  },
});
