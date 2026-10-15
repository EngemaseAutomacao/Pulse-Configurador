/**
 * Perfis de equipamento.
 *
 * Cada loja tem uma combinação diferente: marca de gerador, quantidade de
 * medidores, com ou sem reservatório. O mapa de registradores de cada modelo
 * fica em perfis/<nome>.json e o config.json da loja só diz "use este perfil,
 * neste endereço, com este nome". Instalar uma loja nova vira preencher uma
 * lista, não editar mapa Modbus na mão.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TAGS_CALCULADAS } from './gerador.js';
import { faixaDoComando } from './comandos.js';
import { normalizarPorta } from './mapa.js';
import { DERIVACOES } from './derivadas.js';

export function carregarPerfis(dir) {
  if (!fs.existsSync(dir)) return {};
  const perfis = {};
  for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const nome = path.basename(arquivo, '.json');
    try {
      perfis[nome] = JSON.parse(fs.readFileSync(path.join(dir, arquivo), 'utf8'));
    } catch (e) {
      throw new Error(`perfil ${arquivo}: ${e.message}`);
    }
  }
  for (const nome of Object.keys(perfis)) perfis[nome] = resolverHeranca(nome, perfis);
  return perfis;
}

/**
 * `"herda": "dse-gencomm"` — um modelo que é a família dele e mais um pouco
 * (o DSE8620 é o mapa GenComm comum + alarmes de paralelismo com a rede) não
 * copia o perfil inteiro. Tags com o mesmo nome e comandos com o mesmo nome
 * são substituídos; o resto se soma. Seções (gerador, conexão, padrão,
 * equipamento) se mesclam campo a campo.
 */
function resolverHeranca(nome, perfis, pilha = []) {
  const perfil = perfis[nome];
  if (!perfil?.herda) return perfil;
  if (pilha.includes(nome)) throw new Error(`perfis com herança circular: ${[...pilha, nome].join(' → ')}`);
  const base = resolverHeranca(perfil.herda, perfis, [...pilha, nome]);
  if (!base) throw new Error(`perfil ${nome}: herda de "${perfil.herda}", que não existe`);

  const porNome = (a = [], b = []) => {
    const novos = new Map(b.map((x) => [x.nome, x]));
    return [...a.filter((x) => !novos.has(x.nome)), ...b];
  };
  const mesclar = (a, b) => (a || b ? { ...(a || {}), ...(b || {}) } : undefined);
  const { herda, remapear, tags_removidas: removidas = [], ...proprio } = perfil;

  /* "remapear": o mesmo mapa lido em outro lugar. Um CLP que copia os blocos
     do gerador para a sua área D (D1000…) expõe os mesmos dados em outros
     endereços: o perfil filho diz onde cada bloco foi parar, e herda tudo o
     resto — tags, derivação, alarmes, comandos. Só vale para o que veio do pai;
     o que o filho declara já está no endereço certo. */
  const mover = (endereco, quem) => {
    if (!remapear) return endereco;
    const faixa = remapear.find((f) => endereco >= f.de && endereco <= f.ate);
    if (!faixa) throw new Error(`perfil ${nome}: ${quem} (endereço ${endereco}) fora de todos os blocos de "remapear"`);
    return faixa.para + (endereco - faixa.de);
  };
  const tagsDoPai = (base.tags || [])
    .filter((t) => !removidas.includes(t.nome))
    .map((t) => (t.calculada || t.endereco === undefined ? t : { ...t, endereco: mover(t.endereco, `tag ${t.nome}`) }));
  const comandosDoPai = (base.comandos || [])
    .map((c) => ({ ...c, endereco: mover(c.endereco, `comando ${c.nome}`) }));
  // alarme de tag removida não tem mais o que vigiar
  const alarmesDoPai = (base.alarmes || []).filter((a) => !removidas.includes(a.tag));
  const equipamento = mesclar(base.equipamento, proprio.equipamento);
  if (equipamento && (base.equipamento?.derivar_opcoes || proprio.equipamento?.derivar_opcoes)) {
    equipamento.derivar_opcoes = mesclar(base.equipamento?.derivar_opcoes, proprio.equipamento?.derivar_opcoes);
  }
  return {
    ...base,
    ...proprio,
    herdou: herda,
    equipamento,
    conexao: mesclar(base.conexao, proprio.conexao),
    padrao: mesclar(base.padrao, proprio.padrao),
    gerador: mesclar(base.gerador, proprio.gerador),
    tags: porNome(tagsDoPai, proprio.tags),
    comandos: porNome(comandosDoPai, proprio.comandos),
    alarmes: [...alarmesDoPai, ...(proprio.alarmes || [])],
    // registrador de heartbeat herdado também acompanha o remapeamento
    heartbeat: proprio.heartbeat !== undefined ? proprio.heartbeat
      : base.heartbeat ? { ...base.heartbeat, endereco: mover(base.heartbeat.endereco, 'heartbeat') } : base.heartbeat,
  };
}

/**
 * Expande os equipamentos que referenciam um perfil.
 * O que o equipamento declara localmente vence o que vem do perfil, então dá
 * para ajustar uma tag pontual sem duplicar o mapa inteiro.
 */
export function expandirPerfis(config, perfis) {
  const equipamentos = (config.medidores || []).map((m) => {
    if (!m.perfil) return m;
    const perfil = perfis[m.perfil];
    if (!perfil) throw new Error(`equipamento ${m.id}: perfil "${m.perfil}" não encontrado`);

    const tagsPerfil = perfil.tags || [];
    const locais = new Map((m.tags || []).map((t) => [t.nome, t]));
    const tags = tagsPerfil
      .filter((t) => !(m.tags_removidas || []).includes(t.nome))
      .map((t) => ({ ...t, ...(locais.get(t.nome) || {}) }));
    for (const [nome, t] of locais) if (!tagsPerfil.some((x) => x.nome === nome)) tags.push(t);

    return {
      ...(perfil.equipamento || {}),
      ...m,
      padrao: { ...(perfil.padrao || {}), ...(m.padrao || {}) },
      conexao: { ...(perfil.conexao || {}), ...(m.conexao || {}) },
      // heartbeat: "false" no equipamento desliga o que o perfil traz
      heartbeat: m.heartbeat === false ? null : (m.heartbeat ?? perfil.heartbeat ?? null),
      // comandos de acionamento: "false" no equipamento desliga os do perfil.
      // Uma instalação só de monitoramento põe "comandos": false.
      comandos: m.comandos === false ? [] : (m.comandos ?? perfil.comandos ?? []),
      tags,
      perfil_titulo: perfil.titulo || m.perfil,
    };
  });
  return { ...config, medidores: equipamentos };
}

/** Alarmes que o perfil já traz prontos, aplicados ao id do equipamento. */
export function alarmesDosPerfis(config, perfis) {
  const saida = [];
  for (const m of config.medidores || []) {
    const perfil = m.perfil && perfis[m.perfil];
    if (!perfil?.alarmes || m.alarmes_do_perfil === false) continue;
    for (const r of perfil.alarmes) {
      const regra = { ...r };
      if (regra.tag) regra.tag = `${m.id}.${regra.tag}`;
      if (regra.comunicacao) regra.medidor = m.id;
      regra.mensagem = (regra.mensagem || '').replace('{nome}', m.nome);
      for (const campo of ['min', 'max']) {
        const ajuste = m.limites?.[r.tag]?.[campo];
        if (ajuste !== undefined) regra[campo] = ajuste;
      }
      saida.push(regra);
    }
  }
  return saida;
}

/** Seções de tela que um perfil pode trazer prontas. */
const SECOES = { gerador: 'gerador', caixa_agua: 'caixa_agua' };

const semVazios = (o) => Object.fromEntries(
  Object.entries(o || {}).filter(([k, v]) => v !== null && v !== undefined && !k.startsWith('_')),
);

/**
 * Seções `gerador` e `caixa_agua` montadas a partir do perfil do equipamento.
 *
 * O que é do modelo — estados, modos, lista de falhas, qual tag é o nível —
 * mora no perfil e não se repete em loja nenhuma. O que é da instalação —
 * tanque, consumo, altura do reservatório — vem da configuração da loja e vence
 * o perfil. Assim, acrescentar um gerador pela tela de Engenharia já faz a tela
 * do gerador existir, mesmo antes de alguém preencher os números.
 */
export function secoesDosPerfis(config, perfis) {
  const saida = { ...config };
  const medidores = config.medidores || [];
  for (const [nomeSecao, chaveNoPerfil] of Object.entries(SECOES)) {
    const daLoja = config[nomeSecao];
    const modelo = (m) => {
      const perfil = m.perfil && perfis[m.perfil];
      return perfil && perfil[chaveNoPerfil] ? perfil[chaveNoPerfil] : null;
    };
    // o dono é quem a loja apontou; se ela não apontou ninguém, o primeiro
    // equipamento cujo perfil sabe preencher esta seção
    const dono = daLoja?.medidor
      ? medidores.find((m) => m.id === daLoja.medidor)
      : medidores.find(modelo);
    if (!dono) continue;                       // seção escrita à mão fica como está
    const template = modelo(dono);
    if (!template && !daLoja) continue;
    saida[nomeSecao] = {
      ...semVazios(template),
      ...semVazios(daLoja),
      medidor: dono.id,
    };
  }
  return saida;
}

/**
 * Tags que o supervisório calcula para o grupo gerador e acrescenta ao
 * equipamento. Ficam indistinguíveis das lidas para o resto do sistema —
 * histórico, alarmes, tendências e tela — mas nunca vão ao barramento.
 */
export function acrescentarCalculadas(config) {
  const id = config.gerador?.medidor;
  if (!id) return config;
  const medidores = (config.medidores || []).map((m) => {
    if (m.id !== id) return m;
    const tem = new Set((m.tags || []).map((t) => t.nome));
    const novas = TAGS_CALCULADAS.filter((t) => !tem.has(t.nome));
    return novas.length ? { ...m, tags: [...(m.tags || []), ...novas] } : m;
  });
  return { ...config, medidores };
}

/** Alarmes de indicador: o que só se enxerga com o histórico do gerador. */
function alarmesCalculados(config) {
  const g = config.gerador;
  if (!g?.medidor || g.alarmes_de_indicador === false) return [];
  const nome = (config.medidores || []).find((m) => m.id === g.medidor)?.nome || 'Grupo gerador';
  const regras = [{
    tag: `${g.medidor}.pronto`,
    digital: true,
    inverso: true,
    prioridade: 'alta',
    mensagem: `${nome}: indisponível — não parte se a rede cair`,
    atraso_s: 120,
  }];
  const dias = g.teste_a_cada_dias ?? 7;
  if (dias) {
    regras.push({
      tag: `${g.medidor}.dias_sem_teste`,
      max: dias,
      prioridade: 'baixa',
      mensagem: `${nome}: sem partir há mais de ${dias} dias — faça o teste`,
      atraso_s: 600,
    });
  }
  return regras;
}

/** Configuração efetiva: perfis expandidos + alarmes do perfil + os locais. */
export function prepararConfig(configBruta, dirPerfis) {
  const perfis = carregarPerfis(dirPerfis);
  const expandida = acrescentarCalculadas(
    secoesDosPerfis(expandirPerfis(configBruta, perfis), perfis),
  );
  // alarmes escritos na configuração também aceitam {nome}: renomear o
  // equipamento pelo editor muda a mensagem junto (texto fixo ficava apontando
  // o nome antigo enquanto o alarme vigiava outro medidor)
  const nomes = new Map((configBruta.medidores || []).map((m) => [m.id, m.nome]));
  const daInstalacao = (configBruta.alarmes || []).map((r) => {
    const alvo = r.medidor || String(r.tag || '').split('.')[0];
    return nomes.has(alvo) && String(r.mensagem || '').includes('{nome}')
      ? { ...r, mensagem: r.mensagem.replace('{nome}', nomes.get(alvo)) } : r;
  });
  const alarmes = [
    ...alarmesDosPerfis(configBruta, perfis),
    ...alarmesCalculados(expandida),
    ...daInstalacao,
  ];
  return { config: { ...expandida, alarmes }, perfis };
}

/** Verificações que impedem uma configuração ruim de entrar em operação. */
export function validarConfig(config) {
  const erros = [];
  const avisos = [];
  const ids = new Set();
  const enderecos = new Map();

  for (const m of config.medidores || []) {
    if (!m.id) { erros.push('equipamento sem id'); continue; }
    if (ids.has(m.id)) erros.push(`id repetido: ${m.id}`);
    ids.add(m.id);
    if (!m.conexao) { erros.push(`${m.id}: sem bloco de conexão`); continue; }

    // o barramento identifica onde o equipamento fala: serial ou máquina:porta.
    // É o par barramento+endereço que não pode repetir
    const barramento = m.conexao.tipo === 'tcp'
      ? `${m.conexao.host}:${m.conexao.porta || 502}`
      : (normalizarPorta(m.conexao.porta_serial) || `${m.conexao.host}:${m.conexao.porta || 502}`);
    const chave = `${barramento}#${m.conexao.unit_id}`;
    // dois equipamentos lógicos num escravo só é legítimo quando declarado: o
    // gerador lido pelo CLP da subestação mora no mesmo endereço do CLP
    const anterior = enderecos.get(chave);
    if (anterior && !(m.escravo_compartilhado || anterior.escravo_compartilhado)) {
      erros.push(`endereço ${m.conexao.unit_id} repetido em ${barramento}: ${anterior.id} e ${m.id}`);
    }
    if (!anterior) enderecos.set(chave, m);

    if (m.conexao.tipo === 'tcp' && !m.conexao.host) {
      erros.push(`${m.id}: conexão TCP sem endereço de máquina`);
    }
    if (m.conexao.tipo !== 'tcp' && !m.conexao.porta_serial) {
      erros.push(`${m.id}: conexão serial sem porta`);
    }
    if (m.conexao.tipo !== 'tcp') {
      const itf = m.conexao.interface;
      if (itf !== undefined && !['rs232', 'rs485'].includes(itf)) {
        erros.push(`${m.id}: interface serial "${itf}" desconhecida (use rs232 ou rs485)`);
      }
      // equipamento com endereço fixo em RS-232 (o DSE responde só no 10):
      // qualquer outro valor é comunicação que nunca vai acontecer
      if (itf === 'rs232' && Number.isInteger(m.endereco_rs232) && m.conexao.unit_id !== m.endereco_rs232) {
        erros.push(`${m.id}: em RS-232 este equipamento responde só no endereço ${m.endereco_rs232} `
          + `(está configurado ${m.conexao.unit_id})`);
      }
    }
    if (!m.tags?.length) avisos.push(`${m.id}: nenhuma tag configurada`);
    if (m.derivar && !DERIVACOES[m.derivar]) erros.push(`${m.id}: derivação "${m.derivar}" não existe`);
    const desloc = m.padrao?.deslocamento_endereco;
    if (desloc !== undefined && (!Number.isInteger(desloc) || Math.abs(desloc) > 1)) {
      erros.push(`${m.id}: deslocamento_endereco deve ser -1, 0 ou 1 (veio ${JSON.stringify(desloc)})`);
    }
    const nomes = new Set();
    for (const t of m.tags || []) {
      if (nomes.has(t.nome)) erros.push(`${m.id}: tag repetida ${t.nome}`);
      nomes.add(t.nome);
      // tag calculada não tem endereço: ela nasce aqui dentro, não no barramento
      if (!t.calculada && !Number.isInteger(t.endereco)) {
        erros.push(`${m.id}.${t.nome}: endereço inválido`);
      }
      if (Number.isInteger(t.bit) && t.escala !== undefined) {
        avisos.push(`${m.id}.${t.nome}: tag de bit com escala — a escala é ignorada`);
      }
      if (t.bits !== undefined && (!Number.isInteger(t.bits) || !Number.isInteger(t.bit)
        || t.bits < 1 || t.bit < 0 || t.bit + t.bits > 16)) {
        erros.push(`${m.id}.${t.nome}: campo de bits fora da palavra (bit ${t.bit} + ${t.bits} bits > 16)`);
      }
    }
  }

  /* RS-232 é ponto a ponto: um equipamento por porta. Dividir a COM do DSE
     com outro (ex.: o CLP na RS-485 da COM7) não tem como funcionar. */
  const serial = (config.medidores || []).filter((m) => m.conexao && m.conexao.tipo !== 'tcp' && m.conexao.porta_serial);

  /* Uma porta abre com UMA velocidade: a do primeiro equipamento cadastrado
     nela. Um segundo equipamento com outra velocidade na mesma porta seria
     interrogado na velocidade errada e nunca responderia — sem nenhum aviso. */
  const formato = (c) => `${c.baud || 9600} ${(c.bits_dados || 8)}${String(c.paridade || 'none')[0].toUpperCase()}${c.bits_parada || 1}`;
  const porPorta = new Map();
  for (const m of serial) {
    const porta = normalizarPorta(m.conexao.porta_serial);
    const primeiro = porPorta.get(porta);
    if (!primeiro) { porPorta.set(porta, m); continue; }
    if (formato(m.conexao) !== formato(primeiro.conexao)) {
      erros.push(`${m.id}: na porta ${porta} em ${formato(m.conexao)}, mas ${primeiro.id} usa a mesma porta em `
        + `${formato(primeiro.conexao)} — uma porta só tem uma velocidade`);
    }
  }
  for (const m of serial.filter((x) => x.conexao.interface === 'rs232')) {
    const porta = normalizarPorta(m.conexao.porta_serial);
    const outros = serial.filter((x) => x !== m && normalizarPorta(x.conexao.porta_serial) === porta);
    if (outros.length) {
      erros.push(`${m.id}: RS-232 é ponto a ponto — a porta ${porta} não pode ser dividida com ${outros.map((x) => x.id).join(', ')}`);
    }
  }

  for (const r of config.alarmes || []) {
    const alvo = r.medidor || String(r.tag || '').split('.')[0];
    if (!ids.has(alvo)) { erros.push(`alarme "${r.mensagem}": equipamento ${alvo} não existe`); continue; }
    if (r.comunicacao) continue;
    const nome = String(r.tag).split('.')[1];
    const eq = config.medidores.find((m) => m.id === alvo);
    if (!eq.tags.some((t) => t.nome === nome)) erros.push(`alarme "${r.mensagem}": tag ${r.tag} não existe`);
    if (r.min === undefined && r.max === undefined && !r.digital) {
      erros.push(`alarme "${r.mensagem}": sem min, max nem digital`);
    }
  }

  // um comando com intertravamento quebrado é pior que comando nenhum
  for (const m of config.medidores || []) {
    for (const c of m.comandos || []) {
      const tem = (n) => (m.tags || []).some((t) => t.nome === n);
      if (!c.nome) erros.push(`${m.id}: comando sem nome`);
      const ref = `comando ${m.id}.${c.nome}`;
      if (!Number.isInteger(c.endereco)) erros.push(`${ref}: endereço inválido`);
      const palavra = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffff;
      if (Array.isArray(c.valores)) {
        if (c.complemento) erros.push(`${ref}: use "valores" ou "complemento", não os dois`);
        if (c.valores.length < 2 || c.valores.length > 123 || !c.valores.every(palavra)) {
          erros.push(`${ref}: "valores" precisa de 2 a 123 números entre 0 e 65535`);
        }
        if (c.funcao === 'coil' && !c.valores.every((v) => v === 0 || v === 1)) {
          erros.push(`${ref}: em coil, "valores" só aceita 0 e 1`);
        }
      } else if (!palavra(c.valor)) {
        erros.push(`${ref}: valor a escrever inválido (0 a 65535)`);
      }
      if (c.complemento && c.funcao === 'coil') erros.push(`${ref}: complemento é para registrador, não para coil`);
      if (!Array.isArray(c.valores) && !c.complemento) {
        avisos.push(`${ref}: escreve uma palavra só — considere "complemento": true (ver FX3U.md)`);
      }

      /* O heartbeat é escrito a cada poucos segundos: se cair dentro do
         registrador de um comando, cada batida vira um comando. */
      if (Number.isInteger(c.endereco) && Number.isInteger(m.heartbeat?.endereco)) {
        const [ini, fim] = faixaDoComando(c);
        if (m.heartbeat.endereco >= ini && m.heartbeat.endereco <= fim) {
          erros.push(`${ref}: ocupa os registradores ${ini}–${fim}, que incluem o do heartbeat (${m.heartbeat.endereco})`);
        }
      }
      for (const t of c.intertravamentos || []) {
        if (!tem(t.tag)) erros.push(`comando ${m.id}.${c.nome}: intertravamento usa tag inexistente ${t.tag}`);
        const temCondicao = t.igual !== undefined || t.min !== undefined || t.max !== undefined
          || Array.isArray(t.em) || Array.isArray(t.fora_de);
        if (!temCondicao) {
          erros.push(`comando ${m.id}.${c.nome}: intertravamento de ${t.tag} sem condição`);
        }
        if (Array.isArray(t.em) && Array.isArray(t.fora_de)) {
          erros.push(`comando ${m.id}.${c.nome}: ${t.tag} não pode ter "em" e "fora_de" ao mesmo tempo`);
        }
      }
      if (c.mostrar_causa && !tem(c.mostrar_causa)) {
        erros.push(`comando ${m.id}.${c.nome}: mostrar_causa usa tag inexistente ${c.mostrar_causa}`);
      }
      if (c.confirma_com && !tem(c.confirma_com.tag)) {
        erros.push(`comando ${m.id}.${c.nome}: realimentação usa tag inexistente ${c.confirma_com.tag}`);
      }
      if (!c.confirma_com) {
        avisos.push(`comando ${m.id}.${c.nome}: sem realimentação — não dá para saber se o equipamento obedeceu`);
      }
      if (!c.intertravamentos?.length) {
        avisos.push(`comando ${m.id}.${c.nome}: sem intertravamento — o comando sai sempre que houver comunicação`);
      }
    }
  }

  for (const secao of ['caixa_agua', 'gerador']) {
    const s = config[secao];
    if (s && !ids.has(s.medidor)) erros.push(`${secao}: equipamento ${s.medidor} não existe`);
  }
  for (const s of config.unifilar?.saidas || []) {
    if (!ids.has(s.medidor)) avisos.push(`unifilar: saída ${s.medidor} não tem equipamento — será ignorada`);
  }

  return { valido: erros.length === 0, erros, avisos };
}
