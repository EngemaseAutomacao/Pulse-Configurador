import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Coletor } from './src/modbus.js';
import { Simulador } from './src/simulador.js';
import { Banco, prepararAcesso } from './src/db.js';
import { MotorAlarmes } from './src/alarmes.js';
import { MotorGerador } from './src/gerador.js';
import { Nuvem, LigacaoNuvem, validarLigacao } from './src/nuvem.js';
import {
  Acesso, gerarHash, conferirSenha, forcaDaSenha, lerCookie, origemDaRequisicao, PAPEIS,
} from './src/auth.js';
import { prepararConfig, validarConfig } from './src/perfis.js';
import { interpretar } from './src/mapa.js';
import { consumoDoDia, consolidar, diaDe, GRANDEZAS } from './src/consumo.js';
import {
  estadoDosComandos, acharComando, impedimentos, executar, palavrasDoComando, faixaDoComando,
} from './src/comandos.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const dirPerfis = path.join(raiz, 'perfis');
const dirVersoes = path.join(raiz, 'dados', 'versoes');
const arquivoConfig = path.join(raiz, 'config.json');

const semModbus = process.argv.includes('--sem-modbus');
const comRoteiro = process.argv.includes('--roteiro');

// --config <arquivo> permite manter várias lojas/bancadas no mesmo servidor
const iConfig = process.argv.indexOf('--config');
const arquivoEmUso = iConfig >= 0 && process.argv[iConfig + 1]
  ? path.resolve(raiz, process.argv[iConfig + 1])
  : arquivoConfig;

if (!fs.existsSync(arquivoEmUso)) {
  console.error(`configuração não encontrada: ${arquivoEmUso}`);
  process.exit(1);
}

let configBruta = JSON.parse(fs.readFileSync(arquivoEmUso, 'utf8'));
let { config, perfis } = prepararConfig(configBruta, dirPerfis);

const primeira = validarConfig(config);
if (!primeira.valido) {
  console.error('config.json inválido:');
  for (const e of primeira.erros) console.error('  -', e);
  process.exit(1);
}
for (const a of primeira.avisos) console.warn('aviso:', a);

/**
 * HTTPS próprio: com `seguranca.tls` o configurador serve criptografado, sem precisar
 * de proxy na frente. Senha e comando de disjuntor não trafegam em texto aberto
 * na rede da loja. O certificado pode vir de `node tools/gerar-certificado.js`.
 * Lido só na partida: trocar o certificado pede reiniciar o serviço.
 */
function lerTls(tls) {
  if (!tls) return null;
  const ler = (campo) => {
    const arquivo = path.resolve(raiz, String(tls[campo] || ''));
    if (!tls[campo] || !fs.existsSync(arquivo)) {
      console.error(`seguranca.tls.${campo}: arquivo não encontrado (${arquivo})`);
      console.error('gere um com: node tools/gerar-certificado.js');
      process.exit(1);
    }
    return fs.readFileSync(arquivo);
  };
  return { cert: ler('certificado'), key: ler('chave') };
}
const credenciaisTls = lerTls(config.seguranca?.tls);

const arquivoDoBanco = path.join(raiz, config.historico.arquivo);
const banco = new Banco(arquivoDoBanco);
prepararAcesso(banco.db);
// com TLS o cookie de sessão ganha Secure: nunca sai por HTTP comum
const acesso = new Acesso(banco, { ...(config.seguranca || {}), https: !!credenciaisTls || !!config.seguranca?.https });

const senhaInicial = acesso.garantirAdmin();
if (senhaInicial) {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│ Primeiro acesso — usuário: admin                        │');
  console.log(`│ Senha temporária: ${senhaInicial.padEnd(38)}│`);
  console.log('│ A troca é obrigatória no primeiro login.                │');
  console.log('└─────────────────────────────────────────────────────────┘\n');
}

let motorAlarmes = new MotorAlarmes(config.alarmes || [], banco);
// indicadores do grupo gerador: calcula prontidão e autonomia a cada varredura
// e grava uma linha por corrida (partida → parada)
let motorGerador = new MotorGerador(config.gerador || {}, banco);
let coletor = semModbus ? new Simulador(config, { roteiro: comRoteiro }) : new Coletor(config);
let ultimo = { ts: Date.now(), equipamentos: {}, alarmes: [], simulado: semModbus };
let ultimaGravacao = 0;
let falhaGravacao = null;    // última falha ao gravar o histórico (disco cheio?), null se gravando
let encerrando = false;
let relogioRollback = null;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

/* ------------------------------------------------------- cabeçalhos básicos */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // script-src continua estrito, que é o que barra XSS. style-src precisa
  // aceitar inline: as telas posicionam barras e marcas por style="", e sem
  // isso o navegador descarta a posição e os indicadores se empilham.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "font-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// a central também é proxy: quem abre a loja pelo endereço da internet chega
// aqui pela VPN com o IP dela, e o IP real vem no X-Forwarded-For que ela põe.
// Sem isso, 5 senhas erradas de um operador bloqueariam todos os outros
const origem = (req) => origemDaRequisicao(req,
  [...(config.seguranca?.proxies_confiaveis || []), config.central?.ip].filter(Boolean));

/* ------------------------------------------------------------ autenticação */

function autenticar(req, _res, next) {
  req.usuario = acesso.usuarioDoToken(lerCookie(req.headers.cookie, 'painel_sessao'));
  next();
}

function exigir(minimo) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ erro: 'sessão expirada' });
    if (!acesso.podeNoPapel(req.usuario.papel, minimo)) {
      banco.registrar('acesso_negado', `${req.method} ${req.path}`, req.usuario.login, origem(req));
      return res.status(403).json({ erro: 'seu perfil não permite esta operação' });
    }
    // troca de senha pendente trava tudo, menos a própria troca
    if (req.usuario.trocar_senha && req.path !== '/api/senha') {
      return res.status(428).json({ erro: 'troca de senha obrigatória' });
    }
    return next();
  };
}

// exige cabeçalho próprio nas operações que mudam estado: barra formulário
// enviado de outro site, mesmo que o navegador leve o cookie junto
function exigirCabecalho(req, res, next) {
  if (req.method === 'GET' || req.get('X-Painel') === '1') return next();
  return res.status(400).json({ erro: 'requisição sem o cabeçalho de origem' });
}

app.use(autenticar);
app.use('/api', exigirCabecalho);

/* Resumo para a central de operação, que enxerga a loja pela VPN. Sem sessão,
   mas só responde ao endereço da central declarado em `central.ip`: dentro do
   WireGuard esse endereço só pode vir do túnel da própria central (o túnel
   recusa pacote de quem não tem a chave dela). Sem `central.ip`, fica fechado. */
const versaoDoPainel = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).version; } catch { return null; }
})();
// cópia das leituras para o Engemase Pulse; só envia com endereço e token, gravados
// pela tela Nuvem (um arquivo por configuração, em dados/) ou na seção "nuvem"
const ligacaoNuvem = new LigacaoNuvem(path.join(raiz, 'dados', `nuvem-${path.basename(arquivoEmUso, '.json')}.json`));
const nuvem = new Nuvem(() => config, banco, { versao: versaoDoPainel, ligacao: ligacaoNuvem });

app.get('/api/central/resumo', (req, res) => {
  const ipCentral = config.central?.ip;
  const de = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // repassado pelo proxy da central (alguém pela internet) não é a central consultando
  if (!ipCentral || de !== ipCentral || req.headers['x-forwarded-for']) {
    return res.status(403).json({ erro: 'reservado à central de operação' });
  }
  const eqs = Object.values(ultimo.equipamentos || {});
  return res.json({
    planta: config.planta || null,
    versao: versaoDoPainel,
    ts: ultimo.ts,
    simulado: !!ultimo.simulado,
    equipamentos: eqs.length,
    online: eqs.filter((e) => e.online).length,
    sem_comunicacao: eqs.filter((e) => !e.online).map((e) => e.nome),    alarmes: (ultimo.alarmes || []).map((a) => ({
      mensagem: a.mensagem, prioridade: a.prioridade, inicio: a.inicio, reconhecido: !!a.reconhecido,
    })),
  });
});

app.post('/api/login', (req, res) => {
  const r = acesso.entrar(req.body?.login, req.body?.senha, origem(req));
  if (r.erro) return res.status(401).json({ erro: r.erro });
  res.setHeader('Set-Cookie', acesso.cookie(r.token));
  return res.json({ usuario: r.usuario });
});

app.post('/api/sair', (req, res) => {
  if (req.usuario) {
    banco.encerrarSessao(req.usuario.token);
    fecharCanais((ws) => ws.token === req.usuario.token);
    banco.registrar('logout', null, req.usuario.login, origem(req));
  }
  res.setHeader('Set-Cookie', acesso.cookie('', true));
  res.json({ ok: true });
});

app.get('/api/eu', (req, res) => {
  if (!req.usuario) return res.status(401).json({ erro: 'não autenticado' });
  return res.json({ usuario: acesso.publico(req.usuario) });
});

app.post('/api/senha', exigir('operador'), (req, res) => {
  const { atual, nova } = req.body || {};
  const u = banco.usuarioPorId(req.usuario.id);
  if (!conferirSenha(String(atual || ''), u.sal, u.hash)) {
    return res.status(400).json({ erro: 'senha atual incorreta' });
  }
  const problemas = forcaDaSenha(nova);
  if (problemas.length) return res.status(400).json({ erro: `senha fraca: ${problemas.join(', ')}` });

  const { sal, hash } = gerarHash(nova);
  banco.atualizarUsuario(u.id, { sal, hash, trocar_senha: 0 });
  banco.encerrarSessoesDoUsuario(u.id);        // derruba sessões antigas
  fecharCanais((ws) => ws.usuarioId === u.id);
  banco.registrar('senha_alterada', null, u.login, origem(req));
  res.setHeader('Set-Cookie', acesso.cookie('', true));
  return res.json({ ok: true, reentrar: true });
});

/* ------------------------------------------------------------------ leitura */

function configPublica() {
  return {
    planta: config.planta,
    simulado: semModbus,
    unifilar: config.unifilar,
    caixa_agua: config.caixa_agua,
    gerador: config.gerador,
    // quais telas a instalação quer no menu, independente do que já está
    // cadastrado: { "gerador": true } mostra a tela com o guia de instalação
    telas: config.telas || {},
    limites: config.alarmes,
    escrita_modbus_liberada: !!config.seguranca?.escrita_modbus_liberada,
    comandos_liberados: !!config.seguranca?.comandos_liberados,
    equipamentos: config.medidores.map((m) => ({
      id: m.id,
      nome: m.nome,
      tag_isa: m.tag_isa || null,
      grupo: m.grupo || 'energia',
      principal: !!m.principal,
      perfil: m.perfil || null,
      unit_id: m.conexao?.unit_id ?? null,
      tags: m.tags.map((t) => ({
        nome: t.nome, rotulo: t.rotulo, unidade: t.unidade ?? '',
        decimais: t.decimais ?? 1, fase: t.fase || null,
        acumulador: !!t.acumulador, oculto: !!t.oculto,
        digital: t.bit !== undefined || t.tipo === 'bool',
        severidade: t.severidade || null,
        inverso: !!t.inverso,
        enum: t.enum || null,
      })),
    })),
  };
}

app.get('/api/config', exigir('operador'), (_req, res) => res.json(configPublica()));
app.get('/api/valores', exigir('operador'), (_req, res) => res.json(ultimo));

app.get('/api/historico', exigir('operador'), (req, res) => {
  const tag = String(req.query.tag || '');
  if (!/^[\w-]+\.[\w-]+$/.test(tag)) return res.status(400).json({ erro: 'tag inválida' });
  const horas = Math.min(Math.max(Number(req.query.horas) || 6, 0.1), 24 * 365);
  const pontos = Math.min(Math.max(Number(req.query.pontos) || 240, 20), 2000);
  const ate = Date.now();
  return res.json({ tag, de: ate - horas * 3600000, ate, pontos: banco.consultarSerie(tag, ate - horas * 3600000, ate, pontos) });
});

/* Consumo de energia hora a hora por setor, de um dia (padrão: hoje). */
app.get('/api/consumo', exigir('operador'), (req, res) => {
  const dia = req.query.dia ? String(req.query.dia) : diaDe(Date.now());
  const grandeza = req.query.grandeza ? String(req.query.grandeza) : 'ativa';
  if (!GRANDEZAS[grandeza]) return res.status(400).json({ erro: 'grandeza inválida (ativa ou aparente)' });
  const r = consumoDoDia(banco, config, dia, Date.now(), grandeza);
  if (!r) return res.status(400).json({ erro: 'dia inválido (use AAAA-MM-DD)' });
  return res.json(r);
});

app.get('/api/alarmes', exigir('operador'), (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 1000);
  res.json({ ativos: banco.alarmesAtivos(), historico: banco.historicoAlarmes(limite) });
});

/* Indicadores do grupo gerador: prontidão, partidas, bateria, consumo. */
app.get('/api/gerador/indicadores', exigir('operador'), (req, res) => {
  if (!config.gerador?.medidor) return res.status(404).json({ erro: 'instalação sem grupo gerador' });
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  return res.json(motorGerador.indicadores(dias));
});

app.post('/api/alarmes/reconhecer', exigir('operador'), (req, res) => {
  const agora = Date.now();
  if (req.body?.id) banco.reconhecerAlarme(Number(req.body.id), agora);
  else banco.reconhecerTodos(agora);
  banco.registrar('alarme_reconhecido', req.body?.id ? `id ${req.body.id}` : 'todos', req.usuario.login, origem(req));
  ultimo = { ...ultimo, alarmes: banco.alarmesAtivos() };
  transmitir();
  res.json({ ok: true, ativos: ultimo.alarmes });
});

/* ---------------------------------------------------------------- comandos */

app.get('/api/comandos', exigir('operador'), (req, res) => {
  res.json({
    liberados: !!config.seguranca?.comandos_liberados,
    em_curso: comandoEmCurso,
    comandos: estadoDosComandos(config, ultimo.equipamentos, req.usuario.papel,
      (p, m) => acesso.podeNoPapel(p, m)),
  });
});

let comandoEmCurso = null;   // { rotulo, equipamento, quem, desde }

app.post('/api/comandos/executar', exigir('operador'), async (req, res) => {
  const { medidor, comando: nome, confirmado, senha } = req.body || {};
  const quem = req.usuario.login;
  const de = origem(req);
  /**
   * `sessao: 'valida'` diz ao painel que este 401 é da senha do comando, não da
   * sessão: sem isso o operador que erra a senha do disjuntor é jogado para a
   * tela de login e perde o que estava fazendo.
   */
  const recusar = (motivo, status = 400) => {
    banco.registrar('comando_negado', `${medidor}.${nome}: ${motivo}`, quem, de);
    return res.status(status).json({ erro: motivo, sessao: 'valida' });
  };

  if (!config.seguranca?.comandos_liberados) {
    return recusar('Comandos desabilitados na configuração desta instalação', 403);
  }
  const alvo = acharComando(config, medidor, nome);
  if (!alvo) return recusar('Comando não existe nesta configuração', 404);

  const papel = alvo.comando.papel || 'tecnico';
  if (!acesso.podeNoPapel(req.usuario.papel, papel)) {
    return recusar(`Este comando exige perfil ${papel}`, 403);
  }
  if (confirmado !== true) return recusar('Comando sem confirmação do operador');

  /**
   * Um acionamento por vez na planta inteira. Dois operadores comandando ao
   * mesmo tempo — ou um mesmo disjuntor recebendo "ligar" e "desligar" em
   * sequência — tornam a realimentação ambígua: não dá para saber qual comando
   * o equipamento está confirmando. Recusa antes de pedir a senha, para não
   * gastar tentativa de quem só chegou tarde.
   */
  if (comandoEmCurso) {
    const c = comandoEmCurso;
    return recusar(`Aguarde: ${c.rotulo} (${c.equipamento}) acionado por ${c.quem} ainda está em andamento`, 409);
  }

  /**
   * Reautenticação: o comando pede a senha de novo, no momento de acionar.
   * É o que protege um posto deixado aberto — a sessão sozinha não basta para
   * abrir ou fechar disjuntor. A senha não é registrada em lugar nenhum.
   */
  if (alvo.comando.exige_senha) {
    // o bloqueio segue a conta, não o endereço: quem está com a sessão de
    // outro não escapa dele trocando de máquina ou de cabeçalho
    const chave = `cmd:${req.usuario.id}`;
    const espera = acesso.tentativas.bloqueado(chave);
    if (espera) {
      return recusar(`Muitas senhas erradas; tente em ${Math.ceil(espera / 60000)} min`, 429);
    }
    const u = banco.usuarioPorId(req.usuario.id);
    if (!senha || !conferirSenha(String(senha), u.sal, u.hash)) {
      acesso.tentativas.falhou(chave);
      return recusar('Senha incorreta', 401);
    }
    acesso.tentativas.acertou(chave);
  }

  // revalidação no servidor: a tela pode estar desatualizada, ou alterada
  const travas = impedimentos(alvo.comando, medidor, ultimo.equipamentos, alvo.medidor.tags);
  if (travas.length) return recusar(travas.join(' · '), 409);

  // o mesmo coletor do começo ao fim, mesmo que a configuração seja trocada no meio
  const col = coletor;
  const onde = col.conexaoDe?.(medidor);
  if (!onde) return recusar('Equipamento fora da varredura', 409);

  // da verificação lá de cima até aqui não há nenhum await: ninguém entra no
  // meio, e a trava é tomada no mesmo passo em que foi conferida livre
  comandoEmCurso = {
    rotulo: alvo.comando.rotulo || nome, equipamento: alvo.medidor.nome || medidor, quem, desde: Date.now(),
  };

  // só entra como enviado o que passou por todas as verificações
  const palavras = palavrasDoComando(alvo.comando);
  banco.registrar('comando_enviado',
    `${medidor}.${nome} → registrador ${alvo.comando.endereco} = ${palavras.join(', ')}`, quem, de);

  // o barramento fica só para este comando até a realimentação chegar: a
  // varredura dos outros equipamentos daquele fio espera
  const liberarBarramento = col.reservar?.(medidor) || (() => {});

  try {
    const r = await executar({
      comando: alvo.comando,
      idMedidor: medidor,
      coletor: col,
      unitId: onde.unit_id,
      barramento: onde.barramento,
      // confere a realimentação lendo só o equipamento comandado
      lerAgora: async () => ({ ...ultimo.equipamentos, ...(await col.lerUm(medidor)) }),
    });
    if (r.eco_divergente) banco.registrar('comando_eco_divergente', `${medidor}.${nome}: ${r.eco_divergente}`, quem, de);
    banco.registrar(r.confirmado === false ? 'comando_sem_confirmacao' : 'comando_confirmado',
      `${medidor}.${nome}`, quem, de);
    return res.json(r);
  } catch (e) {
    banco.registrar('comando_falhou', `${medidor}.${nome}: ${e.message}`, quem, de);
    return res.status(502).json({ erro: `Falha ao escrever no equipamento: ${e.message}` });
  } finally {
    liberarBarramento();
    comandoEmCurso = null;
  }
});

/* --------------------------------------------------------------- engenharia */

app.get('/api/eng/diagnostico', exigir('tecnico'), (_req, res) => {
  res.json({
    simulado: semModbus,
    intervalo_ms: config.intervalo_leitura_ms,
    barramentos: coletor.listarBarramentos?.() || [],
    equipamentos: coletor.diagnostico?.() || [],
  });
});

app.post('/api/eng/diagnostico/zerar', exigir('tecnico'), (req, res) => {
  coletor.zerarDiagnostico?.();
  banco.registrar('diagnostico_zerado', null, req.usuario.login, origem(req));
  res.json({ ok: true });
});

// uma varredura de endereços por vez: a porta serial é uma só
let varrendo = false;

app.post('/api/eng/varredura', exigir('tecnico'), async (req, res) => {
  const op = req.body || {};
  if (varrendo) return res.status(409).json({ erro: 'já existe uma varredura em andamento' });
  varrendo = true;
  banco.registrar('varredura_barramento', JSON.stringify(op), req.usuario.login, origem(req));
  try {
    if (semModbus) return res.json({ achados: await coletor.varrer(op), simulado: true });
    const { varrerBarramento } = await import('./src/varredura.js');
    const col = coletor;               // se a configuração mudar, retoma o mesmo que pausou
    await col.pausar();                // espera o ciclo em curso e fecha as portas
    try {
      const achados = await varrerBarramento(op);
      return res.json({ achados, simulado: false });
    } finally {
      col.retomar();
    }
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  } finally {
    varrendo = false;
  }
});

const inteiroEntre = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

app.post('/api/eng/ler', exigir('tecnico'), async (req, res) => {
  const { unit_id, funcao = 'holding', endereco = 0, quantidade = 8, barramento } = req.body || {};
  if (!inteiroEntre(unit_id, 1, 247)) return res.status(400).json({ erro: 'endereço de escravo inválido' });
  if (!inteiroEntre(endereco, 0, 65535)) return res.status(400).json({ erro: 'registrador entre 0 e 65535' });
  if (!inteiroEntre(quantidade, 1, 125)) return res.status(400).json({ erro: 'quantidade entre 1 e 125' });
  try {
    const r = await coletor.lerBruto({ unit_id, funcao, endereco, quantidade, barramento });
    return res.json({ ms: r.ms, registradores: r.dados, leitura: interpretar(r.dados) });
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
});

/** Diz de quem é o registrador, se algum comando ou heartbeat o usa neste escravo. */
function registradorReservado(unitId, endereco) {
  for (const m of config.medidores) {
    if ((m.conexao?.unit_id || 1) !== unitId) continue;
    for (const c of m.comandos || []) {
      const [ini, fim] = faixaDoComando(c);
      if (endereco >= ini && endereco <= fim) return `do comando "${c.rotulo || c.nome}" de ${m.nome}`;
    }
    if (m.heartbeat?.endereco === endereco) return `do heartbeat de ${m.nome}`;
  }
  return null;
}

app.post('/api/eng/escrever', exigir('tecnico'), async (req, res) => {
  if (!config.seguranca?.escrita_modbus_liberada) {
    return res.status(403).json({ erro: 'escrita Modbus desabilitada na configuração' });
  }
  const { unit_id, endereco, valor, barramento } = req.body || {};
  if (!inteiroEntre(unit_id, 1, 247) || !inteiroEntre(endereco, 0, 65535) || !inteiroEntre(valor, 0, 65535)) {
    return res.status(400).json({ erro: 'parâmetros inválidos: escravo 1–247, registrador e valor 0–65535' });
  }
  /* Registrador de comando só se escreve pelo comando — com intertravamento,
     senha, confirmação e realimentação. Escrever D100 à mão no terminal
     abriria o disjuntor por fora de tudo isso. O do heartbeat também: um valor
     errado ali engana o watchdog do CLP. */
  const reservado = registradorReservado(unit_id, endereco);
  if (reservado) {
    banco.registrar('modbus_escrita_negada', `id ${unit_id} reg ${endereco}: ${reservado}`, req.usuario.login, origem(req));
    return res.status(403).json({ erro: `registrador ${endereco} é ${reservado}; use o bloco de acionamento` });
  }
  banco.registrar('modbus_escrita', `id ${unit_id} reg ${endereco} = ${valor}`, req.usuario.login, origem(req));
  try {
    await coletor.escreverBruto({ unit_id, endereco, valor, barramento });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }
});

/** Valores do perfil que fazem sentido no formulário: sem nulos e sem notas. */
function limparParaEditor(secao) {
  if (!secao) return null;
  return Object.fromEntries(Object.entries(secao)
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined
      && !['estados', 'modos', 'falhas', 'tag_nivel', 'modos_teste', 'modos_manual'].includes(k)));
}

app.get('/api/eng/perfis', exigir('tecnico'), (_req, res) => {
  res.json({
    perfis: Object.entries(perfis).map(([nome, p]) => ({
      nome,
      titulo: p.titulo,
      fabricante: p.fabricante,
      modelo: p.modelo,
      protocolo: p.protocolo,
      grupo: p.equipamento?.grupo || 'energia',
      tags: p.tags?.length || 0,
      alarmes: p.alarmes?.length || 0,
      observacao: p.observacao || null,
      conexao: p.conexao || {},
      endereco_rs232: p.equipamento?.endereco_rs232 ?? null,
      // seção de tela que este perfil sabe preencher (gerador, reservatório):
      // o editor usa como ponto de partida ao cadastrar o equipamento
      secao: p.gerador ? 'gerador' : p.caixa_agua ? 'caixa_agua' : null,
      secao_padrao: limparParaEditor(p.gerador || p.caixa_agua),
      // limites que o perfil deixa em aberto para a loja preencher
      limites_abertos: (p.alarmes || [])
        .filter((a) => a.tag && a.min === undefined && a.max === undefined && !a.digital && !a.comunicacao)
        .map((a) => ({ tag: a.tag, mensagem: a.mensagem })),
    })),
  });
});

/** Equipamentos no formato que o editor manipula, sem o mapa de registradores. */
app.get('/api/eng/equipamentos', exigir('tecnico'), (_req, res) => {
  res.json({
    equipamentos: (configBruta.medidores || []).map((m) => ({
      id: m.id,
      perfil: m.perfil || null,
      nome: m.nome,
      tag_isa: m.tag_isa || '',
      principal: !!m.principal,
      conexao: m.conexao || {},
      limites: m.limites || {},
      heartbeat: m.heartbeat ?? null,
      varredura_a_cada: m.varredura_a_cada ?? null,
      // um equipamento sem perfil traz o mapa no próprio arquivo: o editor
      // mostra mas não deixa editar, para não destruir um mapa feito à mão
      tags_proprias: m.perfil ? 0 : (m.tags || []).length,
    })),
    unifilar: configBruta.unifilar || null,
    // as seções de tela (gerador, reservatório) chegam já com o que o perfil
    // preenche, para o editor mostrar campo por campo em vez de pedir JSON
    secoes: { gerador: config.gerador || null, caixa_agua: config.caixa_agua || null },
    porta_padrao: (configBruta.medidores || [])[0]?.conexao?.porta_serial || '/dev/ttyUSB0',
  });
});

/**
 * Campos que o editor pode escrever em cada seção de tela. Lista fechada: o que
 * é do modelo do equipamento (estados, modos, falhas) continua vindo do perfil,
 * e nada que chegue do navegador entra na configuração sem passar por aqui.
 */
const CAMPOS_SECAO = {
  gerador: {
    numeros: ['potencia_nominal_kw', 'capacidade_tanque_litros', 'consumo_litros_hora',
      'teste_a_cada_dias', 'modo_automatico', 'bateria_minima_v', 'bateria_repouso_min_v',
      'bateria_partida_min_v', 'bateria_partida_critica_v'],
    textos: ['tag_isa'],
  },
  caixa_agua: {
    numeros: ['capacidade_litros', 'altura_util_m'],
    textos: ['tag_isa', 'formato'],
  },
};
const PRIORIDADES = new Set(['alta', 'media', 'baixa', 'info']);

function limparSecao(nome, recebida) {
  const regras = CAMPOS_SECAO[nome];
  if (!regras || !recebida || typeof recebida !== 'object') return null;
  const limpa = {};
  for (const campo of regras.numeros) {
    const v = recebida[campo];
    if (v === '' || v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${nome}.${campo}: valor inválido`);
    limpa[campo] = n;
  }
  for (const campo of regras.textos) {
    const v = recebida[campo];
    if (typeof v === 'string' && v.trim()) limpa[campo] = v.trim().slice(0, 40);
  }
  if (Array.isArray(recebida.marcas)) {
    limpa.marcas = recebida.marcas
      .filter((m) => m && m.valor !== '' && m.valor !== null && m.valor !== undefined)
      .map((m) => {
        const valor = Number(m.valor);
        if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
          throw new Error(`${nome}: marca de nível fora de 0 a 100 %`);
        }
        return {
          valor,
          rotulo: String(m.rotulo || '').slice(0, 30) || `${valor} %`,
          prioridade: PRIORIDADES.has(m.prioridade) ? m.prioridade : 'media',
        };
      })
      .sort((a, b) => b.valor - a.valor);
  }
  return limpa;
}

/**
 * Bloco de conexão de um equipamento, montado a partir do que o editor mandou.
 * Trocar de serial para Ethernet não pode deixar restos do outro meio no
 * arquivo: cada tipo é reescrito com os seus campos, e só com eles.
 */
function conexaoSalva(nova, antiga = {}) {
  const base = { ...(antiga || {}), ...(nova || {}) };
  const tipo = (nova?.tipo || antiga?.tipo || 'rtu') === 'tcp' ? 'tcp' : 'rtu';
  const unit = Number(base.unit_id);
  if (!Number.isInteger(unit) || unit < 1 || unit > 247) {
    throw new Error('endereço Modbus deve ficar entre 1 e 247');
  }
  const saida = { unit_id: unit };
  if (base.timeout_ms) saida.timeout_ms = Number(base.timeout_ms);

  if (tipo === 'tcp') {
    const host = String(base.host || '').trim();
    // nome de máquina ou IP; nada de barra, espaço ou esquema de URL
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,120}$/.test(host)) {
      throw new Error('endereço IP ou nome de máquina inválido');
    }
    const porta = Number(base.porta) || 502;
    if (porta < 1 || porta > 65535) throw new Error('porta TCP fora de 1 a 65535');
    return { ...saida, tipo: 'tcp', host, porta };
  }

  const serial = { ...saida, tipo: 'rtu', porta_serial: String(base.porta_serial || '').trim() };
  // RS-232 e RS-485 são o mesmo Modbus RTU; a interface muda as regras
  // (RS-232 é ponto a ponto) e a validação usa isso
  if (base.interface !== undefined) {
    if (!['rs232', 'rs485'].includes(base.interface)) throw new Error('interface serial deve ser rs232 ou rs485');
    serial.interface = base.interface;
  }
  if (base.baud !== undefined && base.baud !== '') {
    const baud = Number(base.baud);
    if (![1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200].includes(baud)) {
      throw new Error(`velocidade serial ${base.baud} não suportada`);
    }
    serial.baud = baud;
  }
  for (const campo of ['paridade', 'bits_dados', 'bits_parada']) {
    if (base[campo] !== undefined) serial[campo] = base[campo];
  }
  // folgas de tempo da linha: o editor não mostra, mas também não pode apagar
  for (const campo of ['intervalo_entre_quadros_ms', 'silencio_apos_falha_ms']) {
    if (base[campo] === undefined || base[campo] === '' || base[campo] === null) continue;
    const ms = Number(base[campo]);
    if (!Number.isFinite(ms) || ms < 0 || ms > 2000) throw new Error(`${campo} deve ficar entre 0 e 2000 ms`);
    serial[campo] = ms;
  }
  return serial;
}

/**
 * Salva a lista de equipamentos, preservando tudo que o editor não toca
 * (seções de tela, alarmes locais, mapas feitos à mão) e reconstruindo o
 * unifilar a partir de quem é entrada e quem é alimentador.
 */
app.post('/api/eng/equipamentos', exigir('tecnico'), (req, res) => {
  const lista = req.body?.equipamentos;
  if (!Array.isArray(lista)) return res.status(400).json({ erro: 'lista de equipamentos ausente' });

  const anteriores = new Map((configBruta.medidores || []).map((m) => [m.id, m]));
  let medidores;
  try {
    medidores = lista.map((novo) => {
      const antigo = anteriores.get(novo.id_anterior ?? novo.id) || {};
      const m = {
        ...antigo,
        id: novo.id,
        nome: novo.nome,
        tag_isa: novo.tag_isa || undefined,
        conexao: conexaoSalva(novo.conexao, antigo.conexao),
      };
      if (novo.perfil) m.perfil = novo.perfil;
      if (novo.principal) m.principal = true; else delete m.principal;
      if (novo.limites && Object.keys(novo.limites).length) m.limites = novo.limites;
      else delete m.limites;
      if (novo.varredura_a_cada) m.varredura_a_cada = Number(novo.varredura_a_cada);
      else delete m.varredura_a_cada;
      delete m.id_anterior;
      return m;
    });
  } catch (e) {
    return res.status(400).json({ valido: false, erros: [e.message], avisos: [] });
  }

  const bruta = { ...configBruta, medidores };

  /* Os alarmes da instalação (config.alarmes) apontam para o equipamento pelo
     id. Equipamento removido leva junto os alarmes dele — senão a validação
     recusa o salvamento ("equipamento X não existe") e não há como excluir
     pela tela um medidor que saiu de uso. Renomeado, os alarmes vão junto. */
  const idNovo = new Map(lista.map((n) => [n.id_anterior ?? n.id, n.id]));
  const alarmesRemovidos = [];
  if (Array.isArray(configBruta.alarmes)) {
    bruta.alarmes = configBruta.alarmes.flatMap((r) => {
      const alvo = r.medidor || String(r.tag || '').split('.')[0];
      if (!idNovo.has(alvo)) { alarmesRemovidos.push(r.mensagem || r.tag || alvo); return []; }
      const id = idNovo.get(alvo);
      if (id === alvo) return [r];
      return [r.medidor ? { ...r, medidor: id } : { ...r, tag: `${id}.${String(r.tag).split('.').slice(1).join('.')}` }];
    });
  }
  const comAvisos = (r) => ({
    ...r,
    avisos: [...(r.avisos || []), ...alarmesRemovidos.map((m) => `alarme "${m}" removido junto com o equipamento`)],
  });
  const geradorUnifilar = configBruta.unifilar?.gerador;
  const geradorFica = geradorUnifilar && idNovo.has(geradorUnifilar.medidor)
    ? { gerador: { ...geradorUnifilar, medidor: idNovo.get(geradorUnifilar.medidor) } } : {};

  // o unifilar acompanha os equipamentos de energia, mas o que o usuário já
  // escreveu (rótulo, disjuntor) é preservado por id
  const energia = lista.filter((m) => m.grupo === 'energia');
  const entrada = energia.find((m) => m.principal);
  if (entrada) {
    const saidasAntes = new Map((configBruta.unifilar?.saidas || []).map((s) => [s.medidor, s]));
    bruta.unifilar = {
      entrada: {
        rotulo: configBruta.unifilar?.entrada?.rotulo || 'Concessionária · entrada geral',
        medidor: entrada.id,
      },
      barramento: configBruta.unifilar?.barramento || { rotulo: 'Barramento principal' },
      ...geradorFica,
      saidas: energia.filter((m) => !m.principal).map((m) => ({
        ...(saidasAntes.get(m.id) || {}),
        medidor: m.id,
        rotulo: m.nome,
        tag_isa: m.tag_isa || undefined,
        disjuntor: `${m.limites?.corrente_a?.max ?? 100} A`,
      })),
    };
  } else {
    delete bruta.unifilar;
  }

  /* Seções de tela: o editor manda só os números da instalação. O dono da seção
     é o equipamento do grupo correspondente — sumiu o equipamento, some a seção. */
  try {
    for (const [nome, grupo] of [['gerador', 'gerador'], ['caixa_agua', 'agua']]) {
      const dono = lista.find((m) => m.grupo === grupo);
      if (!dono) { delete bruta[nome]; continue; }
      const recebida = limparSecao(nome, req.body?.secoes?.[nome]);
      if (!recebida && !configBruta[nome]) continue;
      bruta[nome] = { ...(configBruta[nome] || {}), ...(recebida || {}), medidor: dono.id };
    }
  } catch (e) {
    return res.status(400).json({ valido: false, erros: [e.message], avisos: [] });
  }

  try {
    const preparada = prepararConfig(bruta, dirPerfis);
    const veredito = validarConfig(preparada.config);
    if (!veredito.valido) return res.status(400).json(veredito);
    if (req.body?.apenas_validar) return res.json(comAvisos({ ...veredito, previa: bruta }));

    salvarVersao(configBruta);
    const r = aplicarConfig(bruta, req.usuario.login);
    return r.ok ? res.json(comAvisos(r)) : res.status(400).json(r);
  } catch (e) {
    return res.status(400).json({ valido: false, erros: [e.message], avisos: [] });
  }
});

app.get('/api/eng/config', exigir('tecnico'), (_req, res) => {
  res.json({ bruta: configBruta, versoes: listarVersoes() });
});

app.post('/api/eng/config/validar', exigir('tecnico'), (req, res) => {
  try {
    const { config: efetiva } = prepararConfig(req.body?.config, dirPerfis);
    return res.json(validarConfig(efetiva));
  } catch (e) {
    return res.json({ valido: false, erros: [e.message], avisos: [] });
  }
});

function listarVersoes() {
  if (!fs.existsSync(dirVersoes)) return [];
  return fs.readdirSync(dirVersoes).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 20);
}

function salvarVersao(bruta) {
  fs.mkdirSync(dirVersoes, { recursive: true });
  const nome = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(dirVersoes, nome), JSON.stringify(bruta, null, 2));
  const antigas = fs.readdirSync(dirVersoes).sort().slice(0, -20);
  for (const a of antigas) fs.unlinkSync(path.join(dirVersoes, a));
  return nome;
}

/** Troca a configuração em operação sem derrubar o processo nem o histórico. */
function aplicarConfig(bruta, quem) {
  if (!bruta || typeof bruta !== 'object') {
    return { ok: false, valido: false, erros: ['configuração ausente ou inválida'], avisos: [] };
  }
  const preparada = prepararConfig(bruta, dirPerfis);
  const veredito = validarConfig(preparada.config);
  if (!veredito.valido) return { ok: false, ...veredito };

  // qualquer aplicação nova substitui a rede de segurança pendente: sem isso,
  // salvar pelo editor dentro dos 90 s e ninguém responder faria o sistema
  // voltar para uma configuração mais velha que a última salva
  clearTimeout(relogioRollback);
  relogioRollback = null;

  const anterior = configBruta;
  configBruta = bruta;
  config = preparada.config;
  perfis = preparada.perfis;

  // o coletor novo só abre a serial depois que o antigo terminou o quadro em
  // curso e fechou a porta: os dois nunca falam juntos no mesmo barramento
  const fechado = Promise.resolve(coletor.encerrar?.()).catch(() => {});
  coletor = semModbus ? new Simulador(config, { roteiro: comRoteiro }) : new Coletor(config, { aposFechar: fechado });
  motorAlarmes = new MotorAlarmes(config.alarmes || [], banco);
  motorGerador = new MotorGerador(config.gerador || {}, banco);
  ultimo = { ts: Date.now(), equipamentos: {}, alarmes: [], simulado: semModbus };

  fs.writeFileSync(arquivoEmUso, `${JSON.stringify(bruta, null, 2)}\n`);
  banco.registrar('config_aplicada', `${config.medidores.length} equipamentos`, quem, null);
  transmitir({ tipo: 'config' });
  // uma varredura imediata evita que as telas fiquem em branco entre o
  // "aplicado" e o próximo ciclo do laço
  varrer().catch(() => {});
  return { ok: true, ...veredito, anterior };
}

app.post('/api/eng/config/aplicar', exigir('tecnico'), (req, res) => {
  let r;
  try {
    r = aplicarConfig(req.body?.config, req.usuario.login);
  } catch (e) {
    return res.status(400).json({ valido: false, erros: [e.message], avisos: [] });
  }
  if (!r.ok) return res.status(400).json(r);
  const versao = salvarVersao(r.anterior);

  // rede de segurança: se nada responder em 90 s, volta sozinho para a anterior
  const anterior = r.anterior;
  relogioRollback = setTimeout(() => {
    const vivos = Object.values(ultimo.equipamentos).filter((e) => e.online).length;
    if (vivos === 0 && !semModbus) {
      console.warn('[rollback] nenhum equipamento respondeu; voltando à configuração anterior');
      banco.registrar('config_revertida', 'nenhum equipamento respondeu após 90 s', 'sistema', null);
      aplicarConfig(anterior, 'sistema');
    }
  }, 90000);
  if (relogioRollback.unref) relogioRollback.unref();

  return res.json({ ...r, versao_salva: versao, rollback_em_s: 90 });
});

app.post('/api/eng/config/restaurar', exigir('tecnico'), (req, res) => {
  const nome = String(req.body?.versao || '');
  if (!/^[\w.-]+\.json$/.test(nome)) return res.status(400).json({ erro: 'versão inválida' });
  const arquivo = path.join(dirVersoes, nome);
  if (!fs.existsSync(arquivo)) return res.status(404).json({ erro: 'versão não encontrada' });
  salvarVersao(configBruta);
  const r = aplicarConfig(JSON.parse(fs.readFileSync(arquivo, 'utf8')), req.usuario.login);
  return r.ok ? res.json(r) : res.status(400).json(r);
});

/* -------------------------------------------------------------------- nuvem */

// Ligação com o Engemase Pulse pela interface: o técnico cola o endereço e o
// token gerado na nuvem. O token nunca volta para a tela (só o final dele).
app.get('/api/eng/nuvem', exigir('tecnico'), (_req, res) => res.json(nuvem.resumo()));

app.post('/api/eng/nuvem', exigir('tecnico'), (req, res) => {
  const anterior = nuvem.conf;
  const r = validarLigacao(req.body, anterior);
  if (!r.ok) return res.status(400).json({ erro: r.erros.join('; '), erros: r.erros });
  ligacaoNuvem.gravar(r.dados);
  nuvem.reiniciar({ historico: Boolean(anterior.token) && anterior.token !== r.dados.token });
  banco.registrar('nuvem_ligada', `${r.dados.url} · token …${r.dados.token.slice(-4)}`, req.usuario.login, origem(req));
  return res.json(nuvem.resumo());
});

// tira a ligação feita pela tela (a seção "nuvem" do config.json, se houver, volta a valer)
app.post('/api/eng/nuvem/remover', exigir('tecnico'), (req, res) => {
  ligacaoNuvem.apagar();
  nuvem.reiniciar();
  banco.registrar('nuvem_removida', 'ligação da interface removida', req.usuario.login, origem(req));
  return res.json(nuvem.resumo());
});

/* ------------------------------------------------------------------ usuários */

app.get('/api/usuarios', exigir('admin'), (_req, res) => res.json({ usuarios: banco.listarUsuarios() }));

app.post('/api/usuarios', exigir('admin'), (req, res) => {
  const { login, nome, papel, senha } = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(login || '')) return res.status(400).json({ erro: 'login inválido' });
  if (!PAPEIS[papel]) return res.status(400).json({ erro: 'papel inválido' });
  const problemas = forcaDaSenha(senha);
  if (problemas.length) return res.status(400).json({ erro: `senha fraca: ${problemas.join(', ')}` });
  if (banco.usuarioPorLogin(login)) return res.status(409).json({ erro: 'login já existe' });

  const { sal, hash } = gerarHash(senha);
  banco.criarUsuario({ login, nome: nome || login, papel, sal, hash, trocar_senha: 1, criado_em: Date.now() });
  banco.registrar('usuario_criado', `${login} (${papel})`, req.usuario.login, origem(req));
  return res.json({ ok: true });
});

app.patch('/api/usuarios/:id', exigir('admin'), (req, res) => {
  const id = Number(req.params.id);
  const alvo = banco.listarUsuarios().find((u) => u.id === id);
  if (!alvo) return res.status(404).json({ erro: 'usuário não encontrado' });

  const campos = {};
  if (req.body.nome) campos.nome = String(req.body.nome).slice(0, 60);
  if (req.body.papel && PAPEIS[req.body.papel]) campos.papel = req.body.papel;
  if (req.body.ativo !== undefined) campos.ativo = req.body.ativo ? 1 : 0;
  if (req.body.senha) {
    const problemas = forcaDaSenha(req.body.senha);
    if (problemas.length) return res.status(400).json({ erro: `senha fraca: ${problemas.join(', ')}` });
    Object.assign(campos, gerarHash(req.body.senha), { trocar_senha: 1 });
  }

  // não dá para ficar sem administrador nem se rebaixar sozinho
  const perdeAdmin = alvo.papel === 'admin' && (campos.papel && campos.papel !== 'admin' || campos.ativo === 0);
  if (perdeAdmin && banco.contarAdmins() <= 1) {
    return res.status(400).json({ erro: 'é preciso manter pelo menos um administrador ativo' });
  }
  if (alvo.id === req.usuario.id && (campos.ativo === 0 || (campos.papel && campos.papel !== 'admin'))) {
    return res.status(400).json({ erro: 'não é possível rebaixar ou desativar a própria conta' });
  }

  banco.atualizarUsuario(id, campos);
  // a senha nova chega como hash: é por ele que se sabe que ela mudou
  if (campos.hash || campos.ativo === 0 || campos.papel) {
    banco.encerrarSessoesDoUsuario(id);
    fecharCanais((ws) => ws.usuarioId === id);
  }
  banco.registrar('usuario_alterado', `${alvo.login}: ${Object.keys(campos).join(', ')}`, req.usuario.login, origem(req));
  return res.json({ ok: true });
});

app.get('/api/auditoria', exigir('admin'), (req, res) => {
  res.json({ registros: banco.auditoria(Math.min(Number(req.query.limite) || 200, 1000)) });
});

/* -------------------------------------------------------- arquivos estáticos */

/**
 * Nada de cache com prazo. Um cache de uma hora faz o navegador misturar a
 * página antiga com o código novo depois de uma atualização, e o operador vê
 * a tela quebrar sem entender por quê. Com `no-cache` o navegador ainda
 * reaproveita o arquivo, mas só depois de revalidar pelo ETag — numa rede
 * local isso custa um 304 de alguns bytes.
 */
const estaticos = express.static(path.join(raiz, 'public'), {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: (res, arquivo) => {
    res.setHeader('Cache-Control', arquivo.endsWith('.html') ? 'no-store' : 'no-cache');
  },
});

const enviarPagina = (res, nome) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(raiz, 'public', nome));
};

app.get('/login', (_req, res) => enviarPagina(res, 'login.html'));
// o navegador pede /favicon.ico por conta própria (aba, favoritos): é o mesmo ícone das páginas
app.get('/favicon.ico', (_req, res) => {
  const icone = path.join(raiz, 'public/assets/marcas/icone.png');
  if (!fs.existsSync(icone)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('png').sendFile(icone);
});
app.get('/', (req, res) => {
  if (!req.usuario) return res.redirect('/login');
  return enviarPagina(res, 'index.html');
});
/**
 * O demo.html é para abrir do disco, sem servidor: ele embute a configuração
 * real da loja e roda com scripts internos que o CSP daqui bloqueia. Servido
 * pelo supervisório, só vazaria a planta e abriria uma página quebrada.
 */
app.get('/demo.html', (_req, res) => res.status(404).json({ erro: 'a demonstração abre direto do arquivo, sem servidor' }));

app.use((req, res, next) => {
  // a interface só é servida para quem já entrou; a tela de login, o CSS dela,
  // as fontes que o CSS pede e os logos que ela mostra ficam livres
  const livre = /^\/(login\.html|assets\/(estilo|login)\.(css|js)|assets\/fontes\/[\w.-]+\.woff2|assets\/marcas\/[\w-]+\.(svg|png|webp))$/.test(req.path);
  if (!req.usuario && !livre) {
    res.status(401);
    return enviarPagina(res, 'login.html');
  }
  return next();
}, estaticos);

app.use((req, res) => res.status(404).json({ erro: `rota desconhecida: ${req.path}` }));

/* -------------------------------------------------------------- tempo real */

const servidor = credenciaisTls ? https.createServer(credenciaisTls, app) : http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

// o WebSocket herda a mesma sessão do cookie: nada de canal sem autenticação
servidor.on('upgrade', (req, socket, cabeca) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const usuario = acesso.usuarioDoToken(lerCookie(req.headers.cookie, 'painel_sessao'));
  if (!usuario) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  return wss.handleUpgrade(req, socket, cabeca, (ws) => {
    ws.usuario = usuario.login;
    ws.usuarioId = usuario.id;
    ws.token = usuario.token;
    wss.emit('connection', ws, req);
  });
});

/**
 * Canal cuja sessão acabou é fechado com 4001: o painel entende como "entre de
 * novo" e vai para o login. Sem isso, um posto de onde se saiu — ou de um
 * usuário desativado — continuaria recebendo os dados ao vivo.
 */
const SESSAO_ENCERRADA = 4001;
function fecharCanais(filtro) {
  for (const ws of wss.clients) if (filtro(ws)) ws.close(SESSAO_ENCERRADA, 'sessao encerrada');
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => ws.terminate());
  ws.send(JSON.stringify(ultimo));
});

const vigia = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  // sessão que venceu, ou usuário desativado, fecha o canal no próximo giro
  fecharCanais((ws) => !acesso.usuarioDoToken(ws.token));
  banco.limparSessoesVencidas();
  acesso.tentativas.limpar();
  acesso.tentativasPorLogin.limpar();
}, 30000);

function transmitir(extra) {
  const pacote = JSON.stringify(extra ? { ...ultimo, ...extra } : ultimo);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(pacote);
}

async function varrer() {
  try {
    const equipamentos = await coletor.lerTodos();
    const ts = Date.now();
    // as tags calculadas entram ANTES dos alarmes: prontidão e dias sem partir
    // são alarmáveis como qualquer outra
    motorGerador.avaliar(equipamentos, ts);
    const alarmes = motorAlarmes.avaliar(equipamentos, ts);
    ultimo = { ts, equipamentos, alarmes, simulado: semModbus };
    if (ts - ultimaGravacao >= config.historico.intervalo_gravacao_s * 1000) {
      ultimaGravacao = ts;
      // disco cheio (ou banco com defeito) perde o histórico, mas a tela ao
      // vivo, os alarmes e os comandos seguem
      try {
        banco.gravarAmostras(ts, equipamentos);
        falhaGravacao = null;
      } catch (e) {
        if (!falhaGravacao) console.error('[histórico] não consegui gravar:', e.message);
        falhaGravacao = e.message;
      }
    }
    transmitir();
    nuvem.aoVivo(ultimo);
    await coletor.enviarHeartbeats?.();
  } catch (e) {
    console.error('[varredura]', e.message);
  }
}

async function laco() {
  if (encerrando) return;
  const inicio = Date.now();
  await varrer();
  setTimeout(laco, Math.max(50, (config.intervalo_leitura_ms || 1000) - (Date.now() - inicio)));
}

/** Grandezas com histórico — as consultas de limpeza e resumo vão uma a uma pelo índice. */
const tagsDoHistorico = () => config.medidores.flatMap((m) => m.tags.map((t) => `${m.id}.${t.nome}`));

const limpeza = setInterval(() => banco.limparAntigos(config.historico.retencao_dias ?? null), 6 * 3600000);

/* Espaço em disco. Sem prazo fixo: o histórico enche o disco até sobrar o
   mínimo (1 GB) e daí, conforme chega dado novo, sai o DIA mais antigo. Cada
   computador guarda o quanto couber — disco e número de equipamentos variam de
   loja para loja (a E01, com ~300 grandezas a cada 15 s, grava ~150 MB por dia).
   "Livre" conta o disco e o espaço já reservado dentro do banco: o arquivo não
   encolhe quando apaga, mas o lugar das linhas apagadas é reaproveitado, então
   apagar um dia segura ~1 dia de gravação antes de precisar apagar o próximo.
   Ordem: primeiro o bruto de 15 s (nunca abaixo de 3 dias); com o bruto no
   mínimo e ainda sem espaço, o resumo de 5 min (nunca abaixo de 30 dias). */
const ESPACO_MINIMO_MB = config.historico.espaco_minimo_mb ?? 1024;
function conferirDisco() {
  try {
    const livreNoDisco = () => { const s = fs.statfsSync(path.dirname(arquivoDoBanco)); return s.bavail * s.bsize; };
    const minimo = ESPACO_MINIMO_MB * 1048576;
    const apertado = () => livreNoDisco() + banco.livreNoArquivo() < minimo;
    // a prontidão do gerador tem prazo próprio (120 dias, limparAntigos): fica fora
    const tags = tagsDoHistorico().filter((t) => !t.endsWith('.pronto'));
    if (!apertado()) return;
    let dias = 0;
    while (apertado() && dias < 30 && banco.apagarMaisAntigo(24, 3, Date.now(), tags)) dias++;
    let diasResumo = 0;
    while (apertado() && diasResumo < 30 && banco.apagarResumoMaisAntigo(tags, 24, 30)) diasResumo++;
    if (dias || diasResumo) {
      const inicio = banco.inicioDoHistorico(tags);
      console.warn(`[disco] ${Math.round(livreNoDisco() / 1048576)} MB livres: apagado(s) ${dias} dia(s) do histórico de 15 s`
        + `${diasResumo ? ` e ${diasResumo} do resumo de 5 min` : ''}; o de 15 s começa em ${inicio ? new Date(inicio).toLocaleDateString('pt-BR') : '—'}`);
    }
  } catch (e) {
    console.error('[disco]', e.message);
  }
}

/* Resumo de 5 min para os gráficos de vários dias. Em dia: a cada 5 min. Logo
   depois da atualização há dias de bruto para resumir: vai em partes de 2 h
   (~0,2 s com 300 grandezas) a cada 10 s, para não segurar a leitura dos
   equipamentos. */
let resumoAgendado = null;
function resumirHistorico() {
  let emDia = true;
  try {
    emDia = banco.resumirAmostras(tagsDoHistorico());
  } catch (e) {
    console.error('[histórico de 5 min]', e.message);
  }
  resumoAgendado = setTimeout(resumirHistorico, emDia ? 5 * 60000 : 10000);
}
resumoAgendado = setTimeout(resumirHistorico, 15000);
const conferenciaDisco = setInterval(conferirDisco, 10 * 60000);
setTimeout(conferirDisco, 30000).unref?.();

/* Consumo por hora: a cada 5 min, as horas fechadas das últimas 48 h vão para
   a tabela consolidada — antes de a limpeza apagar o histórico bruto. Também
   roda logo na partida, para recuperar o que fechou com o servidor parado. */
const consolidarConsumo = () => {
  try { consolidar(banco, config); } catch (e) { console.error('[consumo]', e.message); }
};
const consolidacao = setInterval(consolidarConsumo, 5 * 60000);
setTimeout(consolidarConsumo, 10000).unref?.();
laco();

servidor.listen(config.porta_http, config.endereco_http || '0.0.0.0', () => {
  console.log(`Supervisório em ${credenciaisTls ? 'https' : 'http'}://${config.endereco_http || '0.0.0.0'}:${config.porta_http}`
    + `${semModbus ? '  (modo simulado)' : ''}`);
  if (!credenciaisTls) {
    console.warn('aviso: sem seguranca.tls, senhas e comandos trafegam sem criptografia na rede');
  }
  console.log(`${config.medidores.length} equipamentos · varredura a cada ${config.intervalo_leitura_ms} ms`);
  console.log(`configuração: ${path.basename(arquivoEmUso)}`);
  for (const m of config.medidores) {
    const c = m.conexao;
    const onde = c.tipo === 'rtu' ? `${c.porta_serial} ${c.baud} 8${(c.paridade || 'none')[0].toUpperCase()}${c.bits_parada || 1}` : `${c.host}:${c.porta || 502}`;
    console.log(`  ${String(c.unit_id).padStart(3)}  ${m.nome.padEnd(26)} ${onde}${m.heartbeat ? `  heartbeat D${m.heartbeat.endereco}` : ''}`);
  }
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    encerrando = true;
    clearInterval(vigia);
    clearInterval(limpeza);
    clearInterval(conferenciaDisco);
    clearTimeout(resumoAgendado);
    clearInterval(consolidacao);
    clearTimeout(relogioRollback);
    coletor.encerrar?.();
    nuvem.parar();
    for (const ws of wss.clients) ws.close();
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
