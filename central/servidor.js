/**
 * Central de operação — primeira versão.
 *
 * Consulta cada loja pela VPN a cada 5 s (GET /api/central/resumo no
 * supervisório da loja) e mostra todas numa tela só: em comunicação ou não,
 * equipamentos sem resposta, alarmes ativos, e o botão que abre o configurador
 * completo da loja — também pela VPN.
 *
 * Sem dependências: só Node 20+. Escuta APENAS no endereço da VPN
 * (CENTRAL_ESCUTA, padrão 10.88.0.1): mesmo com o firewall errado, a tela
 * nunca fica exposta no IP público da nuvem.
 *
 * Acesso pela internet (web.js / web.sh): o Caddy faz o HTTPS, o oauth2-proxy
 * o login Google, e só então a requisição chega aqui, numa SEGUNDA porta, só
 * em 127.0.0.1 (CENTRAL_PROXY_PORTA). Nessa porta quem está do outro lado é
 * sempre o Caddy, e o e-mail do cabeçalho X-Auth-Request-Email é o do login —
 * conferido de novo contra a lista (acesso/emails.txt), que os administradores
 * mantêm pela tela /acessos. Na porta da VPN não há e-mail: lá o túnel é a
 * identidade, e a tela de acessos fica só para o login web.
 *
 *   CENTRAL_ESCUTA=127.0.0.1 node central/servidor.js     (teste local)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerWeb, hostDaLoja } from './web.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const ESCUTA = process.env.CENTRAL_ESCUTA || '10.88.0.1';
const PORTA = Number(process.env.CENTRAL_PORTA || 8080);
const PORTA_WEB = Number(process.env.CENTRAL_PROXY_PORTA || 0);      // 0 = sem acesso pela internet
const ARQUIVO_LOJAS = process.env.CENTRAL_LOJAS || path.join(raiz, 'lojas.json');
const ARQUIVO_WEB = process.env.CENTRAL_WEB || path.join(raiz, 'web.json');
const DIR_ACESSO = process.env.CENTRAL_ACESSO || path.join(raiz, 'acesso');
const ARQ_EMAILS = path.join(DIR_ACESSO, 'emails.txt');               // lido também pelo oauth2-proxy
const ARQ_ADMINS = path.join(DIR_ACESSO, 'administradores.txt');
const ARQ_REGISTRO = path.join(DIR_ACESSO, 'registro.log');
const web = lerWeb(ARQUIVO_WEB);
const INTERVALO_MS = 5000;
const PRAZO_MS = 4000;
// dado mais velho que isso na loja = o supervisório responde, mas a coleta parou
const DADO_VELHO_MS = 30000;

/** id da loja → { ok, erro, contato, consultado, dados } */
const estado = new Map();

function lerLojas() {
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO_LOJAS, 'utf8'));
    return (bruto.lojas || []).filter((l) => l && l.id && l.ip);
  } catch {
    return [];
  }
}

async function consultar(loja) {
  const url = `http://${loja.ip}:${loja.porta || 8080}/api/central/resumo`;
  const anterior = estado.get(loja.id) || {};
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS) });
    if (r.status === 403) throw new Error('a loja não reconhece esta central (central.ip na configuração da loja)');
    if (!r.ok) throw new Error(`a loja respondeu HTTP ${r.status}`);
    const dados = await r.json();
    estado.set(loja.id, { ok: true, erro: null, contato: Date.now(), consultado: Date.now(), dados, semContatoDesde: null });
  } catch (e) {
    const erro = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'sem resposta (loja desligada ou sem internet)'
      : /ECONNREFUSED/.test(String(e.cause?.code || e.message)) ? 'VPN ok, mas o supervisório da loja não está no ar'
        : e.message;
    // desde quando está sem contato: primeira falha depois da última resposta boa
    const semContatoDesde = anterior.ok === false && anterior.semContatoDesde ? anterior.semContatoDesde : Date.now();
    estado.set(loja.id, { ...anterior, ok: false, erro, consultado: Date.now(), semContatoDesde });
  }
}

let rodando = false;
async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    await Promise.all(lerLojas().map(consultar));
  } finally {
    rodando = false;
  }
}

/* ---------------------------------------------------------------- acessos */

/** Uma linha por e-mail, minúsculo e sem repetição. Arquivo ausente = lista vazia. */
export function lerLista(arq) {
  try {
    const linhas = fs.readFileSync(arq, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase());
    return [...new Set(linhas.filter((s) => s && !s.startsWith('#')))];
  } catch {
    return [];
  }
}

const gravarLista = (arq, lista) => fs.writeFileSync(arq, lista.length ? `${lista.join('\n')}\n` : '', { mode: 0o640 });
export const emailValido = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[a-z]{2,}$/i.test(e.trim());

/** Quem está pedindo. Na porta web, o e-mail do login; na da VPN, o próprio túnel. */
function quem(req, viaWeb) {
  if (!viaWeb) return { email: null, autorizado: true, admin: false };
  const email = String(req.headers['x-auth-request-email'] || '').trim().toLowerCase();
  // o oauth2-proxy já barrou quem não está na lista; conferir de novo aqui faz a
  // remoção valer na hora, mesmo antes de ele reler o arquivo
  const autorizado = !!email && lerLista(ARQ_EMAILS).includes(email);
  return { email: email || null, autorizado, admin: autorizado && lerLista(ARQ_ADMINS).includes(email) };
}

/**
 * Inclui, altera ou remove um acesso. Devolve { erro } ou { usuarios }.
 * Ninguém tira o próprio acesso nem o próprio papel de administrador: assim
 * sempre sobra pelo menos um administrador (quem fez a alteração).
 */
export function alterarAcesso(eu, acao, { email, admin } = {}) {
  if (!eu.admin) return { erro: 'só um administrador altera os acessos', status: 403 };
  const alvo = String(email || '').trim().toLowerCase();
  if (!emailValido(alvo)) return { erro: 'e-mail inválido', status: 400 };
  let emails = lerLista(ARQ_EMAILS);
  let admins = lerLista(ARQ_ADMINS);
  if (acao === 'remover') {
    if (alvo === eu.email) return { erro: 'você não pode remover o próprio acesso', status: 400 };
    if (!emails.includes(alvo)) return { erro: 'e-mail não cadastrado', status: 404 };
    // primeiro tira o papel, depois o acesso: no meio do caminho nunca sobra um admin sem acesso
    gravarLista(ARQ_ADMINS, admins.filter((x) => x !== alvo));
    gravarLista(ARQ_EMAILS, emails.filter((x) => x !== alvo));
  } else {
    if (alvo === eu.email && !admin) return { erro: 'você não pode tirar o próprio papel de administrador', status: 400 };
    if (!emails.includes(alvo)) emails = [...emails, alvo];
    admins = admin ? [...new Set([...admins, alvo])] : admins.filter((x) => x !== alvo);
    gravarLista(ARQ_EMAILS, emails);
    gravarLista(ARQ_ADMINS, admins);
  }
  const linha = `${new Date().toISOString()}  ${eu.email}  ${acao === 'remover' ? 'removeu' : admin ? 'liberou (administrador)' : 'liberou'}  ${alvo}\n`;
  try { fs.appendFileSync(ARQ_REGISTRO, linha, { mode: 0o640 }); } catch { /* o registro não impede a alteração */ }
  return { usuarios: listaDeAcessos() };
}

function listaDeAcessos() {
  const admins = lerLista(ARQ_ADMINS);
  return lerLista(ARQ_EMAILS).map((email) => ({ email, admin: admins.includes(email) }));
}

function lerCorpo(req, limite = 4096) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (p) => {
      corpo += p;
      if (corpo.length > limite) { reject(new Error('grande demais')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(corpo || '{}')); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ lojas */

function situacao(loja, viaWeb = false) {
  const e = estado.get(loja.id);
  const agora = Date.now();
  const d = e?.dados || null;
  let status = 'aguardando';
  if (e && !e.ok) status = 'sem_contato';
  else if (e?.ok && d && agora - d.ts > DADO_VELHO_MS) status = 'dados_parados';
  else if (e?.ok && d && (d.equipamentos === 0 || d.online < d.equipamentos)) status = 'falha_equipamento';
  else if (e?.ok && d && d.alarmes.length) status = 'alarme';
  else if (e?.ok) status = 'normal';
  return {
    id: loja.id,
    nome: loja.nome || loja.id,
    // quem entrou pela internet abre a loja pelo endereço dela; quem está na VPN, direto
    painel: viaWeb && web ? `https://${hostDaLoja(loja.id, web.base)}/` : `http://${loja.ip}:${loja.porta || 8080}/`,
    status,
    erro: e?.erro || null,
    contato: e?.contato || null,
    sem_contato_desde: e?.ok === false ? e.semContatoDesde : null,
    dados: d,
  };
}

const PAGINAS = {
  '/': 'index.html', '/index.html': 'index.html',
  '/alarmes': 'alarmes.html', '/alarmes.html': 'alarmes.html',
  '/acessos': 'acessos.html', '/acessos.html': 'acessos.html',
};
const PUBLICAS = { '/sobre': 'sobre.html', '/privacidade': 'privacidade.html' };
const pagina = (nome) => fs.readFileSync(path.join(raiz, 'publico', nome));

const CABECALHOS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(res, status, corpo) {
  res.writeHead(status, { ...CABECALHOS, 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify(corpo));
}

const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Logado no Google, mas fora da lista (ou removido agora há pouco). */
function semAcesso(res, email) {
  res.writeHead(403, { ...CABECALHOS, 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sem acesso</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px">
<h1 style="font-size:20px">Acesso não liberado</h1>
<p>A conta <b>${escapar(email || '(sem e-mail)')}</b> não está na lista de acessos da central.
Peça a um administrador para incluir este e-mail, exatamente como ele aparece aqui.</p>
<p><a href="/oauth2/sign_out?rd=%2F">Entrar com outra conta</a></p></body>`);
}

function atender(viaWeb) {
  return async (req, res) => {
    const caminho = req.url.split('?')[0];
    if (caminho === '/icone.png' || caminho === '/favicon.ico') {
      const icone = path.join(raiz, 'publico', 'icone.png');
      if (!fs.existsSync(icone)) { res.writeHead(404, CABECALHOS); return res.end(); }
      res.writeHead(200, { ...CABECALHOS, 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(icone));
    }
    // apresentação e política de privacidade: abertas, sem login (o Google
    // exige as duas públicas para liberar o login fora do modo de teste)
    if (PUBLICAS[caminho] && req.method === 'GET') {
      res.writeHead(200, { ...CABECALHOS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=3600' });
      return res.end(pagina(PUBLICAS[caminho]));
    }
    const eu = quem(req, viaWeb);
    if (!eu.autorizado) {
      return caminho.startsWith('/api/') ? json(res, 403, { erro: 'acesso não liberado' }) : semAcesso(res, eu.email);
    }

    if (req.method === 'POST' && (caminho === '/api/acesso' || caminho === '/api/acesso/remover')) {
      // cabeçalho próprio: um formulário de outro site não consegue mandá-lo
      if (req.headers['x-central'] !== '1') return json(res, 400, { erro: 'requisição sem o cabeçalho de origem' });
      let corpo;
      try { corpo = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: e.message }); }
      const r = alterarAcesso(eu, caminho.endsWith('/remover') ? 'remover' : 'liberar', corpo);
      return r.erro ? json(res, r.status, { erro: r.erro }) : json(res, 200, r);
    }
    if (req.method !== 'GET') { res.writeHead(405, CABECALHOS); return res.end(); }

    if (PAGINAS[caminho]) {
      res.writeHead(200, { ...CABECALHOS, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pagina(PAGINAS[caminho]));
    }
    if (caminho === '/api/lojas') {
      return json(res, 200, { agora: Date.now(), lojas: lerLojas().map((l) => situacao(l, viaWeb)) });
    }
    if (caminho === '/api/eu') {
      return json(res, 200, { email: eu.email, admin: eu.admin, web: viaWeb });
    }
    if (caminho === '/api/acesso') {
      if (!eu.admin) return json(res, 403, { erro: 'só um administrador vê os acessos' });
      return json(res, 200, { usuarios: listaDeAcessos() });
    }
    res.writeHead(404, CABECALHOS);
    return res.end();
  };
}

function abrir(porta, endereco, viaWeb) {
  const s = http.createServer(atender(viaWeb));
  s.listen(porta, endereco, () => console.log(`Central em http://${endereco}:${porta}${viaWeb ? ' (acesso pela internet, atrás do login)' : ''}`));
  s.on('error', (e) => {
    console.error(`não abriu ${endereco}:${porta}: ${e.message}`);
    if (e.code === 'EADDRNOTAVAIL') console.error('a VPN (wg0) está no ar? sudo systemctl status wg-quick@wg0');
    process.exit(1);
  });
  return s;
}

// importado pelos testes, não sobe nada
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const servidores = [abrir(PORTA, ESCUTA, false)];
  // só 127.0.0.1: quem chega aqui passou pelo Caddy e pelo login
  if (PORTA_WEB && web) servidores.push(abrir(PORTA_WEB, '127.0.0.1', true));
  console.log(`${lerLojas().length} loja(s) em ${ARQUIVO_LOJAS}${web ? ` · endereço web: https://central.${web.base}` : ''}`);
  ciclo();
  setInterval(ciclo, INTERVALO_MS);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => Promise.all(servidores.map((x) => new Promise((r) => x.close(r)))).then(() => process.exit(0)));
}

export { atender };
