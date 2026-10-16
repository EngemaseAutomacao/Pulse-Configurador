/**
 * Envio para a nuvem (Engemase Pulse) — vai em src/nuvem.js do Pulse Configurador
 * (o antigo Painel), instalado no gateway de cada unidade. Versão 3.
 *
 * O configurador continua sendo a referência na unidade: lê o Modbus, guarda o
 * histórico, calcula alarmes e consumo, e funciona sem internet. Este módulo só
 * COPIA para a nuvem, por HTTPS e sempre saindo da unidade (nenhuma porta aberta):
 *
 *  - a cada `intervalo_s` (padrão 10 s): a última varredura, com os valores atuais,
 *    e a lista dos alarmes ativos (a nuvem abre, fecha e notifica no celular; o
 *    que for reconhecido na nuvem volta na resposta e é reconhecido aqui);
 *  - a cada minuto: o que falta enviar do resumo de 5 min (energia, água e
 *    gerador), do consumo por hora, dos alarmes encerrados (fim exato, inclusive
 *    os que abriram e fecharam com a internet fora) e das corridas do gerador.
 *
 * Módulos: a unidade diz à nuvem quais usa ("energia", "agua", "gerador") e o
 * Pulse liga as telas sozinho. Sem a chave `modulos`, vale o que estiver
 * configurado aqui: energia se houver medidor de energia, água se houver
 * reservatório, gerador se houver grupo gerador. Junto da lista de equipamentos
 * vão os parâmetros do reservatório e do gerador (capacidade, tanque, consumo,
 * potência) e o rótulo/unidade das tags, para a nuvem mostrar igual à tela daqui.
 *
 * O próprio banco do gateway é a fila. Duas marcas dizem até onde a nuvem já
 * confirmou (só avançam depois de um HTTP 200):
 *  - `nuvem_resumo_ate`: janelas de 5 min antes deste instante já foram (as
 *    janelas antes de `resumo_ate` não mudam mais, então nada se perde);
 *  - `nuvem_consumo_rowid`: linhas de consumo_horario até este rowid já foram
 *    (o consolidar só INSERE horas novas, então o rowid só cresce — inclusive
 *    quando uma hora antiga é consolidada depois de o servidor ficar parado);
 *  - `nuvem_alarmes_fim` / `nuvem_alarmes_id`: alarmes encerrados até este fim
 *    (e id, para empates) já foram;
 *  - `nuvem_corridas_id`: corridas do gerador até este id, já encerradas, já
 *    foram (a que está em andamento vai de novo a cada minuto até terminar).
 * Internet caiu: quando voltar, o atraso vai em lotes, sem intervenção.
 *
 * Ligação: na interface (Engenharia → Nuvem), o técnico cola o endereço e o
 * token gerado no Pulse; eles ficam em dados/nuvem-<configuração>.json (fora do
 * config.json e do Git) e valem por cima da seção da configuração. Também dá
 * para pôr direto no config.json do gateway:
 *   "nuvem": { "url": "https://engemase-pulse.vercel.app", "token": "pnl_…" }
 * Opcionais: "intervalo_s": 10, "historico_inicial_dias": 7 (quanto do resumo de
 * 5 min já gravado sobe no primeiro envio; o consumo por hora sobe inteiro) e
 * "modulos": ["energia", "agua", "gerador"] (o que o Pulse deve mostrar).
 *
 * Sem dependências: só Node 20+ (fetch nativo). Ligação no server.js: LEIAME.md.
 */

import fs from 'node:fs';
import path from 'node:path';

const PRAZO_MS = 15000;
const J = 300000;                 // janela do resumo (5 min)
const FATIA_RESUMO_MS = 6 * 3600000; // resumo enviado em fatias de 6 h
const LOTE_CONSUMO = 2000;
const MAX_LOTES_POR_RODADA = 30;  // em atraso, até 30 lotes seguidos por minuto
const LOTE_ALARMES = 200;
const LOTE_CORRIDAS = 200;
const MODULOS = ['energia', 'agua', 'gerador'];
/** Grupos de equipamento que a nuvem entende; os demais (subestação, CLP…) ficam só aqui. */
const GRUPOS_NA_NUVEM = new Set(MODULOS);
const TOKEN = /pnl_[A-Za-z0-9_-]{20,190}/;
/** Parâmetros da instalação que a nuvem usa (seções caixa_agua e gerador). */
const PARAMETROS = {
  caixa_agua: ['capacidade_litros', 'altura_util_m', 'formato'],
  gerador: ['potencia_nominal_kw', 'capacidade_tanque_litros', 'consumo_litros_hora'],
};

/**
 * Ligação gravada pela interface: { url, token, modulos? } num arquivo só do
 * gateway (dados/), com permissão só para o dono. Lida uma vez e guardada.
 */
export class LigacaoNuvem {
  constructor(arquivo) {
    this.arquivo = arquivo;
    this.memoria = undefined;
  }

  ler() {
    if (this.memoria === undefined) {
      try { this.memoria = JSON.parse(fs.readFileSync(this.arquivo, 'utf8')); } catch { this.memoria = null; }
    }
    return this.memoria;
  }

  gravar(dados) {
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
    const temporario = `${this.arquivo}.tmp`;
    fs.writeFileSync(temporario, `${JSON.stringify(dados, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporario, this.arquivo);
    this.memoria = dados;
  }

  apagar() {
    fs.rmSync(this.arquivo, { force: true });
    this.memoria = null;
  }
}

/**
 * Confere o que veio da tela. O token pode vir colado com aspas ou com o trecho
 * inteiro do config.json: vale o `pnl_…` de dentro. Token em branco mantém o
 * atual (para trocar só o endereço ou os módulos).
 * @returns {{ ok: true, dados: object } | { ok: false, erros: string[] }}
 */
export function validarLigacao(entrada, atual = {}) {
  const erros = [];
  let url = null;
  try {
    const u = new URL(String(entrada?.url || '').trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) erros.push('o endereço precisa começar com https://');
    else url = u.origin;
  } catch {
    erros.push('endereço inválido (ex.: https://engemase-pulse.vercel.app)');
  }

  const colado = String(entrada?.token || '').trim();
  const token = colado ? colado.match(TOKEN)?.[0] : atual.token;
  if (colado && !token) erros.push('token inválido: cole o token gerado no Pulse (começa com pnl_)');
  else if (!token) erros.push('cole o token gerado no Pulse (Administração › Unidades › Gerar token)');

  let modulos;
  if (entrada?.modulos !== undefined && entrada.modulos !== null) {
    if (!Array.isArray(entrada.modulos) || entrada.modulos.some((m) => !MODULOS.includes(m))) {
      erros.push(`módulos inválidos (use ${MODULOS.join(', ')})`);
    } else {
      modulos = MODULOS.filter((m) => entrada.modulos.includes(m));
    }
  }

  if (erros.length) return { ok: false, erros };
  return { ok: true, dados: { url, token, ...(modulos ? { modulos } : {}) } };
}

export class Nuvem {
  /**
   * @param {() => object} lerConfig  devolve a configuração atual (ela muda quando a Engenharia aplica)
   * @param {object} banco            instância de Banco (src/db.js)
   * @param {{ versao?: string, ligacao?: LigacaoNuvem }} [info]  ligacao: o que a interface gravou
   */
  constructor(lerConfig, banco, info = {}) {
    this.lerConfig = lerConfig;
    this.banco = banco;
    this.info = info;
    this.ultimoAoVivo = 0;
    this.aoVivoEmCurso = false;
    // a nuvem cria os medidores a partir da lista de equipamentos (envio ao vivo);
    // histórico de um medidor que ela ainda não conhece seria descartado
    this.equipamentosAceitos = false;
    this.pendenciasEmCurso = false;
    this.falhas = 0;
    this.esperaAte = 0;
    this.ultimoErro = null;
    this.ultimoSucesso = null;
    this.ultimoErroAlarmes = null;
    this.relogio = setInterval(() => this.enviarPendencias(), 60000);
    this.relogio.unref?.();
    this.primeira = setTimeout(() => this.enviarPendencias(), 5000);
    this.primeira.unref?.();
  }

  get conf() {
    const base = this.lerConfig().nuvem || {};
    const local = this.info.ligacao?.ler();
    return local ? { ...base, ...local } : base;
  }

  get ativa() {
    const { url, token } = this.conf;
    return Boolean(url && token);
  }

  /** Para a tela de Engenharia ou o log: está enviando? */
  estado() {
    return { ativa: this.ativa, ultimo_sucesso: this.ultimoSucesso, erro: this.ultimoErro };
  }

  /** O que a tela Nuvem mostra. O token nunca volta inteiro: só os 4 últimos caracteres. */
  resumo() {
    const { url, token, modulos } = this.conf;
    return {
      url: url || null,
      token_final: token ? String(token).slice(-4) : null,
      modulos: Array.isArray(modulos) ? modulos : null,
      modulos_em_uso: this.modulos(),
      origem: this.info.ligacao?.ler() ? 'interface' : token ? 'configuracao' : null,
      ...this.estado(),
    };
  }

  /**
   * Endereço ou token novo: esquece o recuo e o estado da ligação anterior e
   * tenta já. Com `historico`, as marcas voltam ao começo e o histórico sobe de
   * novo (token de outra unidade; o que a nuvem já tinha é só regravado).
   */
  reiniciar({ historico = false } = {}) {
    if (historico) {
      for (const nome of ['nuvem_resumo_ate', 'nuvem_consumo_rowid', 'nuvem_alarmes_fim', 'nuvem_alarmes_id', 'nuvem_corridas_id']) {
        this.banco.gravarMarca(nome, null);
      }
    }
    this.falhas = 0;
    this.esperaAte = 0;
    this.ultimoErro = null;
    this.ultimoSucesso = null;
    this.ultimoAoVivo = 0;
    this.equipamentosAceitos = false;
  }

  parar() {
    clearInterval(this.relogio);
    clearTimeout(this.primeira);
  }

  /**
   * Chamar no fim de cada varredura. Não espera a rede: a leitura dos
   * equipamentos nunca atrasa por causa da nuvem.
   */
  aoVivo(ultimo) {
    if (!this.ativa || this.aoVivoEmCurso || Date.now() < this.esperaAte) return;
    if (Date.now() - this.ultimoAoVivo < (this.conf.intervalo_s || 10) * 1000) return;
    this.ultimoAoVivo = Date.now();
    this.aoVivoEmCurso = true;
    const parte = { equipamentos: this.equipamentos(ultimo) };
    const alarmes = this.alarmes(ultimo);
    if (alarmes) parte.alarmes = alarmes;
    this.enviar(parte)
      .then((resposta) => {
        this.equipamentosAceitos = true;
        this.reconhecerPelaNuvem(resposta?.alarmes?.reconhecer);
        const erroAlarmes = resposta?.alarmes?.erro || null;
        if (erroAlarmes && erroAlarmes !== this.ultimoErroAlarmes) console.error(`[nuvem] alarmes: ${erroAlarmes}`);
        this.ultimoErroAlarmes = erroAlarmes;
      })
      .catch(() => {}) // enviar() já registrou; o próximo ciclo tenta de novo
      .finally(() => { this.aoVivoEmCurso = false; });
  }

  equipamentos(ultimo) {
    const config = this.lerConfig();
    const defs = new Map((config.medidores || []).map((m) => [m.id, m]));
    return Object.values(ultimo?.equipamentos || {}).map((e) => {
      const d = defs.get(e.id) || {};
      const disjuntor = d.limites?.corrente_a?.max;
      const endereco = d.conexao?.unit_id;
      const grupo = e.grupo || d.grupo || 'energia';
      const linha = {
        id: e.id,
        nome: e.nome || e.id,
        tag_isa: e.tag_isa || null,
        grupo,
        perfil: d.perfil || null,
        principal: Boolean(d.principal),
        disjuntor_a: Number.isFinite(disjuntor) && disjuntor > 0 ? disjuntor : null,
        endereco: Number.isInteger(endereco) && endereco >= 0 ? endereco : null,
        online: Boolean(e.online),
        lido_em: Number.isFinite(e.lidoEm) ? e.lidoEm : null,
        valores: soNumeros(e.valores),
      };
      if (grupo === 'agua' || grupo === 'gerador') {
        const secao = grupo === 'agua' ? 'caixa_agua' : 'gerador';
        const daqui = config[secao]?.medidor === e.id;
        linha.parametros = daqui ? parametrosDe(config[secao], PARAMETROS[secao]) : null;
        linha.marcas = daqui ? marcasDe(config[secao].marcas) : null;
        linha.tags = (d.tags || [])
          .filter((t) => t?.nome && !t.oculto)
          .slice(0, 200)
          .map((t) => ({
            nome: String(t.nome).slice(0, 100),
            rotulo: t.rotulo ? String(t.rotulo).slice(0, 120) : null,
            unidade: t.unidade ? String(t.unidade).slice(0, 20) : null,
            decimais: Number.isInteger(t.decimais) && t.decimais >= 0 && t.decimais <= 6 ? t.decimais : null,
          }));
      }
      return linha;
    });
  }

  /** Módulos que esta unidade usa: os da configuração ou, sem ela, os que existem aqui. */
  modulos() {
    const config = this.lerConfig();
    const { modulos } = this.conf;
    if (Array.isArray(modulos)) return MODULOS.filter((m) => modulos.includes(m));
    const grupos = new Set((config.medidores || []).map((m) => m.grupo || 'energia'));
    return MODULOS.filter((m) =>
      m === 'agua' ? grupos.has('agua') || Boolean(config.caixa_agua?.medidor)
        : m === 'gerador' ? grupos.has('gerador') || Boolean(config.gerador?.medidor)
          : grupos.has(m));
  }

  /**
   * Alarmes ativos agora, a lista inteira: o que estava aberto na nuvem e não
   * vier aqui ela dá como normalizado. `ultimo.alarmes` é o que o motor de
   * alarmes devolveu na varredura (e é atualizado ao reconhecer na tela).
   */
  alarmes(ultimo) {
    if (!Array.isArray(ultimo?.alarmes)) return null;
    return ultimo.alarmes
      .filter((a) => Number.isInteger(a.id) && Number.isFinite(a.inicio))
      .slice(0, 500)
      .map((a) => this.alarme(a));
  }

  /** Linha da tabela `alarmes` no formato da nuvem. */
  alarme(a) {
    return {
      id: a.id,
      tag: String(a.tag).slice(0, 200),
      mensagem: String(a.mensagem || a.tag).slice(0, 300),
      prioridade: a.prioridade || 'media',
      valor: Number.isFinite(a.valor) ? a.valor : null,
      limite: a.limite ? String(a.limite).slice(0, 120) : null,
      inicio: a.inicio,
      reconhecido: Boolean(a.reconhecido),
    };
  }

  /** Alarmes reconhecidos por alguém na nuvem: reconhece aqui também (fica na auditoria). */
  reconhecerPelaNuvem(ids) {
    if (!Array.isArray(ids)) return;
    const validos = ids.filter((id) => Number.isInteger(id) && id > 0);
    for (const id of validos) {
      this.banco.reconhecerAlarme(id, Date.now());
      this.banco.registrar?.('alarme_reconhecido', `id ${id} (pela nuvem)`, 'nuvem', 'nuvem');
    }
    if (validos.length) console.log(`[nuvem] ${validos.length} alarme(s) reconhecido(s) pela nuvem`);
  }

  /** Próximo lote de alarmes encerrados, pela ordem do fim. */
  lerEncerrados() {
    const vazio = { linhas: [], marca: null, falta: false };
    let fim = this.banco.marca('nuvem_alarmes_fim');
    let id = this.banco.marca('nuvem_alarmes_id') ?? 0;
    if (fim === null) {
      fim = Date.now() - (this.conf.historico_inicial_dias ?? 7) * 86400000;
      id = 0;
    }
    let linhas;
    try {
      linhas = this.banco.db
        .prepare('SELECT * FROM alarmes WHERE fim IS NOT NULL AND (fim > ? OR (fim = ? AND id > ?)) ORDER BY fim, id LIMIT ?')
        .all(fim, fim, id, LOTE_ALARMES);
    } catch {
      return vazio; // banco sem a tabela de alarmes
    }
    if (!linhas.length) return vazio;
    const ultimo = linhas[linhas.length - 1];
    return {
      linhas: linhas.filter((a) => Number.isFinite(a.inicio)).map((a) => ({ ...this.alarme(a), fim: a.fim })),
      marca: { fim: ultimo.fim, id: ultimo.id },
      falta: linhas.length === LOTE_ALARMES,
    };
  }

  /** Envia o atraso em lotes até ficar em dia (ou até o limite da rodada). */
  async enviarPendencias() {
    if (!this.ativa || !this.equipamentosAceitos || this.pendenciasEmCurso || Date.now() < this.esperaAte) return;
    this.pendenciasEmCurso = true;
    try {
      // a corrida em andamento vai uma vez por rodada (a cada minuto), não a cada lote
      let lerCorridas = true;
      for (let i = 0; i < MAX_LOTES_POR_RODADA; i++) {
        const resumo = this.lerResumo();
        const consumo = this.lerConsumo();
        const encerrados = this.lerEncerrados();
        const corridas = lerCorridas ? this.lerCorridas() : { linhas: [], marca: null, falta: false };
        if (resumo.ate === null && consumo.rowid === null && encerrados.marca === null && !corridas.linhas.length) break;
        try {
          // fatia sem dado nenhum (configurador parado naquele período): só avança a marca
          if (resumo.janelas.length || consumo.linhas.length || encerrados.linhas.length || corridas.linhas.length) {
            const parte = { resumo_5min: resumo.janelas, consumo_horario: consumo.linhas };
            if (encerrados.linhas.length) parte.alarmes_encerrados = encerrados.linhas;
            if (corridas.linhas.length) parte.gerador_corridas = corridas.linhas;
            const r = await this.enviar(parte);
            if (r.ignorados) console.warn(`[nuvem] ${r.ignorados} linha(s) de equipamento que a nuvem não reconhece`);
          }
        } catch (e) {
          // 400 = a nuvem recusou o formato deste lote. Repetir não resolve e
          // travaria a fila para sempre: o lote é pulado, com aviso no log.
          if (e.status !== 400) throw e;
          console.error(`[nuvem] lote recusado e pulado (${e.message})`);
        }
        if (resumo.ate !== null) this.banco.gravarMarca('nuvem_resumo_ate', resumo.ate);
        if (consumo.rowid !== null) this.banco.gravarMarca('nuvem_consumo_rowid', consumo.rowid);
        if (encerrados.marca) {
          this.banco.gravarMarca('nuvem_alarmes_fim', encerrados.marca.fim);
          this.banco.gravarMarca('nuvem_alarmes_id', encerrados.marca.id);
        }
        if (corridas.marca !== null) this.banco.gravarMarca('nuvem_corridas_id', corridas.marca);
        lerCorridas = corridas.falta;
        if (!resumo.falta && !consumo.falta && !encerrados.falta && !corridas.falta) break;
      }
    } catch {
      // enviar() já registrou; tenta de novo no próximo minuto
    } finally {
      this.pendenciasEmCurso = false;
    }
  }

  /**
   * Corridas do gerador ainda não confirmadas, pela ordem do id. A marca só
   * passa das encerradas: a em andamento (e as depois dela) vêm de novo.
   */
  lerCorridas() {
    const vazio = { linhas: [], marca: null, falta: false };
    const desde = this.banco.marca('nuvem_corridas_id') ?? 0;
    let linhas;
    try {
      linhas = this.banco.db
        .prepare('SELECT * FROM gerador_corridas WHERE id > ? ORDER BY id LIMIT ?')
        .all(desde, LOTE_CORRIDAS);
    } catch {
      return vazio; // banco sem a tabela (instalação sem gerador)
    }
    if (!linhas.length) return vazio;
    let marca = null;
    for (const c of linhas) {
      if (!Number.isFinite(c.fim)) break;
      marca = c.id;
    }
    const n = (v) => (Number.isFinite(v) ? v : null);
    return {
      linhas: linhas
        .filter((c) => Number.isFinite(c.inicio))
        .map((c) => ({
          id: c.id,
          medidor: c.medidor,
          inicio: c.inicio,
          fim: n(c.fim),
          motivo: c.motivo ? String(c.motivo).slice(0, 80) : null,
          resultado: c.resultado ? String(c.resultado).slice(0, 160) : null,
          bateria_repouso: n(c.bateria_repouso),
          bateria_minima: n(c.bateria_minima),
          tempo_partida_s: n(c.tempo_partida_s),
          duracao_s: n(c.duracao_s),
          kwh: n(c.kwh),
          litros: n(c.litros),
          pico_kw: n(c.pico_kw),
          nivel_inicial: n(c.nivel_inicial),
          nivel_final: n(c.nivel_final),
        })),
      marca,
      falta: linhas.length === LOTE_CORRIDAS,
    };
  }

  /** Próxima fatia do resumo de 5 min (energia, água e gerador; só janelas fechadas). */
  lerResumo() {
    const vazio = { janelas: [], ate: null, falta: false };
    const resumoAte = this.banco.marca('resumo_ate');
    if (resumoAte === null) return vazio;
    let desde = this.banco.marca('nuvem_resumo_ate');
    if (desde === null) {
      const dias = this.conf.historico_inicial_dias ?? 7;
      desde = resumoAte - dias * 86400000;
      desde -= desde % J;
    }
    if (desde >= resumoAte) return vazio;
    const ate = Math.min(resumoAte, desde + FATIA_RESUMO_MS);

    const tags = new Map();
    for (const m of this.lerConfig().medidores || []) {
      const grupo = m.grupo || 'energia';
      if (!GRUPOS_NA_NUVEM.has(grupo)) continue;
      for (const t of m.tags || []) {
        // tag escondida (palavra de status crua) não interessa a ninguém fora daqui
        if (grupo !== 'energia' && t.oculto) continue;
        tags.set(`${m.id}.${t.nome}`, [m.id, t.nome]);
      }
    }
    if (!tags.size) return { janelas: [], ate, falta: ate < resumoAte };

    const marcas = [...tags.keys()].map(() => '?').join(',');
    const linhas = this.banco.db
      .prepare(`SELECT tag, ts, med, min, max FROM resumo_5min
                WHERE ts >= ? AND ts < ? AND tag IN (${marcas}) ORDER BY ts`)
      .all(desde, ate, ...tags.keys());

    const janelas = new Map();
    for (const l of linhas) {
      if (![l.med, l.min, l.max].every(Number.isFinite)) continue;
      const [medidor, nome] = tags.get(l.tag);
      const chave = `${medidor}|${l.ts}`;
      if (!janelas.has(chave)) janelas.set(chave, { medidor, ts: l.ts, valores: {} });
      janelas.get(chave).valores[nome] = [l.med, l.min, l.max];
    }
    return { janelas: [...janelas.values()], ate, falta: ate < resumoAte };
  }

  /** Próximo lote do consumo por hora, na ordem em que foi consolidado. */
  lerConsumo() {
    const desde = this.banco.marca('nuvem_consumo_rowid') ?? 0;
    const linhas = this.banco.db
      .prepare(`SELECT rowid, medidor, grandeza, hora, kwh, fonte FROM consumo_horario
                WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .all(desde, LOTE_CONSUMO);
    if (!linhas.length) return { linhas: [], rowid: null, falta: false };
    return {
      linhas: linhas
        .filter((l) => ['ativa', 'aparente'].includes(l.grandeza) && ['contador', 'potencia'].includes(l.fonte)
          && Number.isFinite(l.kwh) && l.kwh >= 0)
        .map((l) => ({ medidor: l.medidor, grandeza: l.grandeza, hora: l.hora, kwh: l.kwh, fonte: l.fonte })),
      rowid: linhas.at(-1).rowid,
      falta: linhas.length === LOTE_CONSUMO,
    };
  }

  async enviar(parte) {
    const { url, token } = this.conf;
    const corpo = {
      versao: 1,
      ts: Date.now(),
      agente: { versao: this.info.versao || null, planta: this.lerConfig().planta || null, modulos: this.modulos() },
      ...parte,
    };
    try {
      const r = await fetch(`${String(url).replace(/\/+$/, '')}/api/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `pulse-configurador/${this.info.versao || '?'}`,
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(PRAZO_MS),
      });
      const resposta = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detalhe = [resposta.erro, ...(resposta.problemas || [])].filter(Boolean).join('; ');
        throw Object.assign(new Error(`HTTP ${r.status}${detalhe ? `: ${detalhe}` : ''}`), { status: r.status });
      }
      if (this.ultimoErro) console.log('[nuvem] envio restabelecido');
      this.ultimoErro = null;
      this.falhas = 0;
      this.esperaAte = 0;
      this.ultimoSucesso = Date.now();
      return resposta;
    } catch (e) {
      // recuo: 10 s, 20 s, 40 s… até 5 min. Token errado (401) não melhora
      // sozinho, mas o recuo evita martelar a nuvem e encher o log.
      this.falhas += 1;
      this.esperaAte = Date.now() + Math.min(300000, 10000 * 2 ** (this.falhas - 1));
      const msg = e.name === 'TimeoutError' ? 'a nuvem não respondeu a tempo'
        : e.status ? e.message
          : `sem conexão com a nuvem (${e.cause?.code || e.message})`;
      if (msg !== this.ultimoErro) console.error(`[nuvem] ${msg}`);
      this.ultimoErro = msg;
      throw e;
    }
  }
}

/** Só os parâmetros conhecidos, com valor simples (número, texto curto ou sim/não). */
function parametrosDe(secao, chaves) {
  if (!secao) return null;
  const saida = {};
  for (const chave of chaves) {
    const v = secao[chave];
    if (typeof v === 'number' && Number.isFinite(v)) saida[chave] = v;
    else if (typeof v === 'string' && v.length <= 60) saida[chave] = v;
    else if (typeof v === 'boolean') saida[chave] = v;
  }
  return Object.keys(saida).length ? saida : null;
}

/**
 * Linhas de nível do reservatório ou do tanque ("alto 97 %", "partida da bomba
 * 60 %"), no formato que a nuvem aceita: 0–100 %, rótulo curto, no máximo 12.
 * A nuvem antiga ignora o campo.
 */
function marcasDe(marcas) {
  if (!Array.isArray(marcas)) return null;
  const saida = marcas
    .filter((m) => m && Number.isFinite(m.valor) && m.valor >= 0 && m.valor <= 100
      && typeof m.rotulo === 'string' && m.rotulo.trim())
    .slice(0, 12)
    .map((m) => ({
      valor: m.valor,
      rotulo: m.rotulo.trim().slice(0, 60),
      prioridade: typeof m.prioridade === 'string' ? m.prioridade.slice(0, 20) : null,
    }));
  return saida.length ? saida : null;
}

/** Só números (bits viram 0/1): a nuvem recusa o envio inteiro se vier texto. */
function soNumeros(valores) {
  const saida = {};
  for (const [nome, v] of Object.entries(valores || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) saida[nome] = v;
    else if (typeof v === 'boolean') saida[nome] = v ? 1 : 0;
  }
  return saida;
}
