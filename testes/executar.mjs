/* Bateria de testes sem dependências externas: node testes/executar.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { montarBuffer, decodificar, prepararTag, montarBlocos } from '../src/mapa.js';
import { MotorAlarmes } from '../src/alarmes.js';
import { Simulador } from '../src/simulador.js';
import {
  prepararConfig, expandirPerfis, validarConfig, carregarPerfis, secoesDosPerfis,
} from '../src/perfis.js';
import {
  gerarHash, conferirSenha, forcaDaSenha, ControleDeTentativas, Acesso, lerCookie, origemDaRequisicao,
} from '../src/auth.js';
import { interpretar } from '../src/mapa.js';
import {
  impedimentos, estadoDosComandos, acharComando, executar,
  condicaoAtendida, textoDoValor,
} from '../src/comandos.js';
import { MotorGerador } from '../src/gerador.js';
import { Nuvem, LigacaoNuvem, validarLigacao } from '../src/nuvem.js';
import os from 'node:os';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// dados/ fica fora do Git: num clone novo ela ainda não existe, e vários testes gravam bancos ali
fs.mkdirSync(path.join(raiz, 'dados'), { recursive: true });
const bruta = JSON.parse(fs.readFileSync(path.join(raiz, 'config.json'), 'utf8'));
const { config: cfg, perfis } = prepararConfig(bruta, path.join(raiz, 'perfis'));

let passou = 0; let falhou = 0;
const ok = (nome, cond, detalhe = '') => {
  if (cond) { passou++; console.log('  ✓', nome); }
  else { falhou++; console.log('  ✗', nome, detalhe); }
};
const perto = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

/* A bancada como foi entregue. Os testes de perfil não leem config.fx3u.json:
   é o arquivo que a tela de Engenharia grava, e ele muda toda vez que alguém
   mexe na bancada (trocar de perfil, cadastrar um gerador). */
const BANCADA_FX3U = {
  planta: 'Bancada — CLP FX3U',
  porta_http: 8080,
  intervalo_leitura_ms: 1000,
  seguranca: { comandos_liberados: true },
  telas: { gerador: true },
  historico: { intervalo_gravacao_s: 15, retencao_dias: 90, arquivo: 'dados/bancada.db' },
  medidores: [{
    id: 'clp', perfil: 'clp-fx3u-disjuntor', tag_isa: 'CLP-01', nome: 'CLP FX3U',
    conexao: {
      tipo: 'rtu', porta_serial: 'COM7', unit_id: 1, baud: 9600, paridade: 'none', bits_dados: 8, bits_parada: 1, timeout_ms: 1000,
    },
  }],
  caixa_agua: { medidor: 'clp', capacidade_litros: 10000, altura_util_m: 2 },
};
const bancadaFx3u = () => structuredClone(BANCADA_FX3U);

console.log('\nDecodificação de tipos');
{
  // 220,5 em float32 = 0x435C8000
  ok('float32 ABCD', perto(decodificar([0x435C, 0x8000], 'float32', 'ABCD'), 220.5));
  ok('float32 CDAB', perto(decodificar([0x8000, 0x435C], 'float32', 'CDAB'), 220.5));
  ok('float32 DCBA', perto(decodificar([0x0080, 0x5C43], 'float32', 'DCBA'), 220.5));
  ok('int16 negativo', decodificar([0xFFF6], 'int16') === -10);
  ok('uint16', decodificar([0xFFF6], 'uint16') === 65526);
  ok('uint32', decodificar([0x0001, 0x86A0], 'uint32') === 100000);
  ok('buffer de tamanho ímpar não quebra', montarBuffer([1, 2, 3], 'CDAB').length === 6);
}

console.log('\nPreparação de tags');
{
  const bit = prepararTag({ nome: 'x', endereco: 10, bit: 3 }, { funcao: 'holding', tipo: 'float32' });
  ok('tag de bit ocupa 1 registrador', bit.palavras === 1 && bit.tipo === 'uint16');
  const coil = prepararTag({ nome: 'y', endereco: 4, funcao: 'coil' }, {});
  ok('coil ocupa 1 registrador', coil.palavras === 1);
  const f = prepararTag({ nome: 'z', endereco: 0 }, { tipo: 'float32', escala: 0.1 });
  ok('escala do padrão é herdada', f.escala === 0.1 && f.palavras === 2);
}

console.log('\nAgrupamento de blocos');
{
  for (const m of cfg.medidores) {
    const blocos = montarBlocos(m.tags, m.padrao);
    const limite = m.padrao.max_registradores ?? 100;
    const excede = blocos.filter((b) => b.fim - b.inicio > limite);
    ok(`${m.id}: nenhum bloco acima de ${limite} registradores`, excede.length === 0,
      excede.map((b) => `${b.inicio}..${b.fim}`).join(','));
    const lidas = new Set(blocos.flatMap((b) => b.tags.map((t) => t.nome)));
    // tags calculadas (prontidão, autonomia) não são lidas do equipamento
    const doBarramento = m.tags.filter((t) => !t.calculada);
    ok(`${m.id}: todas as ${doBarramento.length} tags cobertas`, lidas.size === doBarramento.length);
    ok(`${m.id}: nenhuma tag calculada vai ao barramento`,
      !blocos.some((b) => b.tags.some((t) => t.calculada)));
    const misturado = blocos.some((b) => new Set(b.tags.map((t) => t.funcao)).size > 1);
    ok(`${m.id}: cada bloco usa uma função só`, !misturado);
  }
}

console.log('\nExtração de bits');
{
  const tags = [
    { nome: 'b0', endereco: 10, bit: 0 }, { nome: 'b3', endereco: 10, bit: 3 },
    { nome: 'b9', endereco: 10, bit: 9 },
  ].map((t) => prepararTag(t, { funcao: 'holding' }));
  const bloco = { funcao: 'holding', inicio: 10, fim: 11, tags };
  const dados = [0b0000_0010_0000_1001];   // bits 0, 3 e 9 ligados
  const extrair = (tag) => ((dados[tag.endereco - bloco.inicio] >> tag.bit) & 1);
  ok('bit 0', extrair(tags[0]) === 1);
  ok('bit 3', extrair(tags[1]) === 1);
  ok('bit 9', extrair(tags[2]) === 1);
  ok('bit não setado', ((dados[0] >> 5) & 1) === 0);
}

/* --------- banco falso, para exercitar o motor de alarmes sem SQLite --------- */
class BancoFalso {
  constructor() { this.linhas = []; this.seq = 0; }
  abrirAlarme(a) { const id = ++this.seq; this.linhas.push({ ...a, id, fim: null, reconhecido: 0 }); return id; }
  fecharAlarme(id, fim) { const l = this.linhas.find((x) => x.id === id); if (l && !l.fim) l.fim = fim; }
  atualizarValorAlarme(id, v) { const l = this.linhas.find((x) => x.id === id); if (l) l.valor = v; }
  reconhecerAlarme(id) { const l = this.linhas.find((x) => x.id === id); if (l) l.reconhecido = 1; }
  reconhecerTodos() { this.linhas.forEach((l) => { if (!l.fim) l.reconhecido = 1; }); }
  alarmesAtivos() { return this.linhas.filter((l) => !l.fim); }
  historicoAlarmes() { return this.linhas; }
}

console.log('\nMotor de alarmes');
{
  const eq = (valores, online = true) => ({ tq: { id: 'tq', online, valores } });

  // analógico com atraso de confirmação
  let banco = new BancoFalso();
  let motor = new MotorAlarmes([{ tag: 'tq.n', min: 30, prioridade: 'alta', mensagem: 'baixo', atraso_s: 10 }], banco);
  let t = 1000;
  motor.avaliar(eq({ n: 20 }), t);
  ok('não abre antes do atraso', banco.alarmesAtivos().length === 0);
  motor.avaliar(eq({ n: 20 }), t + 5000);
  ok('continua fechado no meio do atraso', banco.alarmesAtivos().length === 0);
  motor.avaliar(eq({ n: 20 }), t + 11000);
  ok('abre depois do atraso', banco.alarmesAtivos().length === 1);
  motor.avaliar(eq({ n: 30.1 }), t + 12000);
  ok('histerese segura o alarme perto do limite', banco.alarmesAtivos().length === 1);
  motor.avaliar(eq({ n: 31 }), t + 13000);
  ok('normaliza fora da banda morta', banco.alarmesAtivos().length === 0);

  // condição intermitente não deve abrir
  banco = new BancoFalso();
  motor = new MotorAlarmes([{ tag: 'tq.n', max: 10, prioridade: 'media', mensagem: 'pico', atraso_s: 5 }], banco);
  motor.avaliar(eq({ n: 50 }), 0);
  motor.avaliar(eq({ n: 1 }), 2000);
  motor.avaliar(eq({ n: 50 }), 4000);
  motor.avaliar(eq({ n: 50 }), 6000);
  ok('pico intermitente não vira alarme', banco.alarmesAtivos().length === 0);

  // digital direto e invertido
  banco = new BancoFalso();
  motor = new MotorAlarmes([
    { tag: 'tq.falha', digital: true, prioridade: 'alta', mensagem: 'falha' },
    { tag: 'tq.auto', digital: true, inverso: true, prioridade: 'baixa', mensagem: 'fora do automático' },
  ], banco);
  motor.avaliar(eq({ falha: 0, auto: 1 }), 0);
  ok('digital em repouso não alarma', banco.alarmesAtivos().length === 0);
  motor.avaliar(eq({ falha: 1, auto: 0 }), 1000);
  ok('digital ligado e invertido desligado alarmam', banco.alarmesAtivos().length === 2);
  motor.avaliar(eq({ falha: 0, auto: 1 }), 2000);
  ok('digitais normalizam', banco.alarmesAtivos().length === 0);

  // falha de comunicação
  banco = new BancoFalso();
  motor = new MotorAlarmes([
    { medidor: 'tq', comunicacao: true, prioridade: 'alta', mensagem: 'sem comunicação' },
    { tag: 'tq.n', min: 30, prioridade: 'alta', mensagem: 'baixo' },
  ], banco);
  motor.avaliar(eq({ n: 10 }, false), 0);
  const ativos = banco.alarmesAtivos();
  ok('offline abre só o alarme de comunicação', ativos.length === 1 && ativos[0].mensagem === 'sem comunicação');
  motor.avaliar(eq({ n: 10 }, true), 1000);
  ok('ao voltar, comunicação fecha e o de processo abre',
    banco.alarmesAtivos().length === 1 && banco.alarmesAtivos()[0].mensagem === 'baixo');

  // reinício do servidor não duplica alarme aberto
  const banco2 = new BancoFalso();
  const regras = [{ tag: 'tq.n', min: 30, prioridade: 'alta', mensagem: 'baixo' }];
  const m1 = new MotorAlarmes(regras, banco2);
  m1.avaliar(eq({ n: 10 }), 0);
  const m2 = new MotorAlarmes(regras, banco2);
  m2.avaliar(eq({ n: 10 }), 1000);
  ok('reinício reaproveita o alarme já aberto', banco2.alarmesAtivos().length === 1);
}

console.log('\nSimulador e coerência da planta');
{
  const sim = new Simulador(cfg);
  sim.t = 0;
  let vistos = new Set();
  let nivelMin = 100; let nivelMax = 0; let rodou = false;
  for (let i = 0; i < 260; i++) {
    const eqs = await sim.lerTodos();
    const g = eqs.geral.valores;
    const soma = Object.values(eqs)
      .filter((e) => e.grupo === 'energia' && e.id !== 'geral')
      .reduce((s, e) => s + e.valores.potencia_ativa, 0);
    if (!perto(g.potencia_ativa, soma, 0.01)) { falhou++; console.log('  ✗ entrada não fecha com a soma'); break; }
    nivelMin = Math.min(nivelMin, eqs.clp.valores.nivel);
    nivelMax = Math.max(nivelMax, eqs.clp.valores.nivel);
    if (eqs.gmg.valores.estado === 3) rodou = true;
    vistos.add(eqs.gmg.valores.estado);
  }
  ok('entrada fecha com a soma dos alimentadores em 260 ciclos', true);
  ok('caixa d\'água oscila entre encher e consumir', nivelMax - nivelMin > 1,
    `${nivelMin.toFixed(1)}..${nivelMax.toFixed(1)}`);
  ok('gerador percorre o ciclo até assumir carga', rodou, [...vistos].join(','));
  ok('nível não sai da faixa 0-100', nivelMin >= 0 && nivelMax <= 100);
}

console.log('\nRegras do config');
{
  const ids = new Set(cfg.medidores.map((m) => m.id));
  const semAlvo = (cfg.alarmes || []).filter((r) => {
    const id = r.medidor || String(r.tag).split('.')[0];
    return !ids.has(id);
  });
  ok('toda regra aponta para um equipamento existente', semAlvo.length === 0,
    semAlvo.map((r) => r.tag || r.medidor).join(','));

  const semTag = (cfg.alarmes || []).filter((r) => {
    if (r.comunicacao) return false;
    const [id, nome] = String(r.tag).split('.');
    return !cfg.medidores.find((m) => m.id === id)?.tags.some((t) => t.nome === nome);
  });
  ok('toda regra aponta para uma tag existente', semTag.length === 0, semTag.map((r) => r.tag).join(','));

  const unidades = new Set(cfg.medidores.map((m) => `${m.conexao.porta_serial || m.conexao.host}#${m.conexao.unit_id}`));
  ok('nenhum endereço Modbus repetido no barramento', unidades.size === cfg.medidores.length);

  const digitaisComEscala = cfg.medidores.flatMap((m) => m.tags)
    .filter((t) => Number.isInteger(t.bit) && t.escala !== undefined);
  ok('tags de bit não usam escala', digitaisComEscala.length === 0);
}


console.log('\nPerfis de equipamento');
{
  ok('perfis carregados', Object.keys(perfis).length >= 5);
  ok('config da loja é enxuta', JSON.stringify(bruta).length < JSON.stringify(cfg).length / 2);
  const padaria = cfg.medidores.find((m) => m.id === 'padaria');
  // correntes I1–I3, potência ativa e aparente, energia ativa e aparente,
  // THD de corrente I1–I3 e as 4 correntes harmônicas calculadas
  ok('tags vêm do perfil', padaria.tags.length === 14, String(padaria.tags.length));
  const regra = cfg.alarmes.find((a) => a.tag === 'padaria.corrente_a');
  ok('limite da loja entra no alarme do perfil', regra?.max === 250, JSON.stringify(regra));
  ok('mensagem do perfil recebe o nome do circuito', regra.mensagem.startsWith('Padaria'));
  const comunicacao = cfg.alarmes.filter((a) => a.comunicacao);
  ok('todo equipamento ganha alarme de comunicação', comunicacao.length === cfg.medidores.length);

  // ajuste local vence o perfil, sem duplicar o mapa
  const local = expandirPerfis({ medidores: [{ id: 'x', perfil: '7kt0310-alimentador',
    conexao: { unit_id: 5 }, tags: [{ nome: 'corrente_a', escala: 5 }] }] }, perfis);
  ok('tag local sobrepõe a do perfil',
    local.medidores[0].tags.find((t) => t.nome === 'corrente_a').escala === 5);
  ok('as demais tags do perfil continuam', local.medidores[0].tags.length === 14);

  const semAgua = { ...bruta, medidores: bruta.medidores.filter((m) => m.id !== 'clp') };
  delete semAgua.caixa_agua;
  const r = validarConfig(prepararConfig(semAgua, path.join(raiz, 'perfis')).config);
  ok('loja sem caixa d\'água é uma configuração válida', r.valido, r.erros.join(','));
}

console.log('\nValidação de configuração');
{
  const clonar = () => JSON.parse(JSON.stringify(bruta));
  const comRepetido = clonar();
  comRepetido.medidores[1].conexao.unit_id = comRepetido.medidores[0].conexao.unit_id;
  let r = validarConfig(prepararConfig(comRepetido, path.join(raiz, 'perfis')).config);
  ok('endereço Modbus repetido é recusado', !r.valido && /repetido/.test(r.erros[0]));

  const comAlarmeOrfao = clonar();
  comAlarmeOrfao.alarmes.push({ tag: 'inexistente.x', max: 1, prioridade: 'alta', mensagem: 'teste' });
  r = validarConfig(prepararConfig(comAlarmeOrfao, path.join(raiz, 'perfis')).config);
  ok('alarme apontando para equipamento inexistente é recusado', !r.valido);

  const semLimite = clonar();
  semLimite.alarmes.push({ tag: 'geral.fp', prioridade: 'alta', mensagem: 'sem limite' });
  r = validarConfig(prepararConfig(semLimite, path.join(raiz, 'perfis')).config);
  ok('alarme sem min, max nem digital é recusado', !r.valido);

  const perfilInexistente = clonar();
  perfilInexistente.medidores[0].perfil = 'nao-existe';
  let lancou = false;
  try { prepararConfig(perfilInexistente, path.join(raiz, 'perfis')); } catch { lancou = true; }
  ok('perfil inexistente falha na carga', lancou);
}

console.log('\nAcesso e senhas');
{
  const { sal, hash } = gerarHash('SenhaBoa123');
  ok('senha correta confere', conferirSenha('SenhaBoa123', sal, hash));
  ok('senha errada não confere', !conferirSenha('SenhaBoa124', sal, hash));
  ok('sal diferente gera hash diferente', gerarHash('SenhaBoa123').hash !== hash);
  ok('senha curta é recusada', forcaDaSenha('abc12').length > 0);
  ok('senha só com letras é recusada', forcaDaSenha('abcdefghijk').length > 0);
  ok('senha óbvia é recusada', forcaDaSenha('senha123456').length > 0);
  ok('senha boa passa', forcaDaSenha('Torre-42-Verde').length === 0);

  const t = new ControleDeTentativas({ tentativas_ate_bloquear: 3, bloqueio_minutos: 10 });
  t.falhou('ip'); t.falhou('ip');
  ok('não bloqueia antes do limite', t.bloqueado('ip') === 0);
  t.falhou('ip');
  ok('bloqueia no limite', t.bloqueado('ip') > 0);
  t.acertou('ip');
  ok('acerto limpa o bloqueio', t.bloqueado('ip') === 0);

  ok('cookie é lido corretamente',
    lerCookie('a=1; painel_sessao=abc123; b=2', 'painel_sessao') === 'abc123');
  ok('cookie ausente devolve nulo', lerCookie('a=1', 'painel_sessao') === null);
}

console.log('\nSessões e papéis');
{
  class BancoAcesso {
    constructor() { this.u = []; this.s = new Map(); this.log = []; this.seq = 0; }
    listarUsuarios() { return this.u; }
    usuarioPorLogin(l) { return this.u.find((x) => x.login === l && x.ativo); }
    usuarioPorId(i) { return this.u.find((x) => x.id === i && x.ativo); }
    criarUsuario(x) { const id = ++this.seq; this.u.push({ ...x, id, ativo: 1 }); return id; }
    atualizarUsuario(id, c) { Object.assign(this.u.find((x) => x.id === id), c); }
    contarAdmins() { return this.u.filter((x) => x.papel === 'admin' && x.ativo).length; }
    criarSessao(s) { this.s.set(s.token, s); }
    sessao(t) { const s = this.s.get(t); return s && s.expira_em > Date.now() ? s : undefined; }
    encerrarSessao(t) { this.s.delete(t); }
    encerrarSessoesDoUsuario(id) { for (const [k, v] of this.s) if (v.usuario_id === id) this.s.delete(k); }
    limparSessoesVencidas() {}
    registrar(a, d, u) { this.log.push({ a, d, u }); }
  }
  const banco = new BancoAcesso();
  const acesso = new Acesso(banco, { sessao_horas: 1, tentativas_ate_bloquear: 3 });

  const senha = acesso.garantirAdmin();
  ok('admin inicial é criado com senha aleatória', !!senha && senha.length >= 10);
  ok('não recria admin se já existe usuário', acesso.garantirAdmin() === null);

  let r = acesso.entrar('admin', 'errada', 'ip1');
  ok('senha errada é recusada', !!r.erro);
  r = acesso.entrar('admin', senha, 'ip1');
  ok('senha correta entra', !!r.token);
  ok('usuário novo precisa trocar a senha', r.usuario.trocar_senha === true);
  ok('token recupera o usuário', acesso.usuarioDoToken(r.token)?.login === 'admin');
  ok('token inválido não recupera nada', acesso.usuarioDoToken('inventado') === null);
  banco.encerrarSessao(r.token);
  ok('sessão encerrada deixa de valer', acesso.usuarioDoToken(r.token) === null);

  ok('admin alcança papel de técnico', acesso.podeNoPapel('admin', 'tecnico'));
  ok('operador não alcança técnico', !acesso.podeNoPapel('operador', 'tecnico'));
  ok('técnico não alcança admin', !acesso.podeNoPapel('tecnico', 'admin'));
  ok('papel desconhecido não alcança nada', !acesso.podeNoPapel('visitante', 'operador'));

  const cookie = acesso.cookie('t123');
  ok('cookie é HttpOnly e SameSite', /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
  ok('cookie de saída expira imediatamente', /Max-Age=0/.test(acesso.cookie('', true)));

  for (let i = 0; i < 3; i++) acesso.entrar('admin', 'x', 'ip2');
  ok('origem é bloqueada após tentativas seguidas', !!acesso.entrar('admin', senha, 'ip2').erro);
  ok('outra origem continua liberada', !acesso.entrar('admin', senha, 'ip3').erro);
  ok('login inexistente não revela nada diferente',
    acesso.entrar('fantasma', 'x', 'ip4').erro === acesso.entrar('admin', 'x', 'ip5').erro);

  // tentativa distribuída: cada erro vem de um endereço diferente
  const alvo = new Acesso(new BancoAcesso(), { tentativas_ate_bloquear: 3 });
  const senhaAlvo = alvo.garantirAdmin();
  for (let i = 0; i < 5; i++) alvo.entrar('admin', 'x', `rodizio${i}`);
  ok('conta não bloqueia antes do dobro do limite', !alvo.entrar('admin', senhaAlvo, 'outra').erro);
  for (let i = 0; i < 6; i++) alvo.entrar('ADMIN', 'x', `rodizio${i}`);
  ok('conta bloqueia mesmo com a origem trocando a cada erro', !!alvo.entrar('admin', senhaAlvo, 'nova').erro);
  ok('o bloqueio por conta não trava as outras contas',
    alvo.entrar('outro', 'x', 'nova2').erro === 'usuário ou senha inválidos');
}

console.log('\nOrigem da requisição');
{
  const req = (socket, xff) => ({ socket: { remoteAddress: socket }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  ok('sem proxy, vale o endereço da conexão', origemDaRequisicao(req('10.0.0.5')) === '10.0.0.5');
  ok('X-Forwarded-For de cliente comum é ignorado',
    origemDaRequisicao(req('10.0.0.5', '1.2.3.4')) === '10.0.0.5');
  ok('prefixo IPv4-mapeado é removido', origemDaRequisicao(req('::ffff:10.0.0.5')) === '10.0.0.5');
  ok('atrás de proxy confiável, vale o que o proxy acrescentou',
    origemDaRequisicao(req('127.0.0.1', 'forjado, 192.168.1.20'), ['127.0.0.1']) === '192.168.1.20');
  ok('proxy não declarado não é ouvido',
    origemDaRequisicao(req('10.0.0.9', '192.168.1.20'), ['127.0.0.1']) === '10.0.0.9');
}

console.log('\nTerminal de engenharia');
{
  const linhas = interpretar([0x435C, 0x8000, 0xFFF6, 0x0000]);
  ok('coluna ABCD mostra o valor correto', perto(linhas[0].float_ABCD, 220.5, 0.01));
  ok('colunas de ordem errada mostram valor absurdo', Math.abs(linhas[0].float_CDAB) < 1e-30);
  ok('int16 negativo aparece', linhas[2].int16 === -10);
  ok('bits vêm com 16 posições', linhas[3].bits.length === 16);
  ok('última linha não tenta formar float', linhas[3].float_ABCD === undefined);
}


console.log('\nSuperfície de ataque do servidor');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  const PUBLICAS = new Set(['/api/login', '/api/sair', '/api/eu']);
  const rotas = [...fonte.matchAll(/app\.(get|post|patch|put|delete)\('(\/api[^']*)',([^\n]*)/g)]
    .map((m) => ({ metodo: m[1], rota: m[2], resto: m[3] }));

  ok('todas as rotas de API estão mapeadas', rotas.length >= 20, String(rotas.length));
  // sem sessão, mas restrita ao IP da central pela VPN — a checagem é conferida no bloco da central
  const POR_ORIGEM = new Set(['/api/central/resumo']);
  ok('rota liberada por origem tem a checagem de IP', [...POR_ORIGEM].every((r) => new RegExp(
    `app\\.get\\('${r.replace(/\//g, '\\/')}'[\\s\\S]{0,500}de !== ipCentral[^)]*\\)[\\s\\S]{0,30}return res\\.status\\(403\\)`).test(fonte)));
  const desprotegidas = rotas.filter((r) => !PUBLICAS.has(r.rota) && !POR_ORIGEM.has(r.rota) && !/exigir\('/.test(r.resto));
  ok('nenhuma rota sensível sem exigência de papel', desprotegidas.length === 0,
    desprotegidas.map((r) => r.rota).join(', '));

  const engenharia = rotas.filter((r) => r.rota.startsWith('/api/eng'));
  ok('engenharia exige no mínimo técnico',
    engenharia.every((r) => /exigir\('(tecnico|admin)'\)/.test(r.resto)), String(engenharia.length));
  const administrativas = rotas.filter((r) => /usuarios|auditoria/.test(r.rota));
  ok('usuários e auditoria exigem administrador',
    administrativas.every((r) => /exigir\('admin'\)/.test(r.resto)), String(administrativas.length));

  ok('escrita Modbus depende de liberação explícita', /escrita_modbus_liberada/.test(fonte));
  ok('WebSocket confere a sessão no upgrade',
    /upgrade[\s\S]{0,400}usuarioDoToken/.test(fonte));
  ok('operações de mudança exigem cabeçalho próprio', /X-Painel/.test(fonte));
  ok('cabeçalhos de segurança são enviados',
    ['X-Content-Type-Options', 'X-Frame-Options', 'Content-Security-Policy']
      .every((h) => fonte.includes(h)));
  ok('interface não é servida sem sessão', /req\.usuario && !livre|!req\.usuario && !livre/.test(fonte));
  // login e login negado são registrados no módulo de acesso
  const tudo = fonte + fs.readFileSync(path.join(raiz, 'src/auth.js'), 'utf8');
  ok('ações sensíveis são auditadas',
    ['config_aplicada', 'modbus_escrita', 'usuario_criado', 'login_negado', 'acesso_negado']
      .every((a) => tudo.includes(a)));
}


console.log('\nPerfil do CLP FX3U (convertido do Node-RED)');
{
  const dirPerfis = path.join(raiz, 'perfis');
  const { config: fx } = prepararConfig(bancadaFx3u(), dirPerfis);
  const v = validarConfig(fx);
  ok('configuração da bancada é válida', v.valido, v.erros.join(', '));
  // e a que está em uso agora, do jeito que a tela de Engenharia a deixou
  const { config: emUso } = prepararConfig(
    JSON.parse(fs.readFileSync(path.join(raiz, 'config.fx3u.json'), 'utf8')), dirPerfis,
  );
  const vUso = validarConfig(emUso);
  ok('config.fx3u.json em uso é válida', vUso.valido, vUso.erros.join(', '));

  const eq = fx.medidores[0];
  const tag = (n) => eq.tags.find((t) => t.nome === n);

  // escala do sensor: exatamente a conta da função "Escalonar nivel" do flow
  const nivel = tag('nivel');
  const pct = (raw) => raw * nivel.escala + nivel.offset;
  ok('4 mA (756) = 0 %', perto(pct(756), 0, 0.01), String(pct(756)));
  ok('20 mA (4095) = 100 %', perto(pct(4095), 100, 0.01), String(pct(4095)));
  ok('meio de escala = 50 %', perto(pct((756 + 4095) / 2), 50, 0.01));
  ok('nível é limitado à faixa útil', Array.isArray(nivel.limitar)
    && nivel.limitar[0] === 0 && nivel.limitar[1] === 100);

  // funções Modbus conforme o flow: X = FC2, Y = FC1, analógico = FC3
  ok('entradas X leem por função 02 (discreta)', tag('disjuntor_ligado').funcao === 'discreta');
  ok('saídas Y leem por função 01 (coil)', tag('saida_y0').funcao === 'coil');
  ok('nível lê por função 03 (holding)', (tag('nivel').funcao || eq.padrao.funcao) === 'holding');
  ok('endereços das entradas batem com o flow',
    tag('disjuntor_ligado').endereco === 0 && tag('disjuntor_falha').endereco === 1
    && tag('modo_remoto').endereco === 2);
  ok('nível está em D212, como no flow', tag('nivel').endereco === 212);

  // a leitura bruta existe para detectar laço de 4-20 mA aberto
  ok('leitura bruta do sensor é mapeada', !!tag('nivel_bruto') && tag('nivel_bruto').escala === undefined);
  const fioRompido = fx.alarmes.find((a) => /laço de 4-20/.test(a.mensagem || ''));
  ok('alarme de fio rompido existe', !!fioRompido && fioRompido.min === 706);

  // agrupamento: uma requisição por função, três no total
  const blocos = montarBlocos(eq.tags, eq.padrao);
  ok('a varredura cabe em 3 requisições', blocos.length === 3,
    blocos.map((b) => `${b.funcao} ${b.inicio}..${b.fim - 1}`).join(' | '));
  ok('bloco das entradas cobre X0-X7',
    blocos.some((b) => b.funcao === 'discreta' && b.inicio === 0 && b.fim === 8));
  ok('nível e leitura bruta caem na mesma requisição',
    blocos.some((b) => b.funcao === 'holding' && b.tags.length === 2));

  ok('o heartbeat do flow foi preservado',
    eq.heartbeat?.endereco === 101 && eq.heartbeat.intervalo_s === 5);
  ok('heartbeat pode ser desligado pelo equipamento',
    expandirPerfis({ medidores: [{ id: 'x', perfil: 'clp-fx3u-disjuntor',
      conexao: { unit_id: 2 }, heartbeat: false }] },
    carregarPerfis(dirPerfis)).medidores[0].heartbeat === null);

  // severidade das janelas do anunciador
  ok('estado normal não pinta de vermelho', tag('disjuntor_ligado').severidade === 'info');
  ok('proteção disparada é prioridade alta', tag('disjuntor_falha').severidade === 'alta');
  ok('modo LOCAL alarma por lógica invertida', tag('modo_remoto').inverso === true);
}

console.log('\nLimite de faixa (clamp) e leitura do sensor');
{
  const t = prepararTag({ nome: 'n', endereco: 0, tipo: 'uint16',
    escala: 0.029949087, offset: -22.641509, limitar: [0, 100] }, { funcao: 'holding' });
  const ler = (raw) => {
    const v = raw * t.escala + t.deslocamento;
    return t.limitar ? Math.min(t.limitar[1], Math.max(t.limitar[0], v)) : v;
  };
  ok('leitura abaixo da faixa vira 0, não negativo', ler(700) === 0);
  ok('leitura acima da faixa vira 100', ler(4200) === 100);
  ok('leitura dentro da faixa passa intacta', perto(ler(2425), 50, 0.02));
  ok('offset é lido do campo offset da tag', t.deslocamento === -22.641509);

  const semLimite = prepararTag({ nome: 'n', endereco: 0 }, {});
  ok('tag sem limitar não é cortada', semLimite.limitar === null);
  ok('limitar malformado é ignorado',
    prepararTag({ nome: 'n', endereco: 0, limitar: [0] }, {}).limitar === null);
}

console.log('\nSimulador do FX3U');
{
  const { config: fx } = prepararConfig(bancadaFx3u(), path.join(raiz, 'perfis'));
  const sim = new Simulador(fx);
  const r = await sim.lerTodos();
  const v = r.clp.valores;
  const nomes = fx.medidores[0].tags.map((t) => t.nome);
  ok('simulador devolve exatamente as tags mapeadas',
    nomes.every((n) => v[n] !== undefined) && Object.keys(v).length === nomes.length);
  ok('leitura bruta é coerente com o nível escalonado',
    perto(v.nivel_bruto * 0.029949087 - 22.641509, v.nivel, 0.05));
  ok('bruto fica dentro da faixa do sensor', v.nivel_bruto >= 700 && v.nivel_bruto <= 4150,
    String(v.nivel_bruto));
  ok('simulador não tenta escrever heartbeat', typeof sim.enviarHeartbeats === 'function');
}


console.log('\nCasca da interface e cache');
{
  const html = fs.readFileSync(path.join(raiz, 'public/index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

  // todo id que o código busca precisa existir na página: se faltar um, a
  // interface morre inteira em "Cannot set properties of null"
  const arquivos = ['public/assets/app.js', 'public/assets/telas/energia.js',
    'public/assets/telas/unifilar.js'];
  const faltando = [];
  for (const arq of arquivos) {
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    for (const m of fonte.matchAll(/\$\('#([\w-]+)'\)/g)) {
      if (!ids.has(m[1]) && !faltando.includes(m[1])) faltando.push(m[1]);
    }
  }
  ok('todo id procurado pelo código existe na página', faltando.length === 0, faltando.join(', '));

  const login = fs.readFileSync(path.join(raiz, 'public/login.html'), 'utf8');
  const idsLogin = new Set([...login.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const fonteLogin = fs.readFileSync(path.join(raiz, 'public/assets/login.js'), 'utf8');
  const faltaLogin = [...new Set([...fonteLogin.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))]
    .filter((i) => !idsLogin.has(i));
  ok('a tela de entrada tem todos os seus campos', faltaLogin.length === 0, faltaLogin.join(', '));

  // cache com prazo faz o navegador misturar página antiga com código novo
  const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('páginas são servidas sem cache', /no-store/.test(servidor));
  ok('nenhum arquivo estático tem prazo de cache', !/maxAge/.test(servidor));
  ok('a revalidação por ETag continua ligada', /etag:\s*true/.test(servidor));
}


console.log('\nTelas sem equipamento (estado vazio)');
{
  // as telas de Energia e Unifilar não somem numa instalação recém-criada:
  // elas precisam montar e explicar o que falta
  const fonteApp = fs.readFileSync(path.join(raiz, 'public/assets/app.js'), 'utf8');
  // só a linha do EXIGE_GRUPO decide o que some do menu; GRUPO_DA_TELA é outra coisa
  const exigeGrupo = (fonteApp.match(/const EXIGE_GRUPO = \{[^}]*\}/) || [''])[0];
  const exigeSecao = (fonteApp.match(/const EXIGE_SECAO = \{[^}]*\}/) || [''])[0];
  ok('Energia não é escondida por falta de medidor', !/energia:/.test(exigeGrupo), exigeGrupo);
  ok('Unifilar não é escondido por falta de medidor',
    !/unifilar:/.test(exigeGrupo) && !/unifilar:/.test(exigeSecao), exigeSecao);
  ok('Água ainda depende do reservatório', /agua:\s*'caixa_agua'/.test(exigeSecao));
  ok('a configuração pode forçar uma tela no menu', /pedido\[t\.id\] === true/.test(fonteApp));
  ok('a configuração pode esconder uma tela', /pedido\[t\.id\] === false/.test(fonteApp));
  ok('o pedido da instalação vem antes da regra automática',
    fonteApp.indexOf('pedido[t.id] === true') < fonteApp.indexOf('EXIGE_GRUPO[t.id]'));
  ok('o servidor manda a lista de telas para o painel',
    /telas: config\.telas \|\| \{\}/.test(fs.readFileSync(path.join(raiz, 'server.js'), 'utf8')));

  const gerador = fs.readFileSync(path.join(raiz, 'public/assets/telas/gerador.js'), 'utf8');
  ok('Gerador monta o guia quando ainda não há grupo', /if \(!cfg \|\| !eq\) return estadoVazio/.test(gerador));
  ok('Gerador não desenha tendência no estado vazio', /!\$\('#gmg-grafico', raiz\)\) return/.test(gerador));
  ok('a atualização por varredura sai cedo sem gerador', /if \(!cfg\?\.medidor\) return;/.test(gerador));
  for (const arq of ['config.protecao.json', 'config.fx3u.json']) {
    const c = JSON.parse(fs.readFileSync(path.join(raiz, arq), 'utf8'));
    ok(`${arq}: a bancada mostra a tela do gerador`, c.telas?.gerador === true);
  }

  const energia = fs.readFileSync(path.join(raiz, 'public/assets/telas/energia.js'), 'utf8');
  const unifilar = fs.readFileSync(path.join(raiz, 'public/assets/telas/unifilar.js'), 'utf8');
  ok('Energia trata a lista vazia antes de usar o principal',
    energia.indexOf('if (!eqs.length)') < energia.indexOf('eqs.find((e) => e.principal)'));
  ok('Unifilar trata a falta de seção antes de ler as saídas',
    unifilar.indexOf('if (!u || !temEnergia)') < unifilar.indexOf('(u.saidas || [])'));
}

console.log('\nEditor de equipamentos');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('editor lê e grava por rotas próprias',
    /app\.get\('\/api\/eng\/equipamentos'/.test(fonte) && /app\.post\('\/api\/eng\/equipamentos'/.test(fonte));
  ok('gravar equipamentos exige papel técnico',
    /app\.post\('\/api\/eng\/equipamentos', exigir\('tecnico'\)/.test(fonte));
  ok('a gravação passa pela mesma validação da configuração',
    /app\.post\('\/api\/eng\/equipamentos'[\s\S]{0,6000}validarConfig/.test(fonte));
  ok('a versão anterior é guardada antes de aplicar',
    /app\.post\('\/api\/eng\/equipamentos'[\s\S]{0,6200}salvarVersao/.test(fonte));
  ok('conferir não altera nada', /apenas_validar/.test(fonte));
}


console.log('\nDesenhos e tipografia');
{
  const css = fs.readFileSync(path.join(raiz, 'public/assets/estilo.css'), 'utf8');

  // a parede do tanque não pode ter preenchimento, senão cobre o líquido.
  // Atributo fill="none" no elemento perde para a regra .caixa do CSS.
  ok('existe classe de parede sem preenchimento', /\.desenho \.parede \{[^}]*fill:\s*none/.test(css));
  for (const arq of ['public/assets/telas/agua.js', 'public/assets/telas/gerador.js']) {
    const fonte = fs.readFileSync(path.join(raiz, arq), 'utf8');
    ok(`${path.basename(arq)}: tanque usa parede, não caixa`,
      !/class="caixa"[^>]*fill="none"/.test(fonte) && /class="parede"/.test(fonte));
  }

  // span é inline: sem display block, a barra de fase fica com altura zero
  ok('barra de fase é bloco', /\.barra-fase \.fill \{[^}]*display:\s*block/.test(css));
  ok('trilho da fase é bloco', /\.barra-fase \.trilho \{[^}]*display:\s*block/.test(css));

  // ".marca" é a logomarca da coluna; as marcas de limite têm nome próprio
  ok('marcas de limite não colidem com a logomarca',
    /\.escala \.limite \{/.test(css) && !/\.escala \.marca \{/.test(css));

  // fontes servidas da própria máquina, nunca de CDN
  ok('fontes são declaradas localmente', (css.match(/@font-face/g) || []).length >= 4);
  ok('nenhuma fonte vem de fora', !/@import|fonts\.googleapis|https?:\/\//.test(css));
  const fontes = fs.readdirSync(path.join(raiz, 'public/assets/fontes'));
  ok('os arquivos de fonte acompanham o projeto', fontes.filter((f) => f.endsWith('.woff2')).length >= 4,
    fontes.join(', '));
  ok('CSP libera as fontes próprias',
    /font-src 'self'/.test(fs.readFileSync(path.join(raiz, 'server.js'), 'utf8')));
  ok('estilo inline continua permitido pela CSP',
    /style-src 'self' 'unsafe-inline'/.test(fs.readFileSync(path.join(raiz, 'server.js'), 'utf8')));
}


console.log('\nComandos: intertravamento');
{
  const dirPerfis = path.join(raiz, 'perfis');
  const { config: fx } = prepararConfig(bancadaFx3u(), dirPerfis);
  const ligar = acharComando(fx, 'clp', 'ligar').comando;
  const desligar = acharComando(fx, 'clp', 'desligar').comando;

  const planta = (v, online = true) => ({ clp: { id: 'clp', online, valores: v } });
  const normal = { modo_remoto: 1, disjuntor_falha: 0, disjuntor_ligado: 0 };

  ok('ligar liberado com tudo normal', impedimentos(ligar, 'clp', planta(normal)).length === 0);
  ok('ligar bloqueado em LOCAL',
    impedimentos(ligar, 'clp', planta({ ...normal, modo_remoto: 0 }))
      .some((m) => /LOCAL/.test(m)));
  ok('ligar bloqueado com proteção disparada',
    impedimentos(ligar, 'clp', planta({ ...normal, disjuntor_falha: 1 }))
      .some((m) => /Proteção/.test(m)));
  ok('ligar bloqueado se já está ligado',
    impedimentos(ligar, 'clp', planta({ ...normal, disjuntor_ligado: 1 }))
      .some((m) => /já está ligado/.test(m)));
  ok('sem comunicação bloqueia qualquer comando',
    impedimentos(ligar, 'clp', planta(normal, false)).some((m) => /comunicação/.test(m)));
  ok('equipamento inexistente bloqueia', impedimentos(ligar, 'fantasma', planta(normal)).length === 1);
  ok('desligar bloqueado se já está desligado',
    impedimentos(desligar, 'clp', planta(normal)).some((m) => /já está desligado/.test(m)));
  ok('desligar liberado com o disjuntor ligado',
    impedimentos(desligar, 'clp', planta({ ...normal, disjuntor_ligado: 1 })).length === 0);
  ok('tag sem leitura bloqueia, não libera',
    impedimentos(ligar, 'clp', planta({ modo_remoto: 1 })).length > 0);
}

console.log('\nComandos: religamento por tipo de falha');
{
  // A regra que o cliente pediu: sobretensão religa remoto, sobrecorrente não.
  // Duas barreiras independentes — o permissivo do relé (X3) e o código da
  // causa (D30). O teste checa cada uma sozinha e as duas juntas.
  const dirPerfis = path.join(raiz, 'perfis');
  const { config: pr } = prepararConfig(
    JSON.parse(fs.readFileSync(path.join(raiz, 'config.protecao.json'), 'utf8')), dirPerfis,
  );
  const alvo = acharComando(pr, 'clp', 'ligar');
  const ligar = alvo.comando;
  const tags = alvo.medidor.tags;
  const planta = (v) => ({ clp: { id: 'clp', online: true, valores: v } });
  const base = { modo_remoto: 1, disjuntor_ligado: 0, permite_religar: 1, causa_disparo: 0 };
  const bloqueios = (v) => impedimentos(ligar, 'clp', planta({ ...base, ...v }), tags);

  ok('operadores da condição: "em" aceita a lista',
    condicaoAtendida({ em: [0, 2, 3] }, 2) && !condicaoAtendida({ em: [0, 2, 3] }, 1));
  ok('operadores da condição: "fora_de" rejeita a lista',
    !condicaoAtendida({ fora_de: [1, 4] }, 4) && condicaoAtendida({ fora_de: [1, 4] }, 2));
  ok('a condição tolera ruído de leitura do inteiro',
    condicaoAtendida({ em: [2] }, 2.0000001));

  ok('sobretensão (2) libera o religamento remoto', bloqueios({ causa_disparo: 2 }).length === 0);
  ok('subtensão (3) libera o religamento remoto', bloqueios({ causa_disparo: 3 }).length === 0);
  ok('sobrecorrente (1) bloqueia o religamento remoto',
    bloqueios({ causa_disparo: 1 }).some((m) => /exige inspeção/.test(m)));
  ok('curto-circuito (4) bloqueia o religamento remoto',
    bloqueios({ causa_disparo: 4 }).length > 0);
  ok('falta à terra (5) bloqueia o religamento remoto',
    bloqueios({ causa_disparo: 5 }).length > 0);

  ok('o motivo sai em português, não em código',
    bloqueios({ causa_disparo: 1 }).some((m) => /sobrecorrente/.test(m) && !/\{valor\}/.test(m)));
  ok('textoDoValor usa o enum do perfil',
    textoDoValor('causa_disparo', 5, tags) === 'falta à terra');
  ok('textoDoValor não inventa texto para código desconhecido',
    textoDoValor('causa_disparo', 77, tags) === '77');
  ok('tag sem enum devolve o número', textoDoValor('nivel', 42, tags) === '42');

  // defesa em profundidade, nas duas direções
  ok('permissivo aberto bloqueia mesmo com causa religável',
    bloqueios({ permite_religar: 0, causa_disparo: 2 }).some((m) => /inspeção e rearme no painel/.test(m)));
  ok('causa não religável bloqueia mesmo com o permissivo fechado',
    bloqueios({ permite_religar: 1, causa_disparo: 1 }).length > 0);
  ok('sem leitura da causa não libera',
    impedimentos(ligar, 'clp', planta({ modo_remoto: 1, disjuntor_ligado: 0, permite_religar: 1 }), tags)
      .length > 0);
  ok('LOCAL continua acima de tudo',
    bloqueios({ modo_remoto: 0, causa_disparo: 2 }).some((m) => /LOCAL/.test(m)));

  // o que a tela recebe
  const PESOS = { operador: 1, tecnico: 2, admin: 3 };
  const pode = (p, m) => (PESOS[p] || 0) >= (PESOS[m] || 99);
  const vista = estadoDosComandos(pr, planta({ ...base, causa_disparo: 1 }), 'tecnico', pode);
  const religar = vista.find((c) => c.nome === 'ligar');
  ok('a tela recebe a causa já traduzida', religar.causa === 'sobrecorrente');
  ok('a tela recebe o comando indisponível com o motivo', !religar.disponivel && religar.impedimentos.length > 0);
  ok('os dois comandos exigem senha', vista.length === 2 && vista.every((c) => c.exige_senha === true));
  ok('desligar é marcado como perigoso',
    vista.find((c) => c.nome === 'desligar')?.perigoso === true);

  // e a validação não deixa passar configuração incoerente
  const quebrado = JSON.parse(JSON.stringify(pr));
  const trava = acharComando(quebrado, 'clp', 'ligar').comando.intertravamentos
    .find((t) => t.tag === 'causa_disparo');
  delete trava.fora_de;
  ok('intertravamento sem condição é recusado na validação',
    validarConfig(quebrado).erros.some((e) => /sem condição/.test(e)));
  trava.em = [2];
  trava.fora_de = [1];
  ok('"em" e "fora_de" juntos são recusados',
    validarConfig(quebrado).erros.some((e) => /ao mesmo tempo/.test(e)));
}

console.log('\nComandos: senha no momento do acionamento');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  const rota = fonte.slice(fonte.indexOf("app.post('/api/comandos/executar'"));
  ok('o servidor confere a senha quando o comando exige',
    /exige_senha[\s\S]{0,600}conferirSenha\(/.test(rota));
  ok('a senha errada conta para o bloqueio progressivo',
    /exige_senha[\s\S]{0,600}tentativas\.falhou\(/.test(rota));
  ok('a senha errada responde 401, não 403',
    /Senha incorreta', 401/.test(rota));
  ok('senha errada em excesso responde 429', /Muitas senhas erradas[\s\S]{0,80}429/.test(rota));
  ok('a senha confere contra o hash do próprio usuário da sessão',
    /usuarioPorId\(req\.usuario\.id\)/.test(rota));
  ok('a senha nunca entra na auditoria',
    !/registrar\([^)]*senha/.test(rota) && !/detalhe[^\n]*senha\b/.test(rota));
  ok('a ordem é senha antes de escrever',
    rota.indexOf('conferirSenha(') < rota.indexOf('executar('));

  // senha errada não pode derrubar a sessão: 401 é o código certo, mas o painel
  // trata 401 como sessão perdida e vai para o login
  ok('a recusa de comando marca a sessão como válida', /sessao: 'valida'/.test(rota));
  const nucleo = fs.readFileSync(path.join(raiz, 'public/assets/nucleo.js'), 'utf8');
  ok('o painel só vai ao login quando o 401 não é de senha de comando',
    /status === 401 && dados\.sessao !== 'valida'/.test(nucleo));
  ok('o corpo da resposta é lido antes de decidir pelo login',
    nucleo.indexOf('await r.json()') < nucleo.indexOf("status === 401"));

  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/comandos.js'), 'utf8');
  ok('a tela pede a senha antes de habilitar o envio', /exige_senha && !senha/.test(tela));
  ok('a senha digitada sobrevive ao redesenho de 2 s', /senhaEmDigitacao/.test(tela));
  ok('a senha não fica no DOM depois do envio',
    /campo\.value = ''|senha = ''/.test(tela) || /value = ''/.test(tela));
  ok('o campo de senha é do tipo password', /type="password"/.test(tela));
}

console.log('\nComandos nas telas de Energia e Unifilar');
{
  const energia = fs.readFileSync(path.join(raiz, 'public/assets/telas/energia.js'), 'utf8');
  const unifilar = fs.readFileSync(path.join(raiz, 'public/assets/telas/unifilar.js'), 'utf8');
  ok('Energia traz o bloco de acionamento', /blocoComandos\(/.test(energia));
  ok('Unifilar traz o bloco de acionamento', /blocoComandos\(/.test(unifilar));
  for (const [nome, fonte] of [['Energia', energia], ['Unifilar', unifilar]]) {
    ok(`${nome} esconde o bloco quando a instalação não liberou comandos`,
      /comandos_liberados \?/.test(fonte));
      ok(`${nome} liga o comportamento do bloco ao montar`, /comandos\.aoMontar\(raiz\)/.test(fonte));
    ok(`${nome} desliga o bloco ao sair`, /comandos\.destruir\(\)/.test(fonte));
  }
}

console.log('\nAtalhos de teclado');
{
  const app = fs.readFileSync(path.join(raiz, 'public/assets/app.js'), 'utf8');
  ok('existe uma guarda para quem está digitando', /const digitando =/.test(app));
  ok('a guarda cobre input, textarea e select',
    /'INPUT', 'TEXTAREA', 'SELECT'/.test(app));
  ok('a guarda cobre campo editável', /isContentEditable/.test(app));
  ok('o atalho é conferido contra o alvo e contra o foco',
    /digitando\(ev\.target\) \|\| digitando\(document\.activeElement\)/.test(app));
  ok('atalho com Ctrl, Alt ou Meta é devolvido ao navegador',
    /altKey \|\| ev\.ctrlKey \|\| ev\.metaKey/.test(app));
  ok('teclas de edição não são tratadas como atalho', /ev\.key\.length !== 1/.test(app));

  // a guarda em si, extraída do arquivo e executada
  const corpo = app.match(/const digitando = \(alvo\) => \{([\s\S]*?)\n {2}\};/);
  const body = { tagName: 'BODY' };
  const digitando = new Function('document', 'alvo', corpo[1]).bind(null, { body });
  ok('digitando() reconhece um campo de texto',
    digitando({ tagName: 'INPUT', isContentEditable: false }) === true);
  ok('digitando() reconhece um select', digitando({ tagName: 'SELECT' }) === true);
  ok('digitando() reconhece um bloco editável', digitando({ isContentEditable: true }) === true);
  ok('digitando() libera um painel comum',
    digitando({ tagName: 'DIV', isContentEditable: false }) === false);
  ok('digitando() libera o corpo da página', digitando(body) === false);
  ok('digitando() tolera alvo nulo', digitando(null) === false);
}

console.log('\nComandos: papel e liberação');
{
  const PESOS = { operador: 1, tecnico: 2, admin: 3 };
  const pode = (p, m) => (PESOS[p] || 0) >= (PESOS[m] || 99);
  const dirPerfis = path.join(raiz, 'perfis');
  const { config: fx } = prepararConfig(bancadaFx3u(), dirPerfis);
  const planta = { clp: { id: 'clp', online: true, valores: { modo_remoto: 1, disjuntor_falha: 0, disjuntor_ligado: 0 } } };

  const paraOperador = estadoDosComandos(fx, planta, 'operador', pode);
  ok('operador vê o comando mas não pode acionar',
    paraOperador.length === 2 && paraOperador.every((c) => !c.autorizado && !c.disponivel));
  const paraTecnico = estadoDosComandos(fx, planta, 'tecnico', pode);
  ok('técnico pode acionar o que está liberado',
    paraTecnico.find((c) => c.nome === 'ligar')?.disponivel === true);

  const travado = { ...fx, seguranca: { ...fx.seguranca, comandos_liberados: false } };
  ok('instalação sem comandos liberados não expõe nenhum',
    estadoDosComandos(travado, planta, 'admin', pode).length === 0);
}

console.log('\nComandos: execução e realimentação');
{
  const { config: fx } = prepararConfig(bancadaFx3u(), path.join(raiz, 'perfis'));
  const ligar = acharComando(fx, 'clp', 'ligar').comando;

  // equipamento obediente: confirma na segunda leitura
  let escritas = [];
  let leituras = 0;
  let r = await executar({
    comando: ligar,
    idMedidor: 'clp',
    coletor: { escreverBruto: async (x) => { escritas.push(x); } },
    unitId: 1,
    barramento: 'rtu:teste',
    esperar: 10,
    lerAgora: async () => {
      leituras += 1;
      return { clp: { id: 'clp', online: true, valores: { disjuntor_ligado: leituras >= 2 ? 1 : 0 } } };
    },
  });
  ok('escreve o valor declarado no endereço declarado',
    escritas.length === 1 && escritas[0].endereco === 100 && escritas[0].valor === 1);
  ok('confirma quando a realimentação muda', r.confirmado === true);

  // equipamento que não obedece: precisa acusar, não fingir sucesso
  const curto = { ...ligar, confirma_com: { ...ligar.confirma_com, prazo_s: 0.1 } };
  r = await executar({
    comando: curto,
    idMedidor: 'clp',
    coletor: { escreverBruto: async () => {} },
    unitId: 1,
    barramento: 'rtu:teste',
    esperar: 10,
    lerAgora: async () => ({ clp: { id: 'clp', online: true, valores: { disjuntor_ligado: 0 } } }),
  });
  ok('acusa quando o equipamento não obedece', r.confirmado === false && r.escrito === true);
  ok('a mensagem manda conferir no painel', /Verifique no painel/.test(r.mensagem));
}

console.log('\nComandos: superfície e auditoria');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('só existe uma implementação de comando',
    (fonte.match(/app\.post\('\/api\/comandos/g) || []).length === 1);
  ok('o servidor revalida os intertravamentos antes de escrever',
    /app\.post\('\/api\/comandos\/executar'[\s\S]{0,4000}impedimentos\([\s\S]{0,2500}executar\(/.test(fonte));
  ok('exige confirmação explícita', /confirmado !== true/.test(fonte));
  ok('recusa quando a instalação não liberou comandos', /comandos_liberados/.test(fonte));
  for (const acao of ['comando_negado', 'comando_enviado', 'comando_confirmado', 'comando_falhou']) {
    ok(`auditoria registra ${acao}`, fonte.includes(acao));
  }
}

console.log('\nGerador: tags calculadas');
{
  const { config: loja } = prepararConfig(
    JSON.parse(fs.readFileSync(path.join(raiz, 'config.json'), 'utf8')), path.join(raiz, 'perfis'),
  );
  const gmg = loja.medidores.find((m) => m.id === loja.gerador.medidor);
  const nomes = gmg.tags.filter((t) => t.calculada).map((t) => t.nome);
  ok('o gerador ganha as quatro tags calculadas',
    ['pronto', 'autonomia_h', 'diesel_litros', 'dias_sem_teste'].every((n) => nomes.includes(n)));
  ok('tag calculada não tem endereço', gmg.tags.filter((t) => t.calculada).every((t) => t.endereco === undefined));
  ok('configuração com tag calculada continua válida', validarConfig(loja).valido);
  ok('nenhum outro equipamento recebe as tags calculadas do gerador',
    loja.medidores.filter((m) => m.id !== gmg.id).every((m) => !m.tags.some((t) => ['pronto', 'autonomia_h', 'diesel_litros', 'dias_sem_teste'].includes(t.nome))));
  ok('a prontidão vira alarme automaticamente',
    (loja.alarmes || []).some((a) => a.tag === `${gmg.id}.pronto` && a.digital && a.inverso));
  ok('o teste periódico vira alarme automaticamente',
    (loja.alarmes || []).some((a) => a.tag === `${gmg.id}.dias_sem_teste` && a.max === 7));
}

console.log('\nGerador: corridas e indicadores');
{
  // banco falso: as corridas são poucas linhas, dá para guardar em memória
  class BancoCorridas {
    constructor() { this.linhas = []; this.amostras = []; this.seq = 0; }
    abrirCorrida(c) { const id = ++this.seq; this.linhas.push({ ...c, id, fim: null }); return id; }
    atualizarCorrida(id, campos) { Object.assign(this.linhas.find((l) => l.id === id), campos); }
    corridaAberta() { return this.linhas.find((l) => !l.fim) || null; }
    corridas(_m, desde) { return this.linhas.filter((l) => l.inicio >= desde).sort((a, b) => b.inicio - a.inicio); }
    ultimaCorrida() { return this.corridas('', 0)[0] || null; }
    mediaDaTag(tag, de, ate) {
      const v = this.amostras.filter((a) => a.tag === tag && a.ts >= de && a.ts <= ate);
      return v.length ? { media: v.reduce((s, a) => s + a.valor, 0) / v.length, amostras: v.length } : null;
    }
  }
  const cfgG = {
    medidor: 'gmg',
    capacidade_tanque_litros: 500,
    consumo_litros_hora: 38,
    modo_automatico: 1,
    bateria_minima_v: 23,
    teste_a_cada_dias: 7,
    marcas: [{ valor: 25, prioridade: 'alta' }, { valor: 50, prioridade: 'media' }],
    falhas: ['falha_partida', 'falha_pressao_oleo', 'falha_combustivel'],
  };
  const planta = (v) => ({ gmg: { id: 'gmg', online: true, valores: { ...v } } });
  const PARADO = {
    estado: 0, modo: 1, nivel_diesel: 80, tensao_bateria: 26.9, potencia: 0, rede_presente: 1,
  };

  // --- tags calculadas
  {
    const motor = new MotorGerador(cfgG, new BancoCorridas());
    const eqs = planta(PARADO);
    const calc = motor.avaliar(eqs, 1000);
    ok('prontidão 1 com tudo normal', calc.pronto === 1);
    ok('litros saem do percentual e da capacidade', calc.diesel_litros === 400);
    ok('autonomia usa o consumo do catálogo enquanto não há medição',
      Math.abs(calc.autonomia_h - 400 / 38) < 0.01);
    ok('as calculadas entram no próprio equipamento', eqs.gmg.valores.pronto === 1);

    const fora = (extra) => new MotorGerador(cfgG, new BancoCorridas())
      .avaliar(planta({ ...PARADO, ...extra }), 1000).pronto;
    ok('manual derruba a prontidão', fora({ modo: 0 }) === 0);
    ok('falha ativa derruba a prontidão', fora({ falha_pressao_oleo: 1 }) === 0);
    ok('diesel abaixo do crítico derruba a prontidão', fora({ nivel_diesel: 20 }) === 0);
    ok('bateria baixa derruba a prontidão', fora({ tensao_bateria: 22 }) === 0);
    ok('grupo em falha derruba a prontidão', fora({ estado: 5 }) === 0);
    const offline = new MotorGerador(cfgG, new BancoCorridas())
      .avaliar({ gmg: { id: 'gmg', online: false, valores: {} } }, 1000);
    ok('equipamento mudo não conta como pronto', offline === null);
  }

  // --- uma corrida completa: partida, carga, parada
  {
    const banco = new BancoCorridas();
    const motor = new MotorGerador(cfgG, banco);
    let t = Date.now() - 7200000;   // instantes reais: o consumo medido olha os últimos meses
    const passo = (v, ms = 1000) => { t += ms; motor.avaliar(planta({ ...PARADO, ...v }), t); };

    passo({});                                                    // parado
    passo({ estado: 1, tensao_bateria: 26.8 });                   // pré-aquecendo
    passo({ estado: 2, tensao_bateria: 19.6 });                   // arranque: a queda
    passo({ estado: 2, tensao_bateria: 20.1 });
    passo({ estado: 3, tensao_bateria: 27.5, potencia: 120, disjuntor_fechado: 1 }, 2000);
    // uma hora em carga, em passos de um minuto (o motor limita o salto por
    // amostra: buraco de comunicação não pode virar energia que não existiu)
    for (let i = 0; i < 60; i++) {
      passo({
        estado: 3, tensao_bateria: 27.5, potencia: 120, disjuntor_fechado: 1,
        nivel_diesel: 80 - (i + 1) / 60,
      }, 60000);
    }
    passo({ estado: 0, tensao_bateria: 26.9, nivel_diesel: 79 });  // parou

    const c = banco.linhas[0];
    ok('uma corrida foi registrada', banco.linhas.length === 1 && c.fim !== null);
    ok('guarda a tensão de repouso antes do arranque', Math.abs(c.bateria_repouso - 26.9) < 0.3);
    ok('guarda a mínima do arranque', Math.abs(c.bateria_minima - 19.6) < 0.001);
    ok('mede o tempo até assumir a carga', c.tempo_partida_s === 4);
    ok('integra a energia gerada', Math.abs(c.kwh - 120) < 1);
    ok('mede os litros pela queda de nível', Math.abs(c.litros - 5) < 0.001);
    ok('classifica como normal', c.resultado === 'normal');
    ok('o consumo medido sai dos litros por hora', Math.abs(motor.consumoMedido() - 5) < 0.2);

    const ind = motor.indicadores(30, t);
    ok('o resumo conta a partida', ind.partidas === 1 && ind.falhas_de_partida === 0);
    ok('o resumo traz a última queda de bateria',
      Math.abs(ind.bateria.ultima_queda.queda - (26.9 - 19.6)) < 0.3);
    ok('o resumo traz os limites da bateria para a tela',
      ind.bateria.limite_v === 20 && ind.bateria.limite_critico_v === 18);
  }

  // --- falha de partida: girou e não assumiu
  {
    const banco = new BancoCorridas();
    const motor = new MotorGerador(cfgG, banco);
    let t = 0;
    const passo = (v, ms = 1000) => { t += ms; motor.avaliar(planta({ ...PARADO, ...v }), t); };
    passo({});
    passo({ estado: 2, tensao_bateria: 17.4 });
    passo({ estado: 2, tensao_bateria: 17.2 });
    passo({ estado: 0, falha_partida: 1 });

    const c = banco.linhas[0];
    ok('falha de partida é classificada como tal', /falha de partida/.test(c.resultado));
    ok('falha de partida não registra tempo de partida', c.tempo_partida_s === null);
    const ind = motor.indicadores(30, t);
    ok('o resumo separa as falhas de partida', ind.falhas_de_partida === 1);
    ok('a taxa de sucesso cai a zero', ind.taxa_sucesso === 0);
  }

  // --- desarme durante a carga, e a corrida fantasma que não pode existir
  {
    const banco = new BancoCorridas();
    const motor = new MotorGerador(cfgG, banco);
    let t = 0;
    const passo = (v, ms = 1000) => { t += ms; motor.avaliar(planta({ ...PARADO, ...v }), t); };
    passo({});
    passo({ estado: 2, tensao_bateria: 20.2 });
    passo({ estado: 3, potencia: 100, disjuntor_fechado: 1 });
    passo({ estado: 5, falha_pressao_oleo: 1 });                 // desarmou
    passo({ estado: 4 });                                        // resfriando depois do desarme
    passo({ estado: 4 });
    passo({ estado: 0 });

    ok('o desarme fecha a corrida com o motivo',
      banco.linhas.length >= 1 && /desarme por pressao oleo/.test(banco.linhas[0].resultado));
    ok('o resfriamento depois do desarme não abre corrida fantasma', banco.linhas.length === 1);
  }

  // --- prontidão e dias sem partir no resumo
  {
    const banco = new BancoCorridas();
    const motor = new MotorGerador(cfgG, banco);
    const agora = Date.now();
    for (let i = 0; i < 100; i++) {
      banco.amostras.push({ tag: 'gmg.pronto', ts: agora - i * 3600000, valor: i < 10 ? 0 : 1 });
    }
    const id = banco.abrirCorrida({ medidor: 'gmg', inicio: agora - 3 * 86400000 });
    banco.atualizarCorrida(id, {
      fim: agora - 3 * 86400000 + 1800000, resultado: 'normal', duracao_s: 1800,
    });
    const ind = motor.indicadores(30, agora);
    ok('prontidão vira porcentagem do tempo', Math.abs(ind.prontidao - 90) < 0.001);
    ok('dias sem partir conta do fim da última corrida',
      Math.abs(ind.dias_sem_partir - 2.98) < 0.05);
    ok('o alvo de teste acompanha o resumo', ind.teste_a_cada_dias === 7);
  }

  // --- reinício do servidor no meio de uma corrida
  {
    const banco = new BancoCorridas();
    const m1 = new MotorGerador(cfgG, banco);
    let t = 0;
    t += 1000; m1.avaliar(planta(PARADO), t);
    t += 1000; m1.avaliar(planta({ ...PARADO, estado: 2, tensao_bateria: 20 }), t);
    t += 1000; m1.avaliar(planta({ ...PARADO, estado: 3, potencia: 90, disjuntor_fechado: 1 }), t);

    const m2 = new MotorGerador(cfgG, banco);      // servidor reiniciou
    t += 1000; m2.avaliar(planta({ ...PARADO, estado: 3, potencia: 90, disjuntor_fechado: 1 }), t);
    t += 1000; m2.avaliar(planta({ ...PARADO, estado: 0 }), t);
    ok('o reinício reaproveita a corrida aberta em vez de abrir outra', banco.linhas.length === 1);
    ok('a corrida recuperada é encerrada normalmente', banco.linhas[0].fim !== null);
  }
}

console.log('\nConexão por Ethernet (Modbus TCP)');
{
  const dirPerfis = path.join(raiz, 'perfis');
  const base = {
    planta: 'Teste', porta_http: 8080, intervalo_leitura_ms: 1000,
    historico: { intervalo_gravacao_s: 15, retencao_dias: 90, arquivo: 'dados/t.db' },
  };
  const porTcp = (extra = {}) => prepararConfig({
    ...base,
    medidores: [{
      id: 'clp', perfil: 'clp-fx3u-disjuntor', nome: 'CLP', tag_isa: 'CLP-01',
      conexao: { tipo: 'tcp', host: '192.168.10.20', porta: 502, unit_id: 1, ...extra },
    }],
  }, dirPerfis).config;

  const tcp = porTcp();
  ok('equipamento por Ethernet é configuração válida', validarConfig(tcp).valido);
  ok('a conexão da loja vence a do perfil', tcp.medidores[0].conexao.tipo === 'tcp');
  ok('as tags continuam as mesmas do perfil serial',
    tcp.medidores[0].tags.some((t) => t.nome === 'nivel'));

  const semHost = prepararConfig({
    ...base,
    medidores: [{ id: 'clp', perfil: 'clp-fx3u-disjuntor', nome: 'CLP', conexao: { tipo: 'tcp', unit_id: 1 } }],
  }, dirPerfis).config;
  ok('TCP sem endereço de máquina é recusado',
    validarConfig(semHost).erros.some((e) => /TCP sem endereço/.test(e)));

  const semPorta = prepararConfig({
    ...base,
    medidores: [{ id: 'clp', perfil: 'clp-fx3u-disjuntor', nome: 'CLP', conexao: { tipo: 'rtu', unit_id: 1, porta_serial: '' } }],
  }, dirPerfis).config;
  ok('serial sem porta é recusada', validarConfig(semPorta).erros.some((e) => /serial sem porta/.test(e)));

  // o mesmo endereço em máquinas diferentes é legítimo; na mesma, não
  const duas = prepararConfig({
    ...base,
    medidores: [
      { id: 'a', perfil: 'clp-fx3u-disjuntor', nome: 'A', conexao: { tipo: 'tcp', host: '10.0.0.1', unit_id: 1 } },
      { id: 'b', perfil: 'clp-fx3u-disjuntor', nome: 'B', conexao: { tipo: 'tcp', host: '10.0.0.2', unit_id: 1 } },
    ],
  }, dirPerfis).config;
  ok('mesmo unit_id em máquinas diferentes é permitido', validarConfig(duas).valido);
  const mesma = prepararConfig({
    ...base,
    medidores: [
      { id: 'a', perfil: 'clp-fx3u-disjuntor', nome: 'A', conexao: { tipo: 'tcp', host: '10.0.0.1', unit_id: 1 } },
      { id: 'b', perfil: 'clp-fx3u-disjuntor', nome: 'B', conexao: { tipo: 'tcp', host: '10.0.0.1', unit_id: 1 } },
    ],
  }, dirPerfis).config;
  ok('endereço repetido na mesma máquina é recusado',
    validarConfig(mesma).erros.some((e) => /repetido/.test(e)));

  // o coletor separa os barramentos por máquina e porta
  const chave = (m) => (m.conexao.tipo === 'tcp'
    ? `tcp:${m.conexao.host}:${m.conexao.porta || 502}` : `rtu:${m.conexao.porta_serial}`);
  ok('cada máquina é um barramento próprio, lido em paralelo',
    new Set(duas.medidores.map(chave)).size === 2);

  const coletor = fs.readFileSync(path.join(raiz, 'src/modbus.js'), 'utf8');
  ok('o coletor abre conexão TCP', /connectTCP\(c\.host, \{ port: c\.porta \|\| 502 \}\)/.test(coletor));
  const { chaveDoBarramento } = await import('../src/modbus.js');
  ok('barramentos diferentes não compartilham fila',
    chaveDoBarramento({ tipo: 'tcp', host: '10.0.0.1' }) !== chaveDoBarramento({ tipo: 'tcp', host: '10.0.0.2' })
    && chaveDoBarramento({ tipo: 'rtu', porta_serial: 'COM3' }) !== chaveDoBarramento({ tipo: 'rtu', porta_serial: 'COM4' }));
  ok('a mesma porta escrita de outro jeito é a mesma fila',
    new Set(['COM7', 'com7', '\\\\.\\COM7'].map((p) => chaveDoBarramento({ tipo: 'rtu', porta_serial: p }))).size === 1);
  ok('no Linux a porta diferencia maiúsculas',
    chaveDoBarramento({ tipo: 'rtu', porta_serial: '/dev/ttyUSB0' }) !== chaveDoBarramento({ tipo: 'rtu', porta_serial: '/dev/TTYUSB0' }));

  const varre = fs.readFileSync(path.join(raiz, 'src/varredura.js'), 'utf8');
  ok('a varredura procura também pela rede', /tipo === 'tcp'[\s\S]{0,400}connectTCP/.test(varre));
  ok('a varredura recusa host malformado', /IP ou nome de máquina inválido/.test(varre));
  ok('conexão que não completa não fica pendurada', /Promise\.race/.test(varre));

  const servidor = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('o servidor monta a conexão por tipo', /function conexaoSalva/.test(servidor));
  ok('trocar de meio não deixa resto do outro',
    /tipo === 'tcp'[\s\S]{0,400}return \{ \.\.\.saida, tipo: 'tcp'/.test(servidor));
  ok('host inválido é recusado antes de gravar', /IP ou nome de máquina inválido/.test(servidor));
  ok('porta TCP fora de faixa é recusada', /porta TCP fora de 1 a 65535/.test(servidor));
  ok('endereço Modbus fora de 1 a 247 é recusado', /entre 1 e 247/.test(servidor));
  ok('erro de conexão responde 400 sem aplicar nada',
    /let medidores;[\s\S]{0,900}catch \(e\) \{[\s\S]{0,200}status\(400\)/.test(servidor));

  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/engenharia.js'), 'utf8');
  ok('o editor deixa escolher o meio', /data-campo="tipo"/.test(tela));
  ok('o editor pede máquina e porta em Ethernet',
    /data-campo="host"/.test(tela) && /data-campo="porta"/.test(tela));
  ok('trocar o meio limpa os campos do outro na tela',
    /campo === 'tipo'[\s\S]{0,900}porta_serial: e\.conexao\?\.porta_serial/.test(tela));
  ok('a varredura da tela manda o meio escolhido', /tipo: \$\('#v-tipo', raiz\)\.value/.test(tela));
  ok('a varredura por rede pede máquina e porta', /#v-host/.test(tela) && /#v-porta-tcp/.test(tela));

  const sim = fs.readFileSync(path.join(raiz, 'src/simulador.js'), 'utf8');
  ok('a varredura simulada respeita o meio', /meio !== tipo\) continue/.test(sim));
}

console.log('\nSeções de tela vindas do perfil');
{
  const dirPerfis = path.join(raiz, 'perfis');
  const perfisTodos = carregarPerfis(dirPerfis);
  ok('o perfil do gerador traz o esqueleto da seção',
    !!perfisTodos['gerador-generico'].gerador?.tag_nivel);
  ok('o perfil do CLP traz o esqueleto do reservatório',
    !!perfisTodos['clp-fx3u-disjuntor'].caixa_agua?.tag_nivel);
  ok('o esqueleto não chuta capacidade de tanque',
    perfisTodos['gerador-generico'].gerador.capacidade_tanque_litros === null);

  // loja que só cadastrou o equipamento, sem escrever a seção
  const crua = {
    planta: 'Teste', porta_http: 8080, intervalo_leitura_ms: 1000,
    historico: { intervalo_gravacao_s: 15, retencao_dias: 90, arquivo: 'dados/t.db' },
    medidores: [{
      id: 'gmg', perfil: 'gerador-generico', nome: 'Grupo gerador',
      conexao: { porta_serial: 'COM8', unit_id: 11 },
    }],
  };
  const { config: c1 } = prepararConfig(crua, dirPerfis);
  ok('a seção nasce do perfil quando a loja não declarou', c1.gerador?.medidor === 'gmg');
  ok('a seção herda estados, modos e falhas do perfil',
    c1.gerador.estados?.length === 6 && c1.gerador.falhas?.length === 10);
  ok('a seção herda os limites de bateria', c1.gerador.bateria_partida_min_v === 20);
  ok('a tela do gerador já funciona sem ninguém escrever JSON',
    c1.medidores[0].tags.some((t) => t.nome === 'pronto') && validarConfig(c1).valido);

  // o que a loja escreve vence o perfil
  const { config: c2 } = prepararConfig({
    ...crua,
    gerador: { medidor: 'gmg', capacidade_tanque_litros: 750, teste_a_cada_dias: 15 },
  }, dirPerfis);
  ok('o que a loja preenche vence o perfil',
    c2.gerador.capacidade_tanque_litros === 750 && c2.gerador.teste_a_cada_dias === 15);
  ok('o que a loja não preenche continua vindo do perfil', c2.gerador.bateria_minima_v === 23);

  // sem equipamento do grupo, não há seção inventada
  const { config: c3 } = prepararConfig({ ...crua, medidores: [] }, dirPerfis);
  ok('sem equipamento não existe seção', !c3.gerador);

  const secoes = secoesDosPerfis({ medidores: [] }, perfisTodos);
  ok('secoesDosPerfis é inócua sem equipamento', !secoes.gerador && !secoes.caixa_agua);
}

console.log('\nEditor de seções da instalação');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('a lista de campos gravaveis é fechada', /const CAMPOS_SECAO = \{/.test(fonte));
  for (const campo of ['capacidade_tanque_litros', 'consumo_litros_hora', 'bateria_partida_min_v',
    'capacidade_litros', 'altura_util_m']) {
    ok(`o editor pode gravar ${campo}`, fonte.includes(`'${campo}'`));
  }
  ok('estados, modos e falhas não são graváveis pelo navegador',
    !/CAMPOS_SECAO[\s\S]{0,700}'estados'/.test(fonte));
  ok('marca fora de 0 a 100 % é recusada', /marca de nível fora de 0 a 100/.test(fonte));
  ok('a prioridade da marca vem de uma lista fechada', /PRIORIDADES\.has\(m\.prioridade\)/.test(fonte));
  ok('o dono da seção é o equipamento, não o navegador', /medidor: dono\.id/.test(fonte));
  ok('equipamento removido leva a seção junto', /if \(!dono\) \{ delete bruta\[nome\]/.test(fonte));
  ok('valor de campo inválido responde 400, não aplica',
    /limparSecao[\s\S]{0,400}catch[\s\S]{0,120}status\(400\)/.test(fonte));
  ok('o servidor manda as seções para o editor', /secoes: \{ gerador: config\.gerador/.test(fonte));
  ok('o perfil manda o ponto de partida do formulário', /secao_padrao: limparParaEditor/.test(fonte));
  ok('o esqueleto do perfil não leva listas do modelo para o formulário',
    /\['estados', 'modos', 'falhas', 'tag_nivel'[^\]]*'modos_teste', 'modos_manual'\]/.test(fonte));

  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/engenharia.js'), 'utf8');
  ok('o editor manda as seções junto com os equipamentos', /secoes: this\._secoes/.test(tela));
  ok('o formulário aparece conforme os grupos cadastrados', /grupos\.has\(grupo\)/.test(tela));
  ok('o formulário parte dos valores do perfil', /semearSecaoDoPerfil\(\)/.test(tela));
  ok('as marcas de nível são editáveis na tela', /data-marca-campo="prioridade"/.test(tela));
  ok('a tela avisa quando não há seção a preencher', /não tem gerador nem reservatório/.test(tela));
}

console.log('\nGerador: superfície da tela e do servidor');
{
  const fonte = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('as calculadas entram antes da avaliação de alarmes',
    fonte.indexOf('motorGerador.avaliar(') < fonte.indexOf('motorAlarmes.avaliar('));
  ok('existe rota de indicadores', /app\.get\('\/api\/gerador\/indicadores'/.test(fonte));
  ok('a rota de indicadores exige sessão', /'\/api\/gerador\/indicadores', exigir\('operador'\)/.test(fonte));
  ok('instalação sem gerador responde 404, não estoura',
    /gerador\?\.medidor\) return res\.status\(404\)/.test(fonte));
  ok('o motor é refeito quando a configuração é aplicada',
    (fonte.match(/new MotorGerador\(/g) || []).length === 2);

  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/indicadores.js'), 'utf8');
  ok('a tela não recalcula indicador no navegador', !/reduce\(\(s, c\) => s \+ c\.duracao/.test(tela));
  ok('o modo demonstração tem números próprios', /MODO_DEMO[\s\S]{0,80}simuladosDemo\(/.test(tela));
  ok('o histórico é recarregado por tempo, não a cada varredura', /setInterval[\s\S]{0,60}30000/.test(tela));
  ok('a tela do gerador monta e desmonta os indicadores',
    /indicadores\.aoMontar\(raiz\)/.test(fs.readFileSync(path.join(raiz, 'public/assets/telas/gerador.js'), 'utf8'))
    && /indicadores\.destruir\(\)/.test(fs.readFileSync(path.join(raiz, 'public/assets/telas/gerador.js'), 'utf8')));
  ok('o gerador de demonstração inclui o módulo de indicadores',
    /telas\/indicadores\.js/.test(fs.readFileSync(path.join(raiz, 'tools/gerar-demo.js'), 'utf8')));
}

console.log('\nAcionamento: um clique não pode virar dois');
{
  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/comandos.js'), 'utf8');
  ok('os ouvintes são guardados para poder remover', /this\._aoClicar = \(ev\)/.test(tela));
  ok('montar de novo desliga o que estava ligado', /aoMontar\(raiz[^)]*\) \{\s*\n\s*this\.destruir\(\);/.test(tela));
  ok('sair da tela remove clique e teclado',
    /destruir\(\)[\s\S]{0,400}removeEventListener\('click'[\s\S]{0,120}removeEventListener\('keydown'/.test(tela));
  ok('existe espera mínima entre armar e confirmar', /const ESPERA_MINIMA = \d+;/.test(tela));
  ok('confirmação cedo demais é ignorada',
    /agora - this\._armado\.desde < ESPERA_MINIMA\) return;/.test(tela));
  ok('a espera mínima vem antes de qualquer escrita',
    tela.indexOf('ESPERA_MINIMA) return;') < tela.indexOf('this.executar(raiz'));

  // o mesmo vazamento existia nas outras telas que ligam ouvintes na raiz
  for (const arquivo of ['engenharia.js', 'usuarios.js', 'alarmes.js']) {
    const fonte = fs.readFileSync(path.join(raiz, 'public/assets/telas', arquivo), 'utf8');
    const ligaNaRaiz = /raiz\.addEventListener/.test(fonte);
    ok(`${arquivo}: ouvinte da raiz é removido ao sair`,
      !ligaNaRaiz || /removeEventListener/.test(fonte));
  }
}

console.log('\nSirene do anunciador');
{
  const app = fs.readFileSync(path.join(raiz, 'public/assets/app.js'), 'utf8');
  ok('a sirene repete enquanto houver alarme pendente', /INTERVALO_SIRENE/.test(app));
  ok('silenciar guarda o conjunto silenciado', /silenciadoEm/.test(app));
  ok('alarme novo volta a soar',
    /chave !== som\.silenciadoEm && som\.silenciadoEm/.test(app));
  ok('a sirene não depende de chegar pacote novo',
    /setInterval[\s\S]{0,240}atualizarSirene/.test(app));
  ok('reconhecido deixa de ser pendente', /filter\(\(a\) => !a\.reconhecido\)/.test(app));
  ok('o contexto de áudio é retomado quando a aba volta', /state === 'suspended'/.test(app));
}

console.log('\nVarredura de endereços: pausa da leitura');
{
  const { Coletor } = await import('../src/modbus.js');
  const { varrerBarramento } = await import('../src/varredura.js');
  const col = new Coletor({ medidores: [] });
  const esperaCurta = (p) => Promise.race([p.then(() => 'leu'), new Promise((r) => setTimeout(() => r('parado'), 60))]);

  // duas varreduras ao mesmo tempo: antes, a segunda pausa apagava a primeira
  // e a leitura ficava parada para sempre
  await col.pausar();
  await col.pausar();
  const leitura = col.lerTodos();
  ok('leitura espera enquanto houver pausa', await esperaCurta(leitura) === 'parado');
  col.retomar();
  ok('uma pausa ainda ativa segura a leitura', await esperaCurta(leitura) === 'parado');
  col.retomar();
  ok('a última retomada libera a leitura', await esperaCurta(leitura) === 'leu');

  await col.pausar();
  let recusou = false;
  try { await col.escreverBruto({ unit_id: 1, endereco: 0, valor: 1 }); } catch (e) { recusou = /varredura/.test(e.message); }
  ok('escrita não reabre a porta cedida à varredura', recusou);
  col.encerrar();
  ok('encerrar libera quem espera a pausa', await esperaCurta(col.lerTodos()) === 'leu');

  const erroDe = async (op) => { try { await varrerBarramento(op); return null; } catch (e) { return e.message; } };
  ok('faixa acima de 247 é recusada antes de abrir a porta', /1 e 247/.test(await erroDe({ de: 1, ate: 100000 })));
  ok('início maior que o fim é recusado', /1 e 247/.test(await erroDe({ de: 20, ate: 10 })));
  ok('tempo de espera absurdo é recusado', /50 e 5000/.test(await erroDe({ timeout_ms: 600000 })));
}

console.log('\nHTTPS: certificado gerado sem openssl');
{
  const crypto = await import('node:crypto');
  const { gerarCertificado } = await import('../tools/gerar-certificado.js');
  const { certificado, chave } = gerarCertificado(['painel.local', '192.168.8.109', 'localhost', '127.0.0.1']);
  const x = new crypto.X509Certificate(certificado);
  ok('o certificado é lido pelo OpenSSL do Node', !!x.fingerprint256);
  ok('a assinatura confere com a própria chave', x.verify(x.publicKey));
  ok('a chave privada corresponde ao certificado', x.checkPrivateKey(crypto.createPrivateKey(chave)));
  ok('atende o IP da loja', x.checkIP('192.168.8.109') === '192.168.8.109');
  ok('atende o nome da máquina', x.checkHost('painel.local') === 'painel.local');
  ok('não atende nome que não foi pedido', x.checkHost('outro.local') === undefined);
  ok('já vale agora e continua valendo por mais de dois anos',
    new Date(x.validFrom) <= new Date() && new Date(x.validTo) > new Date(Date.now() + 2 * 365 * 86400000));
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('com tls o servidor sobe em HTTPS', /credenciaisTls \? https\.createServer\(credenciaisTls, app\)/.test(srv));
  ok('com tls o cookie de sessão fica Secure', /https: !!credenciaisTls/.test(srv));
}

console.log('\nComandos: um por vez; configuração: rede de segurança');
{
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  const rota = srv.slice(srv.indexOf("app.post('/api/comandos/executar'"), srv.indexOf("app.get('/api/eng/diagnostico'"));
  const conferida = rota.indexOf('if (comandoEmCurso)');
  const tomada = rota.indexOf('comandoEmCurso = {');
  ok('a rota recusa enquanto houver comando em curso', conferida > 0);
  ok('a trava é tomada antes de escrever e solta no finally',
    tomada > conferida && tomada < rota.indexOf('await executar(')
    && /finally \{\s*liberarBarramento\(\);\s*comandoEmCurso = null;/.test(rota));
  ok('nenhum await entre conferir a trava e tomá-la', !rota.slice(conferida, tomada).includes('await '));
  const aplicar = srv.slice(srv.indexOf('function aplicarConfig'), srv.indexOf("app.post('/api/eng/config/aplicar'"));
  ok('toda configuração aplicada cancela a volta automática pendente', /clearTimeout\(relogioRollback\)/.test(aplicar));
}

console.log('\nBarramento RTU: uma conversa por vez, comando na frente');
{
  const { Coletor, conferirEco } = await import('../src/modbus.js');
  const { executar: executarCmd, palavrasDoComando } = await import('../src/comandos.js');
  const tag = (nome, endereco) => prepararTag({ nome, endereco, tipo: 'uint16' }, {});
  const equipamento = (id, porta, unit) => ({
    id, nome: id, conexao: { tipo: 'rtu', porta_serial: porta, unit_id: unit, baud: 9600 },
    tags: [tag('a', 0), tag('b', 50)],     // dois blocos: duas requisições por leitura
  });

  /** Cliente falso: registra quem está no fio e acusa sobreposição. */
  function clienteFalso(log, { lento = 20 } = {}) {
    let noFio = 0;
    let id = 0;
    const falar = async (oque, resposta) => {
      noFio += 1;
      log.push({ oque, inicio: Date.now(), sobreposto: noFio > 1, id });
      await new Promise((r) => setTimeout(r, lento));
      noFio -= 1;
      log.at(-1).fim = Date.now();
      if (resposta instanceof Error) throw resposta;
      return resposta;
    };
    return {
      falhar: null,
      _port: { _buffer: Buffer.alloc(0) },
      setID(x) { id = x; },
      readHoldingRegisters(ini, q) {
        if (this.falhar) { const e = this.falhar; this.falhar = null; return falar(`ler ${ini}`, e); }
        return falar(`ler ${ini}`, { data: new Array(q).fill(ini) });
      },
      writeRegister(end, v) { return falar(`escrever ${end}=${v}`, { address: end, value: v }); },
      writeRegisters(end, vs) { return falar(`escrever ${end}=${vs}`, { address: end, length: vs.length }); },
      close(cb) { cb?.(); },
    };
  }
  const montar = (config, opcoes) => {
    const col = new Coletor(config, opcoes);
    const log = [];
    for (const eq of col.equipamentos) {
      const b = col.barramentoDe(eq);
      if (!b.cliente.falso) { b.cliente = clienteFalso(log); b.cliente.falso = true; b.conectado = true; }
    }
    return { col, log };
  };

  // dois equipamentos na mesma RS-485, com a porta escrita de jeitos diferentes
  const { col, log } = montar({ medidores: [equipamento('m1', 'COM9', 1), equipamento('m2', 'com9', 2)] });
  ok('mesma porta física, uma fila só', col.barramentos.size === 1);
  await col.lerTodos();
  ok('a varredura inteira sai sem nenhum quadro sobreposto', log.length === 4 && !log.some((l) => l.sobreposto));
  const folgas = log.slice(1).map((l, i) => l.inicio - log[i].fim);
  ok('silêncio de pelo menos 3,5 caracteres entre quadros (5 ms a 9600)', folgas.every((f) => f >= 4), folgas.join(','));

  // comando no meio de uma varredura: entra logo depois do quadro que está no fio
  log.length = 0;
  const ciclo = col.lerTodos();
  await new Promise((r) => setTimeout(r, 5));
  await col.escreverBruto({ barramento: col.equipamentos[0].chave, unit_id: 1, endereco: 100, valor: 2, urgente: true });
  await ciclo;
  const ordem = log.map((l) => l.oque);
  ok('o comando urgente fura a fila da varredura', ordem.indexOf('escrever 100=2') === 1, ordem.join(' | '));
  ok('e mesmo assim nada se sobrepõe no fio', !log.some((l) => l.sobreposto));

  // resposta atrasada deixada no buffer é descartada antes do pedido seguinte
  const b = [...col.barramentos.values()][0];
  b.cliente._port._buffer = Buffer.from([1, 3, 2, 0, 9, 0, 0]);
  await col.lerTodos();
  ok('descarte de resposta atrasada: o buffer é limpo antes de cada pedido', b.cliente._port._buffer.length === 0);

  // depois de uma falha, o barramento espera mais antes de falar de novo
  log.length = 0;
  b.cliente.falhar = new Error('Timed out');
  await col.lerTodos();
  const aposFalha = log[1].inicio - log[0].fim;
  ok('depois de timeout, silêncio longo antes do próximo quadro', aposFalha >= 140, `${aposFalha} ms`);

  // reserva: durante o comando, os outros equipamentos do barramento esperam
  log.length = 0;
  const liberar = col.reservar('m1');
  const durante = await col.lerTodos();
  ok('barramento reservado: a varredura não fala com ninguém nele', log.length === 0);
  ok('quem esperou não é dado como mudo', durante.m2.online === true);
  await col.lerUm('m1');
  ok('a leitura de confirmação passa mesmo com a reserva', log.length === 2 && log.every((l) => l.id === 1));
  liberar();
  log.length = 0;
  await col.lerTodos();
  ok('liberada a reserva, a varredura volta', log.length === 4);

  // eco de outro registrador é resposta de outra conversa: não é escrita feita
  let erroEco = '';
  try { conferirEco({ address: 101, value: 2 }, { endereco: 100, valor: 2 }); } catch (e) { erroEco = e.message; }
  ok('eco de outro registrador é recusado', /outro registrador/.test(erroEco));
  let semErro = true;
  try { conferirEco({ address: 100, length: 2 }, { endereco: 100, valores: [2, 65533] }); } catch { semErro = false; }
  ok('eco certo de FC16 passa', semErro);

  // o caso da bancada: FX3U devolve endereço certo e valor 184, e obedece
  const bancada = conferirEco(
    { address: 100, value: 184, request: [1, 6, 0, 100, 0, 1], responses: [[1, 6, 0, 100, 0, 184]] },
    { endereco: 100, valor: 1 },
  );
  ok('eco com valor diferente não derruba a escrita', typeof bancada === 'string');
  ok('a divergência leva os bytes crus para a auditoria', /01 06 00 64 00 01/.test(bancada) && /00 b8/.test(bancada), bancada);
  const b184 = [...col.barramentos.values()][0];
  b184.cliente.writeRegister = async (end) => ({ address: end, value: 184 });
  const r184 = await col.escreverBruto({ barramento: col.equipamentos[0].chave, unit_id: 1, endereco: 100, valor: 1 });
  ok('coletor devolve a escrita com a divergência anotada', /value=184/.test(r184.ecoDivergente || ''));
  const conf = await executarCmd({
    comando: { endereco: 100, valor: 1, confirma_com: { tag: 'ligado', igual: 1, prazo_s: 1 } },
    idMedidor: 'm1', unitId: 1, barramento: 'x', esperar: 5,
    lerAgora: async () => ({ m1: { online: true, valores: { ligado: 1 } } }),
    coletor: { escreverBruto: async () => ({ address: 100, value: 184, ecoDivergente: 'eco com value=184 em vez de 1' }) },
  });
  ok('com eco divergente, a realimentação ainda confirma o comando', conf.confirmado === true && !!conf.eco_divergente);

  // troca de configuração: o coletor novo só abre a porta depois do antigo fechar
  let fechou = false;
  let liberarFechamento;
  const fechamento = new Promise((r) => { liberarFechamento = () => { fechou = true; r(); }; });
  const novo = new Coletor({ medidores: [equipamento('m1', 'COM9', 1)] }, { aposFechar: fechamento });
  const bn = novo.barramentoDe(novo.equipamentos[0]);
  let abriuAntes = null;
  bn.cliente = { ...clienteFalso([]), connectRTUBuffered: async () => { abriuAntes = !fechou; }, setTimeout() {} };
  const conectando = bn.conectar();
  await new Promise((r) => setTimeout(r, 30));
  ok('coletor novo não abre a serial enquanto o antigo não fechou', abriuAntes === null);
  liberarFechamento();
  await conectando;
  ok('e abre logo depois', abriuAntes === false);

  // a propriedade interna que o descarte usa ainda existe na biblioteca instalada
  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  let temBuffer = false;
  try {
    const Porta = exigir('modbus-serial/ports/rtubufferedport.js');
    temBuffer = Buffer.isBuffer(new Porta('COM250', { baudRate: 9600 })._buffer);
  } catch { /* sem driver serial nesta máquina: acusa abaixo */ }
  ok('modbus-serial ainda expõe o buffer de recepção (descarte funciona)', temBuffer);

  // comando de duas palavras: um quadro só, valor e complemento
  ok('complemento de 2 é 65533', JSON.stringify(palavrasDoComando({ valor: 2, complemento: true })) === '[2,65533]');
  const escritas = [];
  await executarCmd({
    comando: { endereco: 102, valor: 2, complemento: true },
    idMedidor: 'm1', unitId: 1, barramento: 'x', lerAgora: async () => ({}),
    coletor: { escreverBruto: async (x) => { escritas.push(x); } },
  });
  ok('comando com complemento sai num quadro só (FC16), pela fila urgente',
    escritas.length === 1 && JSON.stringify(escritas[0].valores) === '[2,65533]' && escritas[0].urgente === true);
}

console.log('\nComandos: validação das palavras e do heartbeat');
{
  const base = (comando, heartbeat = { endereco: 101 }) => validarConfig({
    medidores: [{
      id: 'clp', nome: 'CLP', conexao: { tipo: 'rtu', porta_serial: 'COM7', unit_id: 1 },
      tags: [{ nome: 'x', endereco: 0 }], heartbeat,
      comandos: [{ nome: 'desligar', endereco: 100, valor: 2, ...comando }],
    }],
    alarmes: [],
  });
  ok('comando com complemento em 102/103 é válido', base({ endereco: 102, complemento: true }).valido);
  ok('complemento que cai no heartbeat (100 + 101) é recusado',
    base({ complemento: true }).erros.some((e) => /heartbeat/.test(e)));
  ok('valores e complemento juntos são recusados',
    !base({ endereco: 102, complemento: true, valores: [1, 1] }).valido);
  ok('"dois bits" em coil são aceitos', base({ endereco: 10, funcao: 'coil', valores: [1, 1] }).valido);
  ok('coil com valor diferente de 0/1 é recusado', !base({ endereco: 10, funcao: 'coil', valores: [1, 2] }).valido);
  ok('valor acima de 65535 é recusado', !base({ endereco: 102, valor: 70000 }).valido);
  ok('comando de uma palavra só ganha aviso para usar complemento',
    base({ endereco: 102 }).avisos.some((a) => /complemento/.test(a)));
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('o terminal de engenharia não escreve em registrador de comando', /registradorReservado\(unit_id, endereco\)/.test(srv));
}

console.log('\nDeep Sea (GenComm): sentinelas, alarmes de 4 bits e derivação');
{
  const { ehSentinela } = await import('../src/mapa.js');
  const { Coletor } = await import('../src/modbus.js');
  const { estadoDoGrupo, redePresente, aplicarDerivacao } = await import('../src/derivadas.js');
  const { palavrasDoComando } = await import('../src/comandos.js');

  ok('0xFFFF em 16 bits sem sinal é "não implementado"', ehSentinela([0xffff], 'uint16'));
  ok('0x7FFC em 16 bits com sinal é "sensor em falha"', ehSentinela([0x7ffc], 'int16'));
  ok('0xFFFFFFFE em 32 bits é "acima da faixa"', ehSentinela([0xffff, 0xfffe], 'uint32'));
  ok('valor comum não é sentinela', !ehSentinela([0x0105], 'uint16') && !ehSentinela([0xfff7], 'uint16'));
  ok('-1 em 16 bits com sinal não é sentinela', !ehSentinela([0xffff], 'int16'));

  // memória de um DSE com o grupo em carga e um alarme de óleo em PARADA
  const w32 = (m, a, v) => { const u = v >>> 0; m[a] = u >>> 16; m[a + 1] = u & 0xffff; };
  const mem = {};
  mem[772] = 1;                         // modo automático
  mem[774] = (1 << 12) | (1 << 10);     // shutdown + advertência ativos
  mem[1024] = 420;                      // 420 kPa = 4,2 bar
  mem[1025] = 85;                       // °C
  mem[1026] = 0x7fff;                   // temperatura do óleo: não implementada
  mem[1027] = 62;                       // % diesel
  mem[1029] = 272;                      // 27,2 V
  mem[1030] = 1800;
  mem[1031] = 600;                      // 60,0 Hz
  w32(mem, 1038, 3805);                 // 380,5 V
  w32(mem, 1044, 1523);                 // 152,3 A
  w32(mem, 1052, -1500);                // potência reversa numa fase: sinal preservado
  mem[1059] = 600; w32(mem, 1060, 1270); // rede presente: 60 Hz, 127 V
  w32(mem, 1536, 98700);                // 98,7 kW
  mem[1557] = 92;                       // FP 0,92
  mem[1558] = 548;                      // 54,8 %
  w32(mem, 1798, 1234 * 3600);          // 1234 h
  w32(mem, 1800, 456789);               // 45678,9 kWh
  w32(mem, 1808, 321);
  mem[39425] = (1 << 12) | (3 << 8) | (1 << 4) | 15;   // emergência inativa, ÓLEO EM PARADA, temp. ok, baixa temp não impl.
  mem[39430] = (1 << 12) | (1 << 8) | (2 << 4) | 1;    // combustível baixo em ADVERTÊNCIA
  mem[39432] = (1 << 12) | (15 << 4);                  // sobrecarga em kW: não implementada neste modelo
  mem[39433] = 1;                                       // manutenção ok

  const { config: cfgDse } = prepararConfig({
    // o padrão do perfil agora é RS-232: basta dizer a porta
    medidores: [{ id: 'gmg', nome: 'GMG', perfil: 'dse-gencomm', conexao: { porta_serial: 'COM4' } }],
  }, path.join(raiz, 'perfis'));
  const col = new Coletor(cfgDse);
  const eqD = col.equipamentos[0];
  const bD = col.barramentoDe(eqD);
  const pedidos = [];
  bD.cliente = {
    _port: {}, setID() {}, close(cb) { cb?.(); },
    async readHoldingRegisters(ini, q) {
      pedidos.push([ini, q]);
      return { data: Array.from({ length: q }, (_, i) => mem[ini + i] ?? 0) };
    },
  };
  bD.conectado = true;
  const vD = (await col.lerTodos()).gmg.valores;

  ok('só função 3 (holding), como exige o DSE', pedidos.length >= 4);
  ok('pressão de óleo convertida de kPa para bar', perto(vD.pressao_oleo, 4.2, 0.001));
  ok('tensão de 32 bits com escala 0,1', perto(vD.tensao_ab, 380.5, 0.01));
  ok('corrente de 32 bits', perto(vD.corrente_a, 152.3, 0.01));
  ok('potência total em kW', perto(vD.potencia, 98.7, 0.001));
  ok('potência negativa por fase mantém o sinal', perto(vD.potencia_a, -1.5, 0.001));
  ok('sentinela vira "sem dado", não 3276,7 °C', vD.temperatura_oleo === null);
  ok('fator de potência e carga', perto(vD.fator_potencia, 0.92, 0.001) && perto(vD.carga_pct, 54.8, 0.01));
  ok('horímetro em horas', perto(vD.horimetro, 1234, 0.01));
  ok('energia acumulada e partidas', perto(vD.energia_kwh, 45678.9, 0.01) && vD.partidas === 321);
  ok('alarme em código 3 (parada) acende a falha', vD.dse_al_pressao_oleo === 3 && vD.falha_pressao_oleo === 1);
  ok('código 1 (inativo) não acende', vD.dse_al_emergencia === 1 && vD.falha_emergencia === 0);
  ok('advertência (2) também acende', vD.falha_combustivel === 1);
  ok('alarme não implementado (15) fica sem dado, não "sem falha"', vD.falha_sobrecarga === null, String(vD.falha_sobrecarga));
  ok('alarme desabilitado (0) não é falha', vD.falha_emergencia === 0);
  ok('flag de shutdown põe o grupo em falha', vD.estado === 5 && vD.alarme_parada === 1);
  ok('advertência geral vem da palavra de status', vD.alarme_advertencia === 1 && vD.alarme_trip === 0);
  ok('rede presente deduzida da medição de rede', vD.rede_presente === 1);
  ok('modo lido direto (1 = automático)', vD.modo === 1);

  // estado pelo que é medido
  const est = (v) => estadoDoGrupo(v, { frequencia_nominal_hz: 60 });
  ok('parado', est({ dse_flags: 0, rotacao: 0, frequencia: 0 }) === 0);
  ok('acelerando = partindo', est({ dse_flags: 0, rotacao: 900, frequencia: 30 }) === 2);
  ok('estável com carga = em carga', est({ dse_flags: 0, rotacao: 1800, frequencia: 60, potencia: 80 }) === 3);
  ok('estável sem carga = em vazio', est({ dse_flags: 0, rotacao: 1800, frequencia: 60, potencia: 0.2 }) === 4);
  ok('sem rotação nem frequência: sem dado', est({ dse_flags: 0 }) === null);
  ok('rede sem tensão = ausente', redePresente({ rede_frequencia: 0, rede_tensao_an: 0 }) === 0);
  ok('controlador sem medição de rede: sem dado, não "ausente"', redePresente({}) === null);
  ok('mede_rede false desliga a dedução', redePresente({ rede_frequencia: 60, rede_tensao_an: 127 }, { mede_rede: false }) === null);
  const velho = { estado: 3, rede_presente: 1 };
  aplicarDerivacao({ derivar: 'dse-gencomm', derivar_opcoes: {} }, velho);
  ok('derivado que some não fica congelado no último valor', velho.estado === null && velho.rede_presente === null);

  // comandos no formato que o DSE exige (056-051): chave + complemento, FC16
  const cmds = cfgDse.medidores[0].comandos;
  const auto = cmds.find((c) => c.nome === 'modo_auto');
  ok('modo automático: 35701 e 29834 em 4104/4105', auto.endereco === 4104
    && JSON.stringify(palavrasDoComando(auto)) === '[35701,29834]');
  ok('stop exige senha e respeita a rede', cmds.find((c) => c.nome === 'modo_stop').exige_senha
    && cmds.find((c) => c.nome === 'modo_stop').intertravamentos.some((t) => t.tag === 'rede_presente'));
  ok('perfil DSE é configuração válida', validarConfig(cfgDse).valido, validarConfig(cfgDse).erros.join('; '));

  // motivo da partida pelos códigos de modo do perfil
  const { MotorGerador } = await import('../src/gerador.js');
  const mg = new MotorGerador({ medidor: 'gmg', modos_teste: [3, 6], modos_manual: [2] });
  ok('DSE: modo 3 é teste', mg.motivoDaPartida({ modo: 3, rede_presente: 1 }) === 'teste');
  ok('DSE: modo 2 é partida manual', mg.motivoDaPartida({ modo: 2, rede_presente: 1 }) === 'partida manual');
  ok('mapa genérico continua: 2 é teste', new MotorGerador({}).motivoDaPartida({ modo: 2 }) === 'teste');

  const errado = validarConfig({ medidores: [{ id: 'x', conexao: { tipo: 'tcp', host: 'h', unit_id: 1 }, derivar: 'nao-existe',
    tags: [{ nome: 'n', endereco: 1, bit: 14, bits: 4 }] }], alarmes: [] });
  ok('derivação inexistente é recusada', errado.erros.some((e) => /derivação/.test(e)));
  ok('campo de bits que passa da palavra é recusado', errado.erros.some((e) => /campo de bits/.test(e)));
}

console.log('\nDeep Sea DSE8620: herança de perfil e paralelismo com a rede');
{
  const { Coletor } = await import('../src/modbus.js');
  const { estadoDoGrupo } = await import('../src/derivadas.js');
  const { config: c8 } = prepararConfig({
    medidores: [{ id: 'gmg', nome: 'GMG', perfil: 'dse-8620', conexao: { tipo: 'tcp', host: '10.0.0.5' } }],
  }, path.join(raiz, 'perfis'));
  const m8 = c8.medidores[0];
  const nomes = new Set(m8.tags.map((t) => t.nome));
  ok('8620 herda as tags do GenComm comum', nomes.has('pressao_oleo') && nomes.has('dse_al_emergencia'));
  ok('e acrescenta as do paralelismo', nomes.has('potencia_rede') && nomes.has('dse_al_rocof') && nomes.has('disjuntor_fechado'));
  ok('opções da derivação se somam (60 Hz do pai + falhas do filho)',
    m8.derivar_opcoes.frequencia_nominal_hz === 60 && !!m8.derivar_opcoes.falhas_extra.falha_protecao_rede);
  ok('herda os comandos do DSE', m8.comandos.some((c) => c.nome === 'modo_auto'));
  ok('seção do gerador mescla: modos do pai, falhas do filho',
    c8.gerador.modos[1] === 'Automático' && c8.gerador.falhas.includes('falha_sincronismo'));
  ok('alarmes do pai e do filho', c8.alarmes.some((a) => /pressão de óleo/.test(a.mensagem))
    && c8.alarmes.some((a) => /sincronismo/.test(a.mensagem)));
  ok('perfil 8620 é configuração válida', validarConfig(c8).valido, validarConfig(c8).erros.join('; '));

  const w32 = (m, a, v) => { const u = v >>> 0; m[a] = u >>> 16; m[a + 1] = u & 0xffff; };
  const mem = { 772: 1, 774: 0, 808: 1, 1030: 1800, 1031: 600, 1059: 600, 48896: 1, 48897: 1, 48898: 1 };
  w32(mem, 1060, 1270);
  w32(mem, 1536, 400);                      // 0,4 kW: em paralelo, quase sem carga
  w32(mem, 1560, -35000);                   // rede em −35 kW: exportando
  for (let r = 39425; r <= 39462; r++) mem[r] = 0x1111;
  mem[39442] = (1 << 12) | (1 << 8) | (4 << 4) | 1;    // ROCOF em trip elétrico
  const col = new Coletor(c8);
  const b = col.barramentoDe(col.equipamentos[0]);
  b.cliente = {
    _port: {}, setID() {}, close(cb) { cb?.(); },
    async readHoldingRegisters(ini, q) { return { data: Array.from({ length: q }, (_, i) => mem[ini + i] ?? 0) }; },
  };
  b.conectado = true;
  const v8 = (await col.lerTodos()).gmg.valores;
  ok('ROCOF em trip acende a proteção de rede', v8.falha_protecao_rede === 1);
  ok('sincronismo sem alarme fica apagado', v8.falha_sincronismo === 0);
  ok('potência da rede negativa = exportando', perto(v8.potencia_rede, -35, 0.001));
  ok('disjuntores lidos pelos LEDs virtuais', v8.disjuntor_fechado === 1 && v8.disjuntor_rede_fechado === 1);
  ok('disjuntor do gerador fechado é "em carga" mesmo a 0,4 kW', v8.estado === 3);
  ok('sem disjuntor informado, 0,4 kW é "em vazio"',
    estadoDoGrupo({ dse_flags: 0, rotacao: 1800, frequencia: 60, potencia: 0.4 }) === 4);

  const { carregarPerfis } = await import('../src/perfis.js');
  const fs2 = await import('node:fs');
  const os = await import('node:os');
  const tmp = fs2.mkdtempSync(path.join(os.tmpdir(), 'perfis-'));
  fs2.writeFileSync(path.join(tmp, 'a.json'), '{"herda":"b","tags":[]}');
  fs2.writeFileSync(path.join(tmp, 'b.json'), '{"herda":"a","tags":[]}');
  let circular = '';
  try { carregarPerfis(tmp); } catch (e) { circular = e.message; }
  ok('herança circular é recusada', /circular/.test(circular));
  fs2.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nDeep Sea por RS-232');
{
  const { silencioEntreQuadros } = await import('../src/modbus.js');
  const dir = path.join(raiz, 'perfis');
  const clp = { id: 'clp', nome: 'CLP', perfil: 'clp-fx3u-disjuntor', conexao: { tipo: 'rtu', porta_serial: 'COM7', unit_id: 1 } };
  const loja = (gmg) => prepararConfig({ medidores: [clp, { id: 'gmg', nome: 'GMG', perfil: 'dse-8620', ...gmg }] }, dir).config;

  const padrao = loja({ conexao: { porta_serial: 'COM4' } });
  const c = padrao.medidores[1].conexao;
  ok('padrão do perfil DSE: RS-232, 19200 8N1, endereço 10',
    c.tipo === 'rtu' && c.interface === 'rs232' && c.baud === 19200 && c.paridade === 'none' && c.unit_id === 10);
  ok('DSE na COM4 e CLP na COM7: válido', validarConfig(padrao).valido, validarConfig(padrao).erros.join('; '));

  const end2 = validarConfig(loja({ conexao: { porta_serial: 'COM4', unit_id: 2 } }));
  ok('endereço 2 em RS-232 é recusado (o DSE só responde no 10)',
    end2.erros.some((e) => /RS-232.*endereço 10/.test(e)), end2.erros.join('; '));
  const mesmaCom = validarConfig(loja({ conexao: { porta_serial: 'com7' } }));
  ok('RS-232 na mesma COM do CLP é recusado', mesmaCom.erros.some((e) => /ponto a ponto/.test(e)), mesmaCom.erros.join('; '));
  ok('em RS-485 o endereço é livre',
    validarConfig(loja({ conexao: { porta_serial: 'COM4', interface: 'rs485', unit_id: 2 } })).valido);
  ok('por Ethernet o endereço também é livre',
    validarConfig(loja({ conexao: { tipo: 'tcp', host: '192.168.8.20', unit_id: 2 } })).valido);
  ok('interface desconhecida é recusada',
    !validarConfig(loja({ conexao: { porta_serial: 'COM4', interface: 'rs422' } })).valido);

  // cabe no ciclo de 1 s? pedido de 8 bytes + resposta de 5 + 2n, 11 bits por byte
  const eq = padrao.medidores[1];
  const blocos = montarBlocos(eq.tags, eq.padrao).filter((b) => !b.lento);
  const ms = blocos.reduce((s, b) => s + ((8 + 5 + 2 * (b.fim - b.inicio)) * 11 * 1000) / 19200
    + silencioEntreQuadros(c) + 15, 0);   // + 15 ms de resposta do controlador por pedido
  ok(`varredura do 8620 a 19200 bps cabe com folga no ciclo (${Math.round(ms)} ms de 1000)`, ms < 500);

  const tela = fs.readFileSync(path.join(raiz, 'public/assets/telas/engenharia.js'), 'utf8');
  ok('editor oferece RS-232 e velocidade', /value="rs232"/.test(tela) && /data-campo="baud"/.test(tela));
  ok('escolher RS-232 já põe o endereço fixo do perfil', /perfil\?\.endereco_rs232/.test(tela));
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('o servidor guarda a interface e valida a velocidade', /serial\.interface = base\.interface/.test(srv)
    && /velocidade serial .* não suportada/.test(srv));

  // terminal de engenharia com duas portas: o endereço escolhe o fio
  const { Coletor } = await import('../src/modbus.js');
  const { config: duas } = prepararConfig({ medidores: [clp, { id: 'gmg', nome: 'GMG', perfil: 'dse-8620', conexao: { porta_serial: 'COM4' } }] }, dir);
  const col = new Coletor(duas);
  const perguntas = [];
  for (const eq of col.equipamentos) {
    const b = col.barramentoDe(eq);
    b.cliente = { _port: {}, setID() {}, close(cb) { cb?.(); }, async readHoldingRegisters() { perguntas.push(eq.chave); return { data: [0] }; } };
    b.conectado = true;
  }
  await col.lerBruto({ unit_id: 10, endereco: 1024, quantidade: 1 });
  await col.lerBruto({ unit_id: 1, endereco: 212, quantidade: 1 });
  ok('terminal: endereço 10 vai à COM4 do gerador, endereço 1 à COM7 do CLP',
    perguntas[0] === 'rtu:COM4' && perguntas[1] === 'rtu:COM7', perguntas.join(','));
}

console.log('\nPlanta: gerador lido pelo 7CLP1, reservatório no 15CLP1');
{
  const { Coletor } = await import('../src/modbus.js');
  const { palavrasDoComando, executar: executarCmd } = await import('../src/comandos.js');
  const dir = path.join(raiz, 'perfis');
  const bruta = JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8'));
  const { config: pl } = prepararConfig(bruta, dir);
  const vPl = validarConfig(pl);
  ok('config.planta.json é válida', vPl.valido, vPl.erros.join('; '));
  const eqDe = (id) => pl.medidores.find((m) => m.id === id);
  const gmg = eqDe('gmg');
  const sub = eqDe('subestacao');
  const tagG = (n) => gmg.tags.find((t) => t.nome === n);

  ok('remapeamento: pressão de óleo do DSE 1024 → D1010', tagG('pressao_oleo').endereco === 1010);
  ok('remapeamento: horímetro 1798 → D1090, partidas 1808 → D1100',
    tagG('horimetro').endereco === 1090 && tagG('partidas').endereco === 1100);
  ok('remapeamento: alarmes 39425 → D1110, LEDs virtuais 48896 → D1132',
    tagG('dse_al_emergencia').endereco === 1110 && tagG('disjuntor_fechado').endereco === 1132);
  ok('comandos do gerador vão para D1150 com complemento',
    gmg.comandos.every((c) => c.endereco === 1150 && c.complemento));
  ok('o gerador continua com a tradução do DSE', gmg.derivar === 'dse-gencomm' && gmg.grupo === 'gerador');
  ok('subestação sem as tags de nível e sem seção de caixa d\'água',
    !sub.tags.some((t) => t.nome === 'nivel') && pl.caixa_agua.medidor === 'reservatorio');
  ok('subestação: comando do disjuntor em D102 com complemento',
    sub.comandos.every((c) => c.endereco === 102 && c.complemento) && sub.heartbeat.endereco === 101);
  ok('alarmes de nível do pai não vão para a subestação',
    !pl.alarmes.some((a) => a.tag?.startsWith('subestacao.nivel')));

  // escravo compartilhado só quando declarado
  const dup = validarConfig(prepararConfig({ ...bruta, medidores: [...bruta.medidores,
    { id: 'outro', nome: 'Outro', perfil: 'clp-reservatorio', conexao: { porta_serial: 'COM3', unit_id: 1 } }] }, dir).config);
  ok('outro equipamento no endereço 1 da COM3 é recusado', dup.erros.some((e) => /repetido/.test(e)));

  // remapeamento que esquece um bloco é recusado na carga dos perfis
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perfis-'));
  fs.writeFileSync(path.join(tmp, 'pai.json'), JSON.stringify({ tags: [{ nome: 'a', endereco: 10 }, { nome: 'b', endereco: 500 }] }));
  fs.writeFileSync(path.join(tmp, 'filho.json'), JSON.stringify({ herda: 'pai', remapear: [{ de: 0, ate: 99, para: 1000 }] }));
  let erroMapa = '';
  try { (await import('../src/perfis.js')).carregarPerfis(tmp); } catch (e) { erroMapa = e.message; }
  ok('bloco esquecido no remapear é acusado', /fora de todos os blocos/.test(erroMapa), erroMapa);
  fs.rmSync(tmp, { recursive: true, force: true });

  // memória do 7CLP1: disjuntor nas entradas, gerador espelhado em D1000…
  const mem = {
    30: 0, 106: 0,
    1000: 1, 1002: 0, 1003: 0,
    1010: 410, 1011: 82, 1013: 71, 1015: 272, 1016: 1800, 1017: 600,
    1140: 1, 1141: 57, 1142: 0,
  };
  for (let r = 1110; r <= 1131; r++) mem[r] = 0x1111;
  const discretas = [1, 0, 1, 1, 0, 0, 0, 0];          // X0 ligado, X2 remoto, X3 permissivo
  const col = new Coletor(pl);
  const pedidos = [];
  const escritas = [];
  for (const eq of col.equipamentos) {
    const b = col.barramentoDe(eq);
    if (b.cliente.falso) continue;
    b.cliente = {
      falso: true, _port: {}, setID() {}, close(cb) { cb?.(); },
      async readHoldingRegisters(ini, q) { pedidos.push([eq.chave, ini]); return { data: Array.from({ length: q }, (_, i) => mem[ini + i] ?? 0) }; },
      async readDiscreteInputs(ini, q) { return { data: discretas.slice(ini, ini + q) }; },
      async readCoils(ini, q) { return { data: new Array(q).fill(false) }; },
      async writeRegisters(end, vs) { escritas.push([end, ...vs]); return { address: end, length: vs.length }; },
      async writeRegister(end, v) { escritas.push([end, v]); return { address: end, value: v }; },
    };
    b.conectado = true;
  }
  let lido = await col.lerTodos();
  ok('gerador online pelo enlace do CLP', lido.gmg.online === true);
  ok('valores do DSE chegam traduzidos pelo CLP', perto(lido.gmg.valores.pressao_oleo, 4.1)
    // 1800 rpm, 60 Hz e 0 kW: girando estável sem carga = 4 (em vazio)
    && perto(lido.gmg.valores.tensao_bateria, 27.2) && lido.gmg.valores.modo === 1 && lido.gmg.valores.estado === 4);
  ok('disjuntor lido nas entradas do 7CLP1', lido.subestacao.valores.disjuntor_ligado === 1
    && lido.subestacao.valores.permite_religar === 1);
  ok('subestação e gerador no mesmo fio (COM3), medidores na COM4',
    pedidos.some(([c, a]) => c === 'rtu:COM3' && a === 1000) && pedidos.some(([c, a]) => c === 'rtu:COM4' && a === 212));

  mem[1140] = 0;                                       // CLP perdeu o DSE
  lido = await col.lerTodos();
  ok('CLP sem o DSE: gerador sem comunicação, com o motivo', lido.gmg.online === false
    && /sem comunicação com o DSE8620/.test(lido.gmg.erro));
  ok('o disjuntor continua em comunicação', lido.subestacao.online === true);

  // comando ao gerador sai para o CLP, no formato que ele repassa ao DSE
  const auto = gmg.comandos.find((c) => c.nome === 'modo_auto');
  await executarCmd({
    comando: auto, idMedidor: 'gmg', coletor: col, unitId: 1, barramento: 'rtu:COM3', lerAgora: async () => ({}),
  });
  ok('modo automático → FC16 em D1150/D1151 = 35701/29834', JSON.stringify(escritas.at(-1)) === '[1150,35701,29834]'
    && JSON.stringify(palavrasDoComando(auto)) === '[35701,29834]');

  // simulação da planta inteira (npm run planta-demo)
  const sim = new Simulador(pl, { roteiro: true });
  const s = await sim.lerTodos();
  ok('simulador cobre subestação, gerador e reservatório', 'disjuntor_ligado' in s.subestacao.valores
    && Number.isFinite(s.reservatorio.valores.nivel) && Number.isFinite(s.gmg.valores.rotacao));
}

console.log('\nConsumo de energia hora a hora');
{
  const { Banco } = await import('../src/db.js');
  const {
    contadorEm, consumoDoDia, consolidar, limitesDoDia,
  } = await import('../src/consumo.js');

  // contador: interpola na virada da hora; zerado não vale
  const a = [{ ts: 0, valor: 100 }, { ts: 60000, valor: 101 }];
  ok('contador interpolado entre duas leituras', perto(contadorEm(a, 30000), 100.5));
  ok('contador que voltou (medidor zerado) não tem valor', contadorEm([{ ts: 0, valor: 900 }, { ts: 60000, valor: 2 }], 30000) === null);
  ok('longe de qualquer leitura não há valor', contadorEm(a, 3 * 3600000) === null);

  const dia = '2026-03-10';
  const L = limitesDoDia(dia);
  ok('dia tem 25 limites de hora em hora', L.length === 25 && L[1] - L[0] === 3600000);
  ok('dia inválido é recusado', limitesDoDia('2026-02-30') === null && limitesDoDia('ontem') === null);

  // dois setores com potência conhecida, gravados a cada 15 s como o servidor faz
  const banco = new Banco(':memory:');
  const kwSetor = { padaria: (h) => (h >= 7 && h < 22 ? 20 : 5), frios: () => 12 };
  const contador = { geral: 5000, padaria: 1000, frios: 3000 };
  const lote = banco.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)');
  const passo = 15000;
  banco.db.transaction(() => {
    for (let t = L[0]; t <= L[24]; t += passo) {
      const h = new Date(t).getHours();
      const kw = { padaria: kwSetor.padaria(h), frios: kwSetor.frios(h) };
      kw.geral = kw.padaria + kw.frios + 3;            // 3 kW não medidos
      for (const id of ['geral', 'padaria', 'frios']) {
        // falha de comunicação: a padaria some das 04:50 às 05:10 (contador inútil na virada das 5h)
        const mudo = id === 'padaria' && t > L[4] + 50 * 60000 && t < L[5] + 10 * 60000 + 1;
        if (!mudo) {
          lote.run(t, `${id}.energia_ativa`, contador[id]);
          lote.run(t, `${id}.potencia_ativa`, kw[id]);
        }
        contador[id] += kw[id] * (passo / 3600000);
      }
    }
  })();
  const cfgC = {
    historico: { intervalo_gravacao_s: 15 },
    medidores: [
      { id: 'geral', nome: 'Entrada', principal: true, grupo: 'energia', tags: [{ nome: 'energia_ativa', unidade: 'kWh', acumulador: true }, { nome: 'potencia_ativa', unidade: 'kW' }] },
      { id: 'padaria', nome: 'Padaria', grupo: 'energia', tags: [{ nome: 'energia_ativa', unidade: 'kWh', acumulador: true }, { nome: 'potencia_ativa', unidade: 'kW' }] },
      { id: 'frios', nome: 'Frios', grupo: 'energia', tags: [{ nome: 'energia_ativa', unidade: 'kWh', acumulador: true }, { nome: 'potencia_ativa', unidade: 'kW' }] },
      { id: 'clp', nome: 'CLP', grupo: 'agua', tags: [] },
    ],
  };
  const fimDoDia = L[24] + 3600000;
  const r = consumoDoDia(banco, cfgC, dia, fimDoDia);
  const s = (id) => r.setores.find((x) => x.id === id);
  ok('só medidores de energia entram', r.setores.length === 3 && r.geral === 'geral');
  ok('padaria às 10h: 20 kWh, pelo contador', perto(s('padaria').kwh[10], 20, 0.01) && s('padaria').fonte[10] === 'contador');
  ok('padaria às 2h: 5 kWh', perto(s('padaria').kwh[2], 5, 0.01));
  ok('frios 24 × 12 kWh = 288 kWh no dia', perto(s('frios').total, 288, 0.05), String(s('frios').total));
  ok('falha na virada da hora: estimado pela potência', s('padaria').fonte[4] === 'potencia' && s('padaria').fonte[5] === 'potencia'
    && perto(s('padaria').kwh[4], 5, 0.3), JSON.stringify([s('padaria').kwh[4], s('padaria').fonte[4]]));
  ok('não medido = entrada menos setores (3 kWh por hora)', perto(r.nao_medido[10], 3, 0.05));
  ok('total do dia pelo contador bate com a soma das horas',
    perto(s('geral').total, s('geral').kwh.reduce((t, v) => t + v, 0), 0.01));

  // hoje às 14h20: horas futuras vazias, a hora corrente parcial
  const agora = L[14] + 20 * 60000;
  const hoje = consumoDoDia(banco, cfgC, dia, agora);
  const fr = hoje.setores.find((x) => x.id === 'frios');
  ok('hora corrente é parcial (20 min de 12 kW = 4 kWh)', fr.parcial[14] && perto(fr.kwh[14], 4, 0.1), String(fr.kwh[14]));
  ok('horas futuras ficam vazias, não zero', fr.futura[15] && fr.kwh[15] === null && fr.futura[23]);

  // consolidação: sobrevive à limpeza do histórico bruto
  const gravadas = consolidar(banco, cfgC, fimDoDia, 48);
  ok('horas fechadas consolidadas (3 medidores × 24 h)', gravadas >= 72, String(gravadas));
  ok('consolidar de novo não duplica', consolidar(banco, cfgC, fimDoDia, 48) === 0);
  banco.db.prepare('DELETE FROM amostras').run();
  const depois = consumoDoDia(banco, cfgC, dia, fimDoDia);
  ok('apagado o histórico bruto, o consumo do dia continua', perto(depois.setores.find((x) => x.id === 'frios').total, 288, 0.05));
  ok('a estimativa também fica registrada como estimativa', depois.setores.find((x) => x.id === 'padaria').fonte[5] === 'potencia');

  // energia aparente: mesma conta, com o contador em kVAh e a potência em kVA
  const ba = new Banco(':memory:');
  const insA = ba.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)');
  const ctr = { 'geral.energia_ativa': 8500, 'geral.energia_aparente': 9000, 'frios.energia_ativa': 3800, 'frios.energia_aparente': 4000 };
  const pot = { geral: { kw: 20, kva: 22 }, frios: { kw: 12, kva: 15 } };    // frios com FP 0,8
  ba.db.transaction(() => {
    for (let t = L[0]; t <= L[24]; t += passo) {
      for (const id of ['geral', 'frios']) {
        insA.run(t, `${id}.energia_ativa`, ctr[`${id}.energia_ativa`]);
        insA.run(t, `${id}.energia_aparente`, ctr[`${id}.energia_aparente`]);
        insA.run(t, `${id}.potencia_ativa`, pot[id].kw);
        insA.run(t, `${id}.potencia_aparente`, pot[id].kva);
        ctr[`${id}.energia_ativa`] += pot[id].kw * (passo / 3600000);
        ctr[`${id}.energia_aparente`] += pot[id].kva * (passo / 3600000);
      }
    }
  })();
  const tagsA = [
    { nome: 'energia_ativa', unidade: 'kWh', acumulador: true }, { nome: 'energia_aparente', unidade: 'kVAh', acumulador: true },
    { nome: 'potencia_ativa', unidade: 'kW' }, { nome: 'potencia_aparente', unidade: 'kVA' },
  ];
  const cfgA = {
    historico: { intervalo_gravacao_s: 15 },
    medidores: [
      { id: 'geral', nome: 'Entrada', principal: true, grupo: 'energia', tags: tagsA },
      { id: 'frios', nome: 'Frios', grupo: 'energia', tags: tagsA },
    ],
  };
  const ap = consumoDoDia(ba, cfgA, dia, fimDoDia, 'aparente');
  const at = consumoDoDia(ba, cfgA, dia, fimDoDia, 'ativa');
  ok('energia aparente do dia: frios 24 × 15 kVAh = 360 kVAh', perto(ap.setores.find((x) => x.id === 'frios').total, 360, 0.05)
    && ap.unidade === 'kVAh', String(ap.setores.find((x) => x.id === 'frios').total));
  ok('a ativa do mesmo medidor continua 288 kWh', perto(at.setores.find((x) => x.id === 'frios').total, 288, 0.05) && at.unidade === 'kWh');
  ok('"não medido" só na ativa: aparente não se soma entre setores', ap.nao_medido === null && Array.isArray(at.nao_medido));
  ok('grandeza desconhecida é recusada', consumoDoDia(ba, cfgA, dia, fimDoDia, 'reativa') === null);
  ok('consolidação grava as duas grandezas, separadas (2 medidores × 24 h × 2)', consolidar(ba, cfgA, fimDoDia, 48) >= 96);
  ba.db.prepare('DELETE FROM amostras').run();
  ok('apagado o bruto, aparente e ativa continuam cada uma com o seu valor',
    perto(consumoDoDia(ba, cfgA, dia, fimDoDia, 'aparente').setores.find((x) => x.id === 'frios').total, 360, 0.05)
    && perto(consumoDoDia(ba, cfgA, dia, fimDoDia, 'ativa').setores.find((x) => x.id === 'frios').total, 288, 0.05));

  // banco de antes da energia aparente: a tabela é migrada sem perder o que já estava consolidado
  {
    const { default: Sqlite } = await import('better-sqlite3');
    const arqV = path.join(raiz, 'dados', `teste-migracao-${process.pid}.db`);
    const velho = new Sqlite(arqV);
    velho.exec(`CREATE TABLE consumo_horario (medidor TEXT NOT NULL, hora INTEGER NOT NULL, kwh REAL NOT NULL,
                fonte TEXT NOT NULL, PRIMARY KEY (medidor, hora));
                INSERT INTO consumo_horario VALUES ('geral', 3600000, 125.5, 'contador');`);
    velho.close();
    const migrado = new Banco(arqV);
    const linha = migrado.db.prepare('SELECT * FROM consumo_horario').get();
    ok('migração: consumo já consolidado vira "ativa", sem perda', linha?.grandeza === 'ativa' && linha.kwh === 125.5);
    migrado.gravarConsumo([{ medidor: 'geral', grandeza: 'aparente', hora: 3600000, kwh: 131, fonte: 'contador' }]);
    ok('migração: mesma hora aceita a aparente ao lado da ativa', migrado.db.prepare('SELECT COUNT(*) n FROM consumo_horario').get().n === 2);
    migrado.db.close();
    for (const f of fs.readdirSync(path.join(raiz, 'dados'))) if (f.startsWith(`teste-migracao-${process.pid}`)) fs.rmSync(path.join(raiz, 'dados', f), { force: true });
  }

  // limpeza: histórico bruto em 30 dias, mas o que alimenta indicador de longo prazo fica
  const lb = new Banco(':memory:');
  const DIA = 86400000;
  const T = Date.UTC(2026, 9, 1);
  const ins = lb.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)');
  for (const d of [10, 45, 100, 130]) {
    ins.run(T - d * DIA, 'geral.potencia_ativa', 1);
    ins.run(T - d * DIA, 'gmg.pronto', 1);
  }
  lb.db.prepare(`INSERT INTO gerador_corridas (medidor, inicio, fim) VALUES ('gmg', ?, ?), ('gmg', ?, ?)`)
    .run(T - 400 * DIA, T - 400 * DIA, T - 800 * DIA, T - 800 * DIA);
  lb.gravarConsumo([{ medidor: 'geral', hora: T - 900 * DIA, kwh: 10, fonte: 'contador' }]);
  lb.limparAntigos(30, T);
  const restam = (tag) => lb.db.prepare('SELECT COUNT(*) n FROM amostras WHERE tag = ?').get(tag).n;
  ok('histórico bruto: só os últimos 30 dias', restam('geral.potencia_ativa') === 1);
  ok('prontidão do gerador: 120 dias (indicador de 90)', restam('gmg.pronto') === 3);
  ok('corridas do gerador: 2 anos', lb.db.prepare('SELECT COUNT(*) n FROM gerador_corridas').get().n === 1);
  ok('consumo por hora nunca é apagado', lb.db.prepare('SELECT COUNT(*) n FROM consumo_horario').get().n === 1);
  ok('config.planta.json sem prazo fixo: o histórico vai até o disco apertar',
    JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8')).historico.retencao_dias === undefined);
  {
    const sem = new Banco(':memory:');
    sem.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)').run(T - 400 * DIA, 'geral.potencia_ativa', 1);
    sem.limparAntigos(null, T);
    ok('sem retencao_dias, a idade não apaga o histórico bruto', sem.db.prepare('SELECT COUNT(*) n FROM amostras').get().n === 1);
  }

  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('rota /api/consumo exige sessão', /app\.get\('\/api\/consumo', exigir\('operador'\)/.test(srv));
  ok('consolidação periódica e na partida', /setInterval\(consolidarConsumo/.test(srv) && /setTimeout\(consolidarConsumo/.test(srv));
  const app = fs.readFileSync(path.join(raiz, 'public/assets/app.js'), 'utf8');
  ok('tela Consumo no menu, depois do Unifilar', /telaUnifilar, telaConsumo/.test(app));

  globalThis.window ??= { DEMO_EMBUTIDO: false, addEventListener() {} };
  globalThis.location ??= { search: '', protocol: 'http:', host: 'x' };
  const { _consumoInterno: ci } = await import('../public/assets/telas/consumo.js');
  ok('fim de escala redondo', ci.consEscalaRedonda(37) === 50 && ci.consEscalaRedonda(180) === 200 && ci.consEscalaRedonda(0.7) === 1);
  ok('coluna de altura zero não desenha nada', ci.consColuna(0, 100, 10, 100) === '');
}

console.log('\nSessão encerrada fecha o tempo real');
{
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('troca de senha pelo admin derruba as sessões', /campos\.hash \|\| campos\.ativo === 0/.test(srv));
  ok('o vigia fecha canal de sessão vencida', /fecharCanais\(\(ws\) => !acesso\.usuarioDoToken\(ws\.token\)\)/.test(srv));
  ok('demo.html não é servido pelo supervisório', /app\.get\('\/demo\.html'/.test(srv));
  const nuc = fs.readFileSync(path.join(raiz, 'public/assets/nucleo.js'), 'utf8');
  ok('o painel vai ao login quando o canal fecha com 4001', /ev\.code === 4001/.test(nuc));
}

console.log('\nInstalação no Linux');
{
  const svc = fs.readFileSync(path.join(raiz, 'supervisorio.service'), 'utf8');
  const campo = (k) => (svc.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  ok('serviço sobe com a configuração da planta', /server\.js --config config\.planta\.json$/.test(campo('ExecStart')));
  ok('serviço fora do root, com acesso às seriais', campo('User') && campo('User') !== 'root' && /dialout/.test(campo('SupplementaryGroups')));
  ok('serviço no fuso da loja (consumo por hora)', campo('Environment') !== undefined && /^Environment=TZ=America\/Sao_Paulo$/m.test(svc));
  ok('serviço escreve na própria pasta (config salva pela tela)', campo('ReadWritePaths') === campo('WorkingDirectory'));

  const sh = fs.readFileSync(path.join(raiz, 'tools/instalar-linux.sh'));
  ok('instalar-linux.sh com fim de linha Unix', !sh.includes(13));
  const txt = sh.toString('utf8');
  ok('instalador não leva node_modules do Windows nem os bancos', /--exclude=\.\/node_modules/.test(txt) && /--exclude=\.\/dados/.test(txt));
  ok('instalador preserva a configuração do servidor', /\.nova/.test(txt) && /--exclude='\.\/config\*\.json'/.test(txt));

  // central de operação: scripts que rodam no Linux, resumo da loja fechado para quem não é a central
  for (const f of ['central/montar-vm.sh', 'central/vpn-novo.sh', 'central/backup.sh', 'central/web.sh', 'central/acesso.sh']) {
    ok(`${f} com fim de linha Unix`, !fs.readFileSync(path.join(raiz, f)).includes(13));
  }
  const srvC = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('resumo para a central só responde ao IP declarado em central.ip, e não ao que vem pelo proxy dela',
    /app\.get\('\/api\/central\/resumo'[\s\S]{0,500}if \(!ipCentral \|\| de !== ipCentral \|\| req\.headers\['x-forwarded-for'\]\)/.test(srvC));
  ok('a central é proxy confiável da loja (bloqueio de senha pelo IP real)',
    /origemDaRequisicao\(req,\s*\[\.\.\.\(config\.seguranca\?\.proxies_confiaveis \|\| \[\]\), config\.central\?\.ip\]/.test(srvC));
  ok('instalador liga a loja na VPN e grava central.ip', /--vpn\)/.test(txt) && /c\.central = \{ \.\.\.\(c\.central \|\| \{\}\), ip \}/.test(txt));
  const centralJs = fs.readFileSync(path.join(raiz, 'central/servidor.js'), 'utf8');
  ok('central escuta só no endereço da VPN por padrão', /CENTRAL_ESCUTA \|\| '10\.88\.0\.1'/.test(centralJs));
  // alarme da instalação com {nome}: renomear o equipamento muda a mensagem junto
  {
    const plantaN = JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8'));
    plantaN.medidores.find((m) => m.id === 'frios').nome = 'Climatização';
    const regraN = prepararConfig(plantaN, path.join(raiz, 'perfis')).config.alarmes.find((r) => r.tag === 'frios.potencia_ativa');
    ok('alarme "sem consumo" mostra o nome atual do equipamento vigiado', regraN?.mensagem === 'Climatização sem consumo — possível desarme', regraN?.mensagem);
    ok('config.planta.json: alarmes "sem consumo" usam {nome}',
      plantaN.alarmes.filter((a) => /sem consumo/.test(a.mensagem)).every((a) => a.mensagem.startsWith('{nome}')));
  }
  const histJs = fs.readFileSync(path.join(raiz, 'public/assets/telas/historico.js'), 'utf8');
  ok('histórico lista grandeza sem unidade (fator de potência), não só as com unidade',
    /filter\(\(t\) => !t\.digital && !t\.enum && \(t\.unidade !== '' \|\| !t\.oculto\)\)/.test(histJs));
  const alarmesHtml = fs.readFileSync(path.join(raiz, 'central/publico/alarmes.html'), 'utf8');
  ok('central: tela de alarmes servida e copiada para a VM',
    /'\/alarmes': 'alarmes\.html'/.test(centralJs) && /publico\/"\*\.html/.test(fs.readFileSync(path.join(raiz, 'central/montar-vm.sh'), 'utf8')));
  ok('alarmes: "Abrir configurador" leva direto à tela de alarmes da loja', /#alarmes`/.test(alarmesHtml));
  ok('alarmes: loja sem contato também vira alarme', /Loja sem comunicação com a central/.test(alarmesHtml));
  ok('alarmes: lista só redesenha quando muda (clique não se perde)', /assinatura === alvo\.dataset\.assinatura/.test(alarmesHtml));
  const loginJs = fs.readFileSync(path.join(raiz, 'public/assets/login.js'), 'utf8');
  ok('login devolve para a tela pedida, só nome de tela (nada de endereço externo)',
    /\/\^\[a-z\]\[a-z0-9_-\]\{0,30\}\$\/\.test\(tela\) \? `\/#\$\{tela\}` : '\/'/.test(loginJs));
  const montar = fs.readFileSync(path.join(raiz, 'central/montar-vm.sh'), 'utf8');
  ok('VPN: operador alcança loja, loja não alcança loja', /-s 10\.88\.2\.0\/24 -d 10\.88\.1\.0\/24 -j ACCEPT/.test(montar) && /-i wg0 -o wg0 -j DROP/.test(montar));

  // acesso pela internet: login Google na frente, lista de e-mails mantida pela tela Acessos
  {
    const { caddyfile, baseDoIp, hostDaLoja } = await import('../central/web.js');
    const base = baseDoIp('146.235.41.191');
    ok('nome sem domínio próprio: o IP no sslip.io', base === '146-235-41-191.sslip.io');
    ok('id de loja com "_" vira nome de máquina válido', hostDaLoja('loja_2', base) === `loja-loja-2.${base}`);
    const cf = caddyfile({ base }, [{ id: 'e01', ip: '10.88.1.1', porta: 8080 }]);
    ok('Caddy: central e cada loja atrás do login', /central\.146-235-41-191\.sslip\.io \{/.test(cf) && /loja-e01\.146-235-41-191\.sslip\.io \{/.test(cf)
      && (cf.match(/forward_auth 127\.0\.0\.1:4180/g) || []).length === 2 && /reverse_proxy 10\.88\.1\.1:8080/.test(cf));
    ok('Caddy: o navegador não escolhe o próprio e-mail', (cf.match(/request_header -X-Auth-Request-Email/g) || []).length === 2);
    ok('Caddy: resumo da loja não existe pela internet', /loja-e01[\s\S]*handle \/api\/central\/\* \{\s*respond 404/.test(cf));
    const blocoCentral = cf.split(/\n(?=loja-)/)[0];
    ok('Caddy: só apresentação, privacidade e ícone da central sem login',
      ['/sobre', '/privacidade', '/icone.png'].every((p) => blocoCentral.includes(`handle ${p} {\n\t\treverse_proxy 127.0.0.1:8081`))
      && !/loja-e01[\s\S]*handle \/privacidade/.test(cf));

    const tmp = fs.mkdtempSync(path.join(raiz, 'dados', 'central-'));
    fs.mkdirSync(path.join(tmp, 'acesso'));
    fs.writeFileSync(path.join(tmp, 'acesso', 'emails.txt'), 'chefe@gmail.com\n');
    fs.writeFileSync(path.join(tmp, 'acesso', 'administradores.txt'), 'chefe@gmail.com\n');
    fs.writeFileSync(path.join(tmp, 'web.json'), JSON.stringify({ base }));
    fs.writeFileSync(path.join(tmp, 'lojas.json'), JSON.stringify({ lojas: [{ id: 'e01', nome: 'Viza', ip: '10.88.1.1', porta: 8080 }] }));
    Object.assign(process.env, {
      CENTRAL_ACESSO: path.join(tmp, 'acesso'), CENTRAL_WEB: path.join(tmp, 'web.json'), CENTRAL_LOJAS: path.join(tmp, 'lojas.json'),
    });
    const { atender } = await import('../central/servidor.js');
    const http = await import('node:http');
    const subir = (viaWeb) => new Promise((r) => { const s = http.createServer(atender(viaWeb)).listen(0, '127.0.0.1', () => r(s)); });
    const web = await subir(true);
    const vpn = await subir(false);
    const pedir = async (s, caminho, { email, corpo, semCabecalho } = {}) => {
      const r = await fetch(`http://127.0.0.1:${s.address().port}${caminho}`, {
        method: corpo ? 'POST' : 'GET',
        headers: { ...(email ? { 'X-Auth-Request-Email': email } : {}), ...(corpo && !semCabecalho ? { 'X-Central': '1' } : {}), 'Content-Type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      return { status: r.status, dados: await r.json().catch(() => null) };
    };
    try {
      ok('web sem e-mail do login: barrado', (await pedir(web, '/')).status === 403);
      const pub = await fetch(`http://127.0.0.1:${web.address().port}/privacidade`);
      const sob = await fetch(`http://127.0.0.1:${web.address().port}/sobre`);
      ok('política de privacidade e apresentação abertas sem login (exigência do Google)',
        pub.status === 200 && /Política de Privacidade/.test(await pub.text()) && sob.status === 200 && /privacidade/.test(await sob.text()));
      ok('web com e-mail fora da lista: barrado', (await pedir(web, '/api/lojas', { email: 'estranho@gmail.com' })).status === 403);
      const eu = await pedir(web, '/api/eu', { email: 'Chefe@Gmail.com' });
      ok('administrador reconhecido (maiúsculas não importam)', eu.dados?.admin === true && eu.dados?.web === true);
      ok('alteração sem o cabeçalho próprio é recusada', (await pedir(web, '/api/acesso', { email: 'chefe@gmail.com', corpo: { email: 'op@gmail.com' }, semCabecalho: true })).status === 400);
      const lib = await pedir(web, '/api/acesso', { email: 'chefe@gmail.com', corpo: { email: 'Op@Gmail.com', admin: false } });
      ok('administrador libera um e-mail', lib.status === 200 && lib.dados.usuarios.some((u) => u.email === 'op@gmail.com' && !u.admin));
      ok('o e-mail vai para o arquivo que o oauth2-proxy lê', fs.readFileSync(path.join(tmp, 'acesso', 'emails.txt'), 'utf8').split('\n').includes('op@gmail.com'));
      ok('registro de quem liberou', /chefe@gmail\.com\s+liberou\s+op@gmail\.com/.test(fs.readFileSync(path.join(tmp, 'acesso', 'registro.log'), 'utf8')));
      const lojasWeb = await pedir(web, '/api/lojas', { email: 'op@gmail.com' });
      ok('operador liberado vê as lojas, e o painel abre pelo endereço da internet', lojasWeb.dados?.lojas[0].painel === `https://loja-e01.${base}/`);
      ok('operador não vê nem altera a lista', (await pedir(web, '/api/acesso', { email: 'op@gmail.com' })).status === 403
        && (await pedir(web, '/api/acesso', { email: 'op@gmail.com', corpo: { email: 'x@gmail.com' } })).status === 403);
      ok('administrador não remove o próprio acesso', (await pedir(web, '/api/acesso/remover', { email: 'chefe@gmail.com', corpo: { email: 'chefe@gmail.com' } })).status === 400);
      ok('administrador não tira o próprio papel', (await pedir(web, '/api/acesso', { email: 'chefe@gmail.com', corpo: { email: 'chefe@gmail.com', admin: false } })).status === 400);
      ok('e-mail inválido recusado', (await pedir(web, '/api/acesso', { email: 'chefe@gmail.com', corpo: { email: 'nao é email' } })).status === 400);
      await pedir(web, '/api/acesso/remover', { email: 'chefe@gmail.com', corpo: { email: 'op@gmail.com' } });
      ok('removido perde o acesso na hora', (await pedir(web, '/api/lojas', { email: 'op@gmail.com' })).status === 403);
      const lojasVpn = await pedir(vpn, '/api/lojas');
      ok('pela VPN continua igual: painel direto pelo IP da VPN', lojasVpn.status === 200 && lojasVpn.dados.lojas[0].painel === 'http://10.88.1.1:8080/');
      ok('pela VPN o cabeçalho de e-mail não vale nada', (await pedir(vpn, '/api/acesso', { email: 'chefe@gmail.com' })).status === 403);
    } finally {
      web.close(); vpn.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const priv = fs.readFileSync(path.join(raiz, 'central/publico/privacidade.html'), 'utf8');
    ok('política de privacidade sem campo a preencher, com o controlador e o canal de contato',
      !/preencher|\[[A-Za-zÀ-ú ]+\]/.test(priv) && /Engemase Engenharia LTDA/.test(priv) && /engemase@engemase\.com\.br/.test(priv) && /Uso Limitado/.test(priv));
    const wsh = fs.readFileSync(path.join(raiz, 'central/web.sh'), 'utf8');
    ok('web.sh: só os e-mails da lista entram (sem email_domains liberando tudo)',
      /authenticated_emails_file = "\$ACESSO\/emails\.txt"/.test(wsh) && !/email_domains/.test(wsh));
    ok('web.sh: oauth2-proxy só em 127.0.0.1 e com download conferido', /http_address = "127\.0\.0\.1:4180"/.test(wsh) && /sha256sum/.test(wsh));
    ok('montar-vm: central abre a porta do login só em 127.0.0.1 e grava a lista', /CENTRAL_PROXY_PORTA=8081/.test(montar) && /ReadWritePaths=-\$DESTINO\/acesso/.test(montar));
    ok('central: porta web só em 127.0.0.1', /abrir\(PORTA_WEB, '127\.0\.0\.1', true\)/.test(centralJs));
  }

  // logos: abrem sem login (a tela de login mostra), o resto da interface não
  ok('logos liberados sem login, só imagem da pasta marcas', /assets\\\/marcas\\\/\[\\w-\]\+\\\.\(svg\|png\|webp\)/.test(srvC));
  const idx = fs.readFileSync(path.join(raiz, 'public/index.html'), 'utf8');
  const lgn = fs.readFileSync(path.join(raiz, 'public/login.html'), 'utf8');
  ok('logo do cliente no cabeçalho e da Engemase no rodapé',
    /data-marca="cliente"/.test(idx) && /data-marca="engemase"/.test(idx) && /data-marca="cliente"/.test(lgn) && /data-marca="engemase"/.test(lgn));
  ok('index.html e login.html sem acentuação corrompida', !/Ã/.test(idx + lgn) && /Supervisório/.test(idx));

  // LINUX.md promete 2 equipamentos na COM3 e 10 na COM4 para o sed das portas
  const planta = JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8'));
  const naPorta = (p) => planta.medidores.filter((m) => m.conexao.porta_serial === p).length;
  ok('contagem de portas do LINUX.md bate com a planta', naPorta('COM3') === 2 && naPorta('COM4') === 10, `${naPorta('COM3')}/${naPorta('COM4')}`);

  // redefinir-senha: volta ao estado de primeiro acesso, sem tocar nos outros usuários
  const { Banco, prepararAcesso } = await import('../src/db.js');
  const { spawnSync } = await import('node:child_process');
  const marca = `teste-senha-${process.pid}`;
  const arqCfg = path.join(raiz, 'dados', `${marca}.json`);
  const arqDb = path.join(raiz, 'dados', `${marca}.db`);
  fs.writeFileSync(arqCfg, JSON.stringify({ historico: { arquivo: `dados/${marca}.db` } }));
  const b = new Banco(arqDb);
  prepararAcesso(b.db);
  const ac = new Acesso(b, {});
  ac.garantirAdmin();
  const adm = b.usuarioPorLogin('admin');
  const { sal, hash } = gerarHash('Operador-Antigo-1');
  b.criarUsuario({ login: 'op', nome: 'Op', papel: 'operador', hash, sal, trocar_senha: 0, criado_em: Date.now() });
  b.criarSessao({ token: 'velho', usuario_id: adm.id, criada_em: Date.now(), expira_em: Date.now() + 3600000, origem: 'x' });
  b.atualizarUsuario(adm.id, { ativo: 0 });
  b.db.close();
  const r = spawnSync(process.execPath, ['tools/redefinir-senha.js', '--config', path.relative(raiz, arqCfg)], { cwd: raiz, encoding: 'utf8' });
  const nova = (r.stdout.match(/Senha temporária: (\S+)/) || [])[1];
  const b2 = new Banco(arqDb);
  const depois = b2.db.prepare("SELECT * FROM usuarios WHERE login = 'admin'").get();
  const op = b2.db.prepare("SELECT * FROM usuarios WHERE login = 'op'").get();
  ok('redefinir-senha: senha nova vale', r.status === 0 && !!nova && conferirSenha(nova, depois.sal, depois.hash), r.stderr);
  ok('redefinir-senha: conta reativada e troca obrigatória', depois.ativo === 1 && depois.trocar_senha === 1);
  ok('redefinir-senha: sessões antigas derrubadas', !b2.sessao('velho'));
  ok('redefinir-senha: outros usuários intactos', conferirSenha('Operador-Antigo-1', op.sal, op.hash));
  ok('redefinir-senha: fica na auditoria', b2.db.prepare("SELECT COUNT(*) n FROM auditoria WHERE acao = 'senha_redefinida'").get().n === 1);
  const r2 = spawnSync(process.execPath, ['tools/redefinir-senha.js', '--config', path.relative(raiz, arqCfg), 'ninguem'], { cwd: raiz, encoding: 'utf8' });
  ok('redefinir-senha: usuário inexistente lista os cadastrados', r2.status === 1 && /admin \(admin\), op \(operador\)/.test(r2.stderr), r2.stderr);
  b2.db.close();
  for (const f of fs.readdirSync(path.join(raiz, 'dados'))) if (f.startsWith(marca)) fs.rmSync(path.join(raiz, 'dados', f), { force: true });
}

console.log('\nMedidor 7KT0310: endereço da norma, palavra baixa primeiro (CDAB)');
{
  const { Coletor } = await import('../src/modbus.js');
  const { filtrarContador } = await import('../src/contadores.js');
  const { montarBlocos } = await import('../src/mapa.js');

  // memória do medidor como ele é: 30001 = endereço 0, float com a palavra BAIXA primeiro
  const mem = new Map();
  const f32 = (reg, v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); mem.set(reg, b.readUInt16BE(2)); mem.set(reg + 1, b.readUInt16BE(0)); };
  f32(0, 221.43); f32(2, 220.87); f32(4, 222.0); f32(16, 12.3); f32(18, 11.8); f32(20, 12.9);
  f32(42, 7.5); f32(54, 0.93); f32(56, 60.01); f32(58, 35990.25); f32(96, 173123.37); f32(98, 0);

  // o engano do fluxo antigo: ABCD a partir do endereço+1 junta a metade alta da
  // grandeza com a metade baixa da SEGUINTE. Tensão quase certa; energia em degraus de 1024
  const comoAntes = (reg) => { const b = Buffer.alloc(4); b.writeUInt16BE(mem.get(reg + 1)); b.writeUInt16BE(mem.get(reg + 2), 2); return b.readFloatBE(0); };
  ok('reproduz o engano: tensão parecia certa (erro < 0,5 V)', Math.abs(comoAntes(0) - 221.43) < 0.5 && comoAntes(0) !== 221.43);
  ok('reproduz o engano: energia só em múltiplos de 1024 kWh (exportada = 0)', comoAntes(96) % 1024 === 0, String(comoAntes(96)));

  const { config: c7 } = prepararConfig({
    medidores: [{ id: 'geral', nome: 'Geral', perfil: '7kt0310-entrada', conexao: { porta_serial: 'COM9', unit_id: 1 } }],
  }, path.join(raiz, 'perfis'));
  const blocos = montarBlocos(c7.medidores[0].tags, c7.medidores[0].padrao);
  ok('V1N (30001) sai pedindo o endereço 0, como manda a norma', blocos[0].inicio === 0 && blocos[0].endereco_fisico === 0);
  ok('nenhuma leitura passa de 12 registradores (acima disso o 7KT0310 dá CRC)', blocos.every((b) => b.fim - b.inicio <= 12));
  ok('energia consumida = Total_kWh_imp (96), não a líquida', c7.medidores[0].tags.find((t) => t.nome === 'energia_ativa').endereco === 96);

  const col = new Coletor(c7);
  const eq = col.equipamentos[0];
  const bar = col.barramentoDe(eq);
  const pedidos = [];
  bar.cliente = {
    _port: {}, setID() {}, close(cb) { cb?.(); },
    async readInputRegisters(ini, q) {
      pedidos.push([ini, q]);
      return { data: Array.from({ length: q }, (_, i) => mem.get(ini + i) ?? 0) };
    },
    async readHoldingRegisters() { throw new Error('o 7KT0310 é lido só pela função 04'); },
  };
  bar.conectado = true;
  const v = (await col.lerTodos()).geral.valores;
  ok('só função 04, cada float começando no endereço par', pedidos.length > 0 && pedidos.every(([ini]) => ini % 2 === 0), JSON.stringify(pedidos));
  ok('tensões exatas', perto(v.tensao_an, 221.43, 0.001) && perto(v.tensao_bn, 220.87, 0.001) && perto(v.tensao_cn, 222.0, 0.001), `${v.tensao_an}`);
  ok('corrente, potência, FP e frequência certos',
    perto(v.corrente_b, 11.8, 0.001) && perto(v.potencia_ativa, 7.5, 0.001) && perto(v.fp, 0.93, 0.0001) && perto(v.frequencia, 60.01, 0.001));
  ok('energia com as casas decimais, não em degraus de 1024', perto(v.energia_ativa, 173123.37, 0.02), String(v.energia_ativa));
  f32(96, 36012.5);                 // os testes do filtro abaixo partem deste contador
  await col.lerUm('geral');
  eq.contadores = {};
  eq.diag.contador_recusado = 0;
  await col.lerUm('geral');

  // o deslocamento de endereço continua disponível para equipamento que numera a partir de 1
  const desl = montarBlocos(c7.medidores[0].tags, { ...c7.medidores[0].padrao, deslocamento_endereco: 1 });
  ok('deslocamento_endereco 1 soma 1 só no pedido', desl[0].inicio === 0 && desl[0].endereco_fisico === 1);

  // leitura fisicamente impossível (float corrompido) vira "sem dado"
  f32(42, 1.37e36);
  const absurdo = (await col.lerUm('geral')).geral.valores;
  ok('potência de 1e36 kW vira sem dado, não vai para tela nem histórico', absurdo.potencia_ativa === null);
  f32(42, 7.5);

  // leitura com as metades do float de momentos diferentes: salta 256 kWh
  f32(96, 36012.5 + 256);
  let r = (await col.lerUm('geral')).geral.valores;
  ok('salto impossível do contador é recusado (fica o último bom)', perto(r.energia_ativa, 36012.5, 0.01) && eq.diag.contador_recusado === 1);
  f32(96, 36012.5);
  r = (await col.lerUm('geral')).geral.valores;
  ok('a leitura boa seguinte segue normal', perto(r.energia_ativa, 36012.5, 0.01) && eq.diag.contador_recusado === 1);
  // medidor trocado: o contador recomeça e se confirma em duas leituras
  f32(96, 12.0);
  r = (await col.lerUm('geral')).geral.valores;
  ok('contador que desceu: recusado na primeira leitura', perto(r.energia_ativa, 36012.5, 0.01));
  r = (await col.lerUm('geral')).geral.valores;
  ok('e aceito quando a leitura seguinte confirma (medidor trocado)', perto(r.energia_ativa, 12.0, 0.01));

  // a regra em si, com o tempo controlado
  const H = 3600000;
  let e = filtrarContador(undefined, 1000, 0, 750).estado;
  ok('subida dentro da demanda máxima é aceita', filtrarContador(e, 1010, H / 60, 750).valor === 1010);   // 600 kW
  ok('subida acima de 750 kWh/h é recusada', filtrarContador(e, 1020, H / 60, 750).valor === 1000);       // 1200 kW
  ok('arredondamento do float32 não é tratado como descida', filtrarContador(e, 1000 - 0.0004, H / 60, 750).valor === 1000 - 0.0004);
  e = filtrarContador(e, 1300, 1000, 750).estado;
  ok('salto isolado: a referência continua a antiga', e.ref.v === 1000 && e.cand.v === 1300);
  ok('leitura sem valor não apaga a referência', filtrarContador(e, null, 2000, 750).valor === 1000);

  const { config: bad } = prepararConfig({
    medidores: [{ id: 'x', nome: 'X', perfil: '7kt0310-alimentador', padrao: { deslocamento_endereco: 2 }, conexao: { porta_serial: 'COM9', unit_id: 3 } }],
  }, path.join(raiz, 'perfis'));
  ok('deslocamento_endereco fora de -1..1 é recusado', validarConfig(bad).erros.some((x) => /deslocamento_endereco/.test(x)));

  // tudo na mesma porta, mas o 7CLP1 ainda em 19200: seria interrogado a 9600 e nunca responderia
  const plantaUmaPorta = JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8'));
  for (const m of plantaUmaPorta.medidores) m.conexao.porta_serial = '/dev/ttyUSB0';
  const errosUmaPorta = validarConfig(prepararConfig(plantaUmaPorta, path.join(raiz, 'perfis')).config).erros;
  ok('porta com duas velocidades é recusada', errosUmaPorta.some((x) => /subestacao: na porta \/dev\/ttyUSB0 em 19200 8N1, mas geral/.test(x)), errosUmaPorta.join('; '));
  ok('e o endereço 1 repetido (medidor geral e 7CLP1) também', errosUmaPorta.some((x) => /endereço 1 repetido em \/dev\/ttyUSB0: geral e subestacao/.test(x)));

  // Terminal de engenharia no modo simulado também responde no endereço do fio
  const sim = new Simulador(c7);
  const vs = (await sim.lerTodos()).geral.valores;
  const cru = await sim.lerBruto({ unit_id: 1, endereco: 0, quantidade: 2 });
  const bf = Buffer.alloc(4);
  bf.writeUInt16BE(cru.dados[1], 0);    // CDAB: a palavra alta vem depois
  bf.writeUInt16BE(cru.dados[0], 2);
  const lido = bf.readFloatBE(0);
  // o simulador varia a tensão entre uma leitura e outra; o que importa é cair na faixa de V1N
  ok('simulador: endereço 0 devolve V1N em CDAB, como o medidor real', perto(lido, vs.tensao_an, 5) && lido > 150, `${lido} vs ${vs.tensao_an}`);

  const pl = JSON.parse(fs.readFileSync(path.join(raiz, 'config.planta.json'), 'utf8'));
  const baud = (p) => [...new Set(pl.medidores.filter((m) => m.conexao.porta_serial === p).map((m) => m.conexao.baud))];
  ok('COM4 (medidores + 15CLP1) em 9600, como os medidores já estão', baud('COM4').join() === '9600', baud('COM4').join());
  ok('COM3 (7CLP1) continua em 19200', baud('COM3').join() === '19200');

  // RS-485 com um medidor mudo (endereço sem equipamento) no meio dos bons
  {
    const { falhaDaPorta } = await import('../src/modbus.js');
    ok('timeout de um escravo não é falha da porta serial', !falhaDaPorta(new Error('Timed out'), true) && !falhaDaPorta(new Error('CRC error'), true));
    ok('porta caída (USB arrancado) é', falhaDaPorta(new Error('Port Not Open'), true) && falhaDaPorta(new Error('EIO: i/o error'), true));
    ok('em TCP, timeout continua reconectando', falhaDaPorta(new Error('Timed out'), false));

    const { config: cm } = prepararConfig({
      medidores: [1, 2, 9].map((u) => ({ id: `m${u}`, nome: `M${u}`, perfil: '7kt0310-alimentador', conexao: { porta_serial: '/dev/ttyUSB0', unit_id: u } })),
    }, path.join(raiz, 'perfis'));
    for (const m of cm.medidores) delete m.varredura_a_cada;
    const colM = new Coletor(cm);
    const barM = colM.barramentoDe(colM.equipamentos[0]);
    let fechou = 0;
    const pedidosM = [];
    barM.cliente = {
      _port: {}, id: 1, setID(x) { this.id = x; }, close(cb) { fechou++; cb?.(); },
      async readInputRegisters(ini, q) {
        pedidosM.push(this.id);
        if (this.id === 9) throw new Error('Timed out');      // ninguém no endereço 9
        return { data: Array.from({ length: q }, (_, i) => mem.get(ini + i) ?? 0) };
      },
    };
    barM.conectado = true;
    ok('linha dos 7KT0310 com 20 ms entre um pedido e o próximo (norma: 4 ms)', barM.entreQuadros === 20, String(barM.entreQuadros));
    barM.aposFalha = 0;                                       // o teste não precisa esperar os 150 ms
    for (let i = 0; i < 4; i++) await colM.lerTodos();
    const r = await colM.lerTodos();
    ok('o mudo não fecha a porta dos outros', fechou === 0 && barM.conectado);
    ok('os bons continuam em comunicação', r.m1.online && r.m2.online);
    ok('o mudo é dado como sem comunicação', r.m9.online === false && /Timed out/.test(r.m9.erro || ''));
    ok('e deixa de ser perguntado a cada ciclo (só 2 tentativas em 5 ciclos)', pedidosM.filter((u) => u === 9).length === 2, pedidosM.join(','));
    colM.equipamentos[2].retomarEm = 1;                        // passou o tempo de espera
    await colM.lerTodos();
    ok('passado o intervalo, volta a ser tentado', pedidosM.filter((u) => u === 9).length === 3);

    // a folga vale para a porta inteira: o 15CLP1 na mesma linha não encurta a dos medidores
    const { config: cmix } = prepararConfig({
      medidores: [
        { id: 'res', nome: 'R', perfil: 'clp-reservatorio', conexao: { porta_serial: '/dev/ttyUSB0', unit_id: 10, baud: 9600 } },
        { id: 'g', nome: 'G', perfil: '7kt0310-entrada', conexao: { porta_serial: '/dev/ttyUSB0', unit_id: 1 } },
      ],
    }, path.join(raiz, 'perfis'));
    const colX = new Coletor(cmix);
    ok('porta compartilhada usa a maior folga pedida, não a do primeiro cadastrado', colX.barramentoDe(colX.equipamentos[0]).entreQuadros === 20);
  }

  // disco apertado: o histórico antigo sai antes da hora, nunca abaixo de 3 dias
  {
    const { Banco: BancoD } = await import('../src/db.js');
    const arqD = path.join(raiz, 'dados', `teste-disco-${process.pid}.db`);
    const bd = new BancoD(arqD);
    const agoraD = Date.UTC(2026, 9, 8, 12);
    const h = 3600000;
    bd.db.transaction(() => {
      for (let ts = agoraD - 5 * 24 * h; ts < agoraD; ts += 15 * 60000) {
        for (let i = 0; i < 20; i++) bd.inserir.run(ts, `m.t${i}`, i);
      }
    })();
    const antes = bd.inicioDoHistorico();
    const n = bd.apagarMaisAntigo(6, 3, agoraD);
    ok('apaga as 6 h mais antigas', n === 24 * 20 && bd.inicioDoHistorico() === antes + 6 * h, String(n));
    ok('o espaço apagado fica livre dentro do arquivo (reaproveitado)', bd.livreNoArquivo() > 0);
    let voltas = 0;
    while (bd.apagarMaisAntigo(6, 3, agoraD) && voltas < 50) voltas++;
    ok('para nos 3 dias mínimos', bd.inicioDoHistorico() >= agoraD - 3 * 24 * h && bd.inicioDoHistorico() < agoraD - 3 * 24 * h + 15 * 60000);
    ok('banco vazio: nada a apagar', new BancoD(':memory:').apagarMaisAntigo(6, 3) === 0);
    bd.db.close();
    for (const f of [arqD, `${arqD}-wal`, `${arqD}-shm`]) fs.rmSync(f, { force: true });
    const srvD = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
    ok('disco cheio não congela a tela: falha ao gravar o histórico é isolada',
      /try \{\s*banco\.gravarAmostras\(ts, equipamentos\);[\s\S]{0,200}\} catch \(e\) \{/.test(srvD));
    ok('limpeza por falta de espaço roda sozinha a cada 10 min, um dia por vez',
      /setInterval\(conferirDisco, 10 \* 60000\)/.test(srvD) && /banco\.apagarMaisAntigo\(24, 3, Date\.now\(\), tags\)/.test(srvD));

    // resumo de 5 min e consulta de vários dias
    const br = new BancoD(':memory:');
    const T0 = Date.UTC(2026, 9, 1);
    br.db.transaction(() => {
      for (let ts = T0; ts < T0 + 10 * 24 * h; ts += 15000) {
        br.inserir.run(ts, 'g.p', (ts / 15000) % 2 ? 10 : 20);     // alterna 10 e 20: média 15
        br.inserir.run(ts, 'g.q', 1);
      }
    })();
    const tagsR = ['g.p', 'g.q'];
    let partes = 0;
    while (!br.resumirAmostras(tagsR, T0 + 10 * 24 * h + 2 * h) && partes < 300) partes++;
    ok('resumo de 5 min feito em partes até ficar em dia', partes >= 100 && partes < 300 && br.marca('resumo_ate') >= T0 + 10 * 24 * h - 300000, String(partes));
    const r5 = br.db.prepare("SELECT * FROM resumo_5min WHERE tag = 'g.p' ORDER BY ts LIMIT 1").get();
    ok('cada 5 min guarda média, mínimo, máximo e quantas amostras', r5.ts === T0 && r5.n === 20 && r5.min === 10 && r5.max === 20 && Math.abs(r5.med - 15) < 1e-9);
    const fimR = T0 + 10 * 24 * h;
    const s7 = br.consultarSerie('g.p', fimR - 7 * 24 * h, fimR, 240);
    ok('7 dias vêm do resumo: ~240 pontos com a média certa', s7.length <= 241 && s7.length >= 200 && s7.every((p) => Math.abs(p.med - 15) < 1e-9 && p.min === 10 && p.max === 20), String(s7.length));
    const s30bruto = br.consultarSerie('g.p', fimR - 24 * h, fimR, 240);
    ok('24 h vêm do bruto, agrupado (antes vinha uma linha por amostra)', s30bruto.length <= 241, String(s30bruto.length));
    br.gravarMarca('resumo_ate', T0);
    ok('resumo atrasado (logo depois da atualização): consulta longa cai para o bruto, sem buraco',
      br.consultarSerie('g.p', fimR - 7 * 24 * h, fimR, 240).length >= 200);
    const antesR = br.db.prepare('SELECT COUNT(*) n FROM resumo_5min').get().n;
    ok('resumo também sai um dia por vez quando o disco aperta, nunca abaixo de 30 dias',
      br.apagarResumoMaisAntigo(tagsR, 24, 30, T0 + 31 * 24 * h) === 2 * 288 && br.db.prepare('SELECT COUNT(*) n FROM resumo_5min').get().n === antesR - 576
      && br.apagarResumoMaisAntigo(tagsR, 24, 30, T0 + 30 * 24 * h) === 0);
    ok('bruto apagado por grandeza, um dia', br.apagarMaisAntigo(24, 3, fimR, tagsR) === 2 * 5760);
  }

  // THD por setor: corrente harmônica em ampères e leitura lenta com rodízio
  {
    const { aplicarDerivacao } = await import('../src/derivadas.js');
    const v = { corrente_a: 100, thd_corrente: 30, corrente_b: 50, thd_corrente_b: 10, corrente_c: 40, thd_corrente_c: null };
    aplicarDerivacao({ derivar: 'harmonicas' }, v);
    ok('corrente harmônica = I·THD/√(1+THD²)', Math.abs(v.corrente_harmonica_a - 28.735) < 0.01
      && Math.abs(v.corrente_harmonica_b - 4.975) < 0.01, `${v.corrente_harmonica_a} ${v.corrente_harmonica_b}`);
    ok('fase sem THD lido fica sem dado, e a maior fase ignora ela', v.corrente_harmonica_c === null && v.corrente_harmonica === v.corrente_harmonica_a);

    const { config: ch } = prepararConfig({
      varreduras_por_leitura_lenta: 20,
      medidores: [
        { id: 'g', nome: 'G', perfil: '7kt0310-entrada', principal: true, conexao: { porta_serial: '/dev/ttyUSB0', unit_id: 1 } },
        ...[2, 3, 4, 5, 6, 7, 8, 9].map((u) => ({ id: `s${u}`, nome: `S${u}`, perfil: '7kt0310-alimentador', varredura_a_cada: 4, limites: { corrente_a: { max: 100 } }, conexao: { porta_serial: '/dev/ttyUSB0', unit_id: u } })),
      ],
    }, path.join(raiz, 'perfis'));
    ok('alimentador lê o THD das 3 fases', ['thd_corrente', 'thd_corrente_b', 'thd_corrente_c'].every((n) => ch.medidores[1].tags.some((t) => t.nome === n)));
    ok('entrada lê o THD de tensão das 3 fases', ['thd_tensao', 'thd_tensao_b', 'thd_tensao_c'].every((n) => ch.medidores[0].tags.some((t) => t.nome === n)));
    ok('perfis válidos com o THD e as harmônicas', validarConfig(ch).valido, validarConfig(ch).erros.join('; '));
    const colH = new Coletor(ch);
    const barH = colH.barramentoDe(colH.equipamentos[0]);
    const thdLidos = {};
    barH.cliente = {
      _port: {}, id: 1, setID(x) { this.id = x; }, close(cb) { cb?.(); },
      async readInputRegisters(ini, q) {
        if (ini <= 136 && ini + q > 136) thdLidos[this.id] = (thdLidos[this.id] || 0) + 1;
        return { data: Array.from({ length: q }, () => 0) };
      },
    };
    barH.conectado = true;
    barH.entreQuadros = 0;
    for (let i = 0; i < 81; i++) await colH.lerTodos();
    // 80 ciclos com rodízio de 4 e lentos a cada 20: cada setor relê ~4 vezes
    const poucos = [2, 3, 4, 5, 6, 7, 8, 9].filter((u) => (thdLidos[u] || 0) < 3);
    ok('com rodízio de 4, todo setor relê os lentos (antes os de índice ímpar nunca reliam)', poucos.length === 0, JSON.stringify(thdLidos));
    const r = await colH.lerTodos();
    ok('a corrente harmônica sai junto com a leitura', 'corrente_harmonica' in r.s2.valores && 'corrente_harmonica_a' in r.g.valores);
  }

  // tools/limpar-leituras.js: absurdos de qualquer data + contador 7KT0310 até --ate
  {
    const { Banco: BancoL } = await import('../src/db.js');
    const { spawnSync: rodar } = await import('node:child_process');
    const marcaL = `teste-limpar-${process.pid}`;
    const cfgL = path.join(raiz, 'dados', `${marcaL}.json`);
    fs.writeFileSync(cfgL, JSON.stringify({
      historico: { arquivo: `dados/${marcaL}.db` },
      medidores: [
        { id: 'geral', nome: 'G', perfil: '7kt0310-entrada', conexao: { porta_serial: 'COM9', unit_id: 1 } },
        { id: 'res', nome: 'R', perfil: 'clp-reservatorio', conexao: { porta_serial: 'COM9', unit_id: 10, baud: 9600 } },
      ],
    }));
    const bl = new BancoL(path.join(raiz, 'dados', `${marcaL}.db`));
    const T = Date.UTC(2026, 9, 5, 12);
    const insL = bl.db.prepare('INSERT INTO amostras (ts, tag, valor) VALUES (?, ?, ?)');
    insL.run(T - 7200000, 'geral.potencia_ativa', 1.37e36);
    insL.run(T - 7200000, 'geral.potencia_ativa', 7.5);
    insL.run(T - 3600000, 'geral.energia_ativa', 172032);
    insL.run(T + 3600000, 'geral.energia_ativa', 173123.37);
    insL.run(T - 3600000, 'res.nivel', 50);
    bl.gravarConsumo([{ medidor: 'geral', hora: T - 7200000, kwh: 1024, fonte: 'contador' }]);
    bl.db.close();
    const ate = new Date(T).toISOString();
    const seco = rodar(process.execPath, ['tools/limpar-leituras.js', '--config', path.relative(raiz, cfgL), '--ate', ate], { cwd: raiz, encoding: 'utf8' });
    const bl2 = new BancoL(path.join(raiz, 'dados', `${marcaL}.db`));
    const nAm = () => bl2.db.prepare('SELECT COUNT(*) n FROM amostras').get().n;
    ok('limpar-leituras sem --aplicar só mostra', seco.status === 0 && /3 linhas seriam apagadas/.test(seco.stdout) && nAm() === 5, seco.stdout + seco.stderr);
    const ap = rodar(process.execPath, ['tools/limpar-leituras.js', '--config', path.relative(raiz, cfgL), '--ate', ate, '--aplicar'], { cwd: raiz, encoding: 'utf8' });
    const sobra = bl2.db.prepare('SELECT tag, valor FROM amostras ORDER BY tag, ts').all().map((x) => `${x.tag}=${x.valor}`).join(' ');
    ok('apaga o 1e36, o contador em degrau e a hora consolidada; o resto fica',
      ap.status === 0 && sobra === 'geral.energia_ativa=173123.37 geral.potencia_ativa=7.5 res.nivel=50'
      && bl2.db.prepare('SELECT COUNT(*) n FROM consumo_horario').get().n === 0, sobra + ap.stderr);
    ok('limpeza fica na auditoria', bl2.db.prepare("SELECT COUNT(*) n FROM auditoria WHERE acao = 'historico_limpo'").get().n === 1);
    bl2.db.close();
    for (const f of fs.readdirSync(path.join(raiz, 'dados'))) if (f.startsWith(marcaL)) fs.rmSync(path.join(raiz, 'dados', f), { force: true });
  }

  // alarme de faixa estreita (frequência 59,5–60,5): tem que fechar quando o valor volta
  {
    const abertos = new Map();
    let idA = 0;
    const bancoA = {
      alarmesAtivos: () => [...abertos.values()],
      abrirAlarme: (a) => { idA += 1; abertos.set(idA, { ...a, id: idA }); return idA; },
      fecharAlarme: (id) => abertos.delete(id),
      atualizarValorAlarme: () => {},
    };
    const motorF = new MotorAlarmes([{ tag: 'geral.frequencia', min: 59.5, max: 60.5, mensagem: 'freq' }], bancoA);
    const freq = (v) => ({ geral: { online: true, valores: { frequencia: v } } });
    motorF.avaliar(freq(58.0), 1000);
    ok('frequência fora da faixa abre o alarme', abertos.size === 1);
    motorF.avaliar(freq(60.01), 2000);
    ok('voltando a 60 Hz o alarme fecha (antes ficava preso para sempre)', abertos.size === 0);
    motorF.avaliar(freq(59.45), 3000);
    motorF.avaliar(freq(59.6), 4000);
    ok('histerese ainda existe: 59,6 Hz logo após 59,45 não fecha', abertos.size === 1);
  }
  const entrada = JSON.parse(fs.readFileSync(path.join(raiz, 'perfis/7kt0310-entrada.json'), 'utf8'));
  ok('sequência de fase (registrador 700 nunca confirmado) fora do perfil',
    !entrada.tags.some((t) => t.nome === 'sequencia_fase') && !entrada.alarmes.some((a) => a.tag === 'sequencia_fase'));

  const srvEq = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('remover equipamento pelo editor leva junto os alarmes da instalação dele',
    /if \(!idNovo\.has\(alvo\)\) \{ alarmesRemovidos\.push/.test(srvEq) && /res\.json\(comAvisos\(r\)\)/.test(srvEq));
}

console.log('\nLigação com a nuvem pela interface');
{
  const TOKEN = `pnl_${'a'.repeat(43)}`;
  const OUTRO = `pnl_${'b'.repeat(43)}`;
  const v = validarLigacao({ url: 'https://engemase-pulse.vercel.app/admin/', token: `  "token": "${TOKEN}"  ` });
  ok('endereço vira só a origem e o token sai do trecho colado',
    v.ok && v.dados.url === 'https://engemase-pulse.vercel.app' && v.dados.token === TOKEN);
  ok('http só vale no próprio computador',
    !validarLigacao({ url: 'http://exemplo.com', token: TOKEN }).ok && validarLigacao({ url: 'http://localhost:3000', token: TOKEN }).ok);
  ok('token que não é do Pulse é recusado', !validarLigacao({ url: 'https://x.com', token: 'abc123' }).ok);
  ok('sem token nenhum pede para colar', /cole o token/.test(validarLigacao({ url: 'https://x.com' }).erros?.[0] || ''));
  ok('token em branco mantém o atual (trocar só o endereço)',
    validarLigacao({ url: 'https://y.com', token: '' }, { token: TOKEN }).dados?.token === TOKEN);
  ok('módulos: só os conhecidos, na ordem padrão',
    validarLigacao({ url: 'https://x.com', token: TOKEN, modulos: ['gerador', 'energia'] }).dados?.modulos.join() === 'energia,gerador'
    && !validarLigacao({ url: 'https://x.com', token: TOKEN, modulos: ['piscina'] }).ok);

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvem-'));
  const arquivo = path.join(pasta, 'dados', 'nuvem-config.json');
  const marcas = new Map([['nuvem_resumo_ate', 123], ['nuvem_consumo_rowid', 9]]);
  const bancoN = { marca: (n) => marcas.get(n) ?? null, gravarMarca: (n, val) => marcas.set(n, val) };
  const ligacao = new LigacaoNuvem(arquivo);
  const cfgN = { planta: 'Teste', medidores: [{ id: 'geral', grupo: 'energia' }], nuvem: { url: 'https://antigo.com', token: OUTRO, intervalo_s: 30 } };
  const n = new Nuvem(() => cfgN, bancoN, { ligacao });
  n.parar();
  ok('sem nada gravado vale a seção do config.json', n.conf.url === 'https://antigo.com' && n.resumo().origem === 'configuracao');
  ligacao.gravar(v.dados);
  ok('o que a tela gravou vale por cima, e o resto da seção continua',
    n.conf.url === 'https://engemase-pulse.vercel.app' && n.conf.token === TOKEN && n.conf.intervalo_s === 30);
  const resumo = n.resumo();
  ok('a tela recebe só o final do token', resumo.token_final === 'aaaa' && !JSON.stringify(resumo).includes(TOKEN) && resumo.origem === 'interface');
  ok('arquivo só para o dono (o token é uma senha)', process.platform === 'win32' || (fs.statSync(arquivo).mode & 0o077) === 0);
  ok('lido de novo do disco (reinício do serviço)', new LigacaoNuvem(arquivo).ler()?.token === TOKEN);
  n.falhas = 3; n.esperaAte = Date.now() + 60000; n.equipamentosAceitos = true;
  n.reiniciar({ historico: true });
  ok('token de outra unidade: tenta já e o histórico recomeça',
    n.falhas === 0 && n.esperaAte === 0 && !n.equipamentosAceitos && marcas.get('nuvem_resumo_ate') === null && marcas.get('nuvem_consumo_rowid') === null);
  ok('módulos gravados na tela mandam no que vai para o Pulse',
    (ligacao.gravar({ ...v.dados, modulos: ['energia', 'agua'] }), n.modulos().join() === 'energia,agua'));
  ligacao.apagar();
  ok('remover a ligação da tela volta para a seção do config.json', n.conf.url === 'https://antigo.com' && !fs.existsSync(arquivo));
  fs.rmSync(pasta, { recursive: true, force: true });

  const srvN = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  ok('as rotas da nuvem pedem perfil de técnico',
    /app\.get\('\/api\/eng\/nuvem', exigir\('tecnico'\)/.test(srvN) && /app\.post\('\/api\/eng\/nuvem', exigir\('tecnico'\)/.test(srvN));
  ok('dados/ (onde fica o token) não vai para o Git',
    /^dados\/$/m.test(fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8')));
}

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
