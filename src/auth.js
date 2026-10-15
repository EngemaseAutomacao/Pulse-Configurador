/**
 * Autenticação e autorização.
 *
 * Sem dependência externa: senha com scrypt (node:crypto), sessão em cookie
 * HttpOnly guardada no SQLite. Três papéis, em escada:
 *   operador — vê as telas e reconhece alarme
 *   tecnico  — tudo do operador + engenharia (varredura, leitura, configuração)
 *   admin    — tudo do técnico + usuários e auditoria
 */
import crypto from 'node:crypto';

export const PAPEIS = { operador: 1, tecnico: 2, admin: 3 };
const PARAMS = { N: 16384, r: 8, p: 1, tamanho: 32 };

export function gerarHash(senha, sal = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, sal, PARAMS.tamanho, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return { sal, hash: hash.toString('hex') };
}

export function conferirSenha(senha, sal, hashEsperado) {
  const { hash } = gerarHash(senha, sal);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashEsperado, 'hex');
  // comparação em tempo constante: não vaza quanto do hash estava certo
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function forcaDaSenha(senha) {
  const problemas = [];
  if (!senha || senha.length < 10) problemas.push('mínimo de 10 caracteres');
  if (!/[a-zA-Z]/.test(senha || '')) problemas.push('pelo menos uma letra');
  if (!/[0-9]/.test(senha || '')) problemas.push('pelo menos um número');
  if (/^(senha|painel|admin|123456)/i.test(senha || '')) problemas.push('não pode começar com palavra óbvia');
  return problemas;
}

export const novoToken = () => crypto.randomBytes(32).toString('base64url');

export function lerCookie(cabecalho, nome) {
  for (const parte of String(cabecalho || '').split(';')) {
    const [k, ...resto] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(resto.join('='));
  }
  return null;
}

const semPrefixoV4 = (ip) => String(ip || '').replace(/^::ffff:/, '');

/**
 * Endereço de quem fez a requisição. X-Forwarded-For é texto que qualquer
 * cliente escreve: aceito só quando a conexão vem de um proxy declarado em
 * `seguranca.proxies_confiaveis`, e mesmo assim vale a última entrada — a que
 * o próprio proxy acrescentou. Sem isso, trocar o cabeçalho a cada tentativa
 * fura o bloqueio de senha e falsifica a origem na auditoria.
 */
export function origemDaRequisicao(req, proxiesConfiaveis = []) {
  const direto = semPrefixoV4(req.socket?.remoteAddress) || '?';
  const encaminhado = req.headers?.['x-forwarded-for'];
  if (!encaminhado || !proxiesConfiaveis.map(semPrefixoV4).includes(direto)) return direto;
  return semPrefixoV4(String(encaminhado).split(',').at(-1).trim()) || direto;
}

/** Bloqueio progressivo por origem, contra tentativa de adivinhação de senha. */
export class ControleDeTentativas {
  constructor({ tentativas_ate_bloquear = 5, bloqueio_minutos = 15 } = {}) {
    this.limite = tentativas_ate_bloquear;
    this.bloqueioMs = bloqueio_minutos * 60000;
    this.registro = new Map();
  }

  bloqueado(origem) {
    const r = this.registro.get(origem);
    if (!r?.ate) return 0;
    if (Date.now() >= r.ate) { this.registro.delete(origem); return 0; }
    return r.ate - Date.now();
  }

  falhou(origem) {
    const r = this.registro.get(origem) || { falhas: 0, ate: 0 };
    r.falhas += 1;
    if (r.falhas >= this.limite) {
      // dobra a espera a cada bloqueio, com teto de 8 vezes
      const fator = Math.min(2 ** (Math.floor(r.falhas / this.limite) - 1), 8);
      r.ate = Date.now() + this.bloqueioMs * fator;
    }
    this.registro.set(origem, r);
    return r;
  }

  acertou(origem) { this.registro.delete(origem); }

  /** Evita crescer sem limite em caso de varredura de portas. */
  limpar() {
    const agora = Date.now();
    for (const [k, r] of this.registro) if (r.ate && r.ate < agora - this.bloqueioMs) this.registro.delete(k);
  }
}

export class Acesso {
  constructor(banco, config = {}) {
    this.banco = banco;
    this.sessaoMs = (config.sessao_horas ?? 12) * 3600000;
    this.tentativas = new ControleDeTentativas(config);
    // por conta, com o dobro da folga: segura quem tenta de várias máquinas,
    // sem que meia dúzia de erros de um colega trave o login do operador
    this.tentativasPorLogin = new ControleDeTentativas({
      ...config, tentativas_ate_bloquear: (config.tentativas_ate_bloquear ?? 5) * 2,
    });
    this.seguro = !!config.https;
  }

  /** Cria o administrador inicial se o banco estiver vazio. */
  garantirAdmin() {
    if (this.banco.listarUsuarios().length) return null;
    const senha = crypto.randomBytes(9).toString('base64url');
    const { sal, hash } = gerarHash(senha);
    this.banco.criarUsuario({
      login: 'admin', nome: 'Administrador', papel: 'admin',
      hash, sal, trocar_senha: 1, criado_em: Date.now(),
    });
    return senha;   // mostrado uma única vez, no console do servidor
  }

  entrar(login, senha, origem) {
    const conta = `login:${String(login || '').trim().toLowerCase()}`;
    const espera = Math.max(this.tentativas.bloqueado(origem), this.tentativasPorLogin.bloqueado(conta));
    if (espera) return { erro: `muitas tentativas; tente novamente em ${Math.ceil(espera / 60000)} min` };

    const u = this.banco.usuarioPorLogin(String(login || '').trim());
    // confere a senha mesmo sem usuário, para não revelar quais logins existem
    const referencia = u || { sal: 'inexistente', hash: '00'.repeat(32) };
    // o scrypt roda sempre: pular a conta quando o login não existe deixaria a
    // resposta mais rápida justamente para os logins inexistentes
    const ok = conferirSenha(String(senha || ''), referencia.sal, referencia.hash) && !!u;
    if (!ok) {
      this.tentativas.falhou(origem);
      this.tentativasPorLogin.falhou(conta);
      this.banco.registrar('login_negado', `login: ${login}`, null, origem);
      return { erro: 'usuário ou senha inválidos' };
    }

    this.tentativas.acertou(origem);
    this.tentativasPorLogin.acertou(conta);
    const token = novoToken();
    this.banco.criarSessao({
      token, usuario_id: u.id, criada_em: Date.now(),
      expira_em: Date.now() + this.sessaoMs, origem,
    });
    this.banco.atualizarUsuario(u.id, { ultimo_acesso: Date.now() });
    this.banco.registrar('login', null, u.login, origem);
    return { token, usuario: this.publico(u) };
  }

  usuarioDoToken(token) {
    if (!token) return null;
    const s = this.banco.sessao(token);
    if (!s) return null;
    const u = this.banco.usuarioPorId(s.usuario_id);
    return u ? { ...u, token } : null;
  }

  publico(u) {
    return { id: u.id, login: u.login, nome: u.nome, papel: u.papel, trocar_senha: !!u.trocar_senha };
  }

  cookie(token, apagar = false) {
    const partes = [
      `painel_sessao=${apagar ? '' : token}`,
      'Path=/', 'HttpOnly', 'SameSite=Strict',
      apagar ? 'Max-Age=0' : `Max-Age=${Math.floor(this.sessaoMs / 1000)}`,
    ];
    if (this.seguro) partes.push('Secure');
    return partes.join('; ');
  }

  podeNoPapel(papel, minimo) {
    return (PAPEIS[papel] || 0) >= (PAPEIS[minimo] || 99);
  }
}
