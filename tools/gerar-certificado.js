/**
 * Gera um certificado autoassinado para servir o painel em HTTPS na rede da loja.
 *
 *   node tools/gerar-certificado.js                     endereços desta máquina
 *   node tools/gerar-certificado.js 192.168.8.109 painel.local
 *
 * Sem openssl e sem dependência: a máquina do painel costuma ser um Windows de
 * fábrica, sem nada instalado além do Node. O certificado (ECDSA P-256) sai
 * montado aqui mesmo, campo a campo, e assinado com node:crypto.
 *
 * Grava em dados/tls/ — fora do controle de versão e dentro do que o serviço
 * pode escrever. Depois, na configuração:
 *   "seguranca": { "tls": { "certificado": "dados/tls/painel.crt", "chave": "dados/tls/painel.key" } }
 *
 * Autoassinado quer dizer que o navegador avisa na primeira vez. Para sumir com
 * o aviso, importe o painel.crt como autoridade confiável nos postos da loja.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAS_VALIDADE = 825;

/* ------------------------------------------------------------- DER mínimo */

function comprimento(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...partes) => {
  const corpo = Buffer.concat(partes);
  return Buffer.concat([Buffer.from([tag]), comprimento(corpo.length), corpo]);
};
const sequencia = (...p) => tlv(0x30, ...p);
const conjunto = (...p) => tlv(0x31, ...p);
const explicito = (n, ...p) => tlv(0xa0 + n, ...p);

function oid(texto) {
  const [a, b, ...resto] = texto.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of resto) {
    const grupo = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) grupo.unshift(0x80 | (v & 0x7f));
    bytes.push(...grupo);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function inteiroPositivo(buf) {
  // bit mais alto ligado seria lido como negativo: prefixa zero
  return tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
}

/** UTCTime até 2049, GeneralizedTime depois — é o que a RFC 5280 manda. */
function tempo(data) {
  const iso = data.toISOString().replace(/[-:T]/g, '').slice(0, 14);   // AAAAMMDDhhmmss
  return data.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${iso}Z`));
}

const nome = (cn) => sequencia(conjunto(sequencia(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

function bytesDoIp(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  // IPv6: expande o "::" e grava os 8 grupos de 16 bits
  const [esq, dir = ''] = ip.split('::');
  const a = esq ? esq.split(':') : [];
  const b = dir ? dir.split(':') : [];
  const grupos = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return Buffer.concat(grupos.map((g) => { const x = Buffer.alloc(2); x.writeUInt16BE(parseInt(g, 16)); return x; }));
}

/* ----------------------------------------------------------- certificado */

export function gerarCertificado(nomes, { dias = DIAS_VALIDADE, agora = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algoritmo = sequencia(oid('1.2.840.10045.4.3.2'));            // ecdsa-with-SHA256

  const alternativos = nomes.map((n) => (net.isIP(n)
    ? tlv(0x87, bytesDoIp(n))                                         // [7] iPAddress
    : tlv(0x82, Buffer.from(n, 'ascii'))));                           // [2] dNSName
  const extensao = (id, valor, critica = false) => sequencia(
    oid(id), ...(critica ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, valor),
  );

  const titular = nome(`Supervisório ${nomes.find((n) => !net.isIP(n)) || nomes[0]}`);
  const inicio = new Date(agora.getTime() - 3600000);                // folga para relógio adiantado
  const fim = new Date(agora.getTime() + dias * 86400000);
  const serie = crypto.randomBytes(16);
  serie[0] &= 0x7f;

  const tbs = sequencia(
    explicito(0, tlv(0x02, Buffer.from([2]))),                        // v3
    inteiroPositivo(serie),
    algoritmo,
    titular,
    sequencia(tempo(inicio), tempo(fim)),
    titular,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicito(3, sequencia(
      extensao('2.5.29.19', sequencia(), true),                       // basicConstraints: não é AC
      extensao('2.5.29.15', tlv(0x03, Buffer.from([0x07, 0x80])), true), // keyUsage: digitalSignature
      extensao('2.5.29.37', sequencia(oid('1.3.6.1.5.5.7.3.1'))),     // uso: servidor TLS
      extensao('2.5.29.17', sequencia(...alternativos)),              // nomes e IPs aceitos
    )),
  );

  const assinatura = crypto.sign('sha256', tbs, privateKey);          // DER, como o X.509 pede
  const der = sequencia(tbs, algoritmo, tlv(0x03, Buffer.from([0]), assinatura));
  const pem = (rotulo, b) => `-----BEGIN ${rotulo}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${rotulo}-----\n`;
  return {
    certificado: pem('CERTIFICATE', der),
    chave: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Endereços IPv4 e nome desta máquina, mais localhost. */
function nomesDestaMaquina() {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return [os.hostname(), 'localhost', '127.0.0.1', ...ips];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pedidos = process.argv.slice(2);
  const nomes = [...new Set([...(pedidos.length ? pedidos : nomesDestaMaquina()), 'localhost', '127.0.0.1'])];
  for (const n of nomes) {
    if (!net.isIP(n) && !/^[A-Za-z0-9*]([A-Za-z0-9.-]{0,252})$/.test(n)) {
      console.error(`nome inválido para certificado: ${n}`);
      process.exit(1);
    }
  }

  const { certificado, chave } = gerarCertificado(nomes);
  const pasta = path.join(raiz, 'dados', 'tls');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, 'painel.crt'), certificado);
  fs.writeFileSync(path.join(pasta, 'painel.key'), chave, { mode: 0o600 });

  const x = new crypto.X509Certificate(certificado);
  console.log('Certificado gerado em dados/tls/');
  console.log(`  válido até   ${new Date(x.validTo).toLocaleDateString('pt-BR')}`);
  console.log(`  atende       ${x.subjectAltName}`);
  console.log(`  impressão    ${x.fingerprint256}`);
  console.log('\nNa configuração, dentro de "seguranca":');
  console.log('  "tls": { "certificado": "dados/tls/painel.crt", "chave": "dados/tls/painel.key" }');
}
