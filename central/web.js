/**
 * Acesso pela internet, sem VPN no aparelho do operador.
 *
 *   operador ─HTTPS─► Caddy :443 ─► oauth2-proxy (login Google, só e-mails da lista)
 *                                      ├─► central (127.0.0.1:8081)
 *                                      └─► loja-<id>: painel da loja, pela VPN
 *
 * O nome vem do sslip.io (o IP público escrito no nome: 146-235-41-191.sslip.io
 * aponta para 146.235.41.191), então não precisa de domínio próprio. Cada loja
 * ganha o seu endereço — o painel da loja usa caminhos absolutos (/api, /ws) e
 * não funcionaria embaixo de uma pasta da central.
 *
 * Este módulo dá os nomes (usado pela central para montar o link "Abrir configurador")
 * e, rodado direto, escreve o Caddyfile a partir do cadastro de lojas:
 *
 *   node /opt/central/web.js [/opt/central/web.json] [/opt/central/lojas.json] > /etc/caddy/Caddyfile
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OAUTH = '127.0.0.1:4180';
export const CENTRAL_LOCAL = '127.0.0.1:8081';

/** "146.235.41.191" → "146-235-41-191.sslip.io" (com traço o certificado sai sem problema) */
export function baseDoIp(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || '').trim())) throw new Error(`IP público inválido: ${ip}`);
  return `${String(ip).trim().replace(/\./g, '-')}.sslip.io`;
}

/** Endereço da loja. "_" não vale em nome de máquina: vira "-". */
export const hostDaLoja = (id, base) => `loja-${String(id).toLowerCase().replace(/_/g, '-')}.${base}`;
export const hostDaCentral = (base) => `central.${base}`;

/** Páginas da central abertas sem login: apresentação e política de privacidade (exigidas pelo Google). */
export const PUBLICAS = ['/sobre', '/privacidade', '/icone.png'];

/** Quem só acessa depois do login: o mesmo bloco para a central e para cada loja. */
function site(host, destino, { bloquear = [], publicas = [] } = {}) {
  return `${host} {
	# o e-mail de quem entrou só pode vir do oauth2-proxy, nunca do navegador
	request_header -X-Auth-Request-Email
	request_header -X-Auth-Request-User
${bloquear.map((c) => `	handle ${c} {\n		respond 404\n	}\n`).join('')}${
  publicas.map((c) => `	handle ${c} {\n		reverse_proxy ${destino}\n	}\n`).join('')}	handle /oauth2/* {
		reverse_proxy ${OAUTH} {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-Uri {uri}
		}
	}
	handle {
		forward_auth ${OAUTH} {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}
			copy_headers X-Auth-Request-Email
			@sem_login status 401
			handle_response @sem_login {
				redir * /oauth2/sign_in?rd={scheme}://{host}{uri}
			}
		}
		reverse_proxy ${destino}
	}
}
`;
}

export function caddyfile({ base }, lojas = []) {
  const partes = [
    '# Gerado por /opt/central/web.js a partir de web.json e lojas.json — não edite à mão:',
    '# cada "vpn-novo.sh loja" e "montar-vm.sh" escrevem este arquivo de novo.',
    '',
    site(hostDaCentral(base), CENTRAL_LOCAL, { publicas: PUBLICAS }),
  ];
  for (const l of lojas) {
    // o resumo das lojas é só da central (pela VPN): pela internet não existe
    partes.push(site(hostDaLoja(l.id, base), `${l.ip}:${l.porta || 8080}`, { bloquear: ['/api/central/*'] }));
  }
  return partes.join('\n');
}

/** web.json da central: { "base": "146-235-41-191.sslip.io" } — ou null sem acesso web. */
export function lerWeb(arquivo) {
  try {
    const w = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    return w?.base ? w : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raiz = path.dirname(fileURLToPath(import.meta.url));
  const web = lerWeb(process.argv[2] || path.join(raiz, 'web.json'));
  if (!web) { console.error('web.json sem "base": rode central/web.sh'); process.exit(1); }
  const arqLojas = process.argv[3] || path.join(raiz, 'lojas.json');
  const lojas = fs.existsSync(arqLojas) ? (JSON.parse(fs.readFileSync(arqLojas, 'utf8')).lojas || []) : [];
  process.stdout.write(caddyfile(web, lojas.filter((l) => l?.id && l?.ip)));
}
