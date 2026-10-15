/**
 * Rastreia um alarme de faixa: cada vez que abriu, o que o histórico gravou
 * naquele intervalo — para separar falha real de leitura estranha ou de regra
 * mal calibrada (ex.: "sem consumo" num setor que desliga o compressor em ciclo).
 *
 *   node tools/rastrear-alarme.js --config config.planta.json --tag frios.potencia_ativa
 *   node tools/rastrear-alarme.js --config config.planta.json --tag frios.potencia_ativa --dias 3
 *
 * Só leitura: não altera nada no banco. Pode rodar com o serviço no ar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const op = (n, p) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : p; };
const tag = op('tag');
const dias = Number(op('dias', 2));
if (!tag || !tag.includes('.')) { console.error('informe --tag equipamento.grandeza (ex.: frios.potencia_ativa)'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(path.resolve(raiz, op('config', 'config.json')), 'utf8'));
const db = new Database(path.join(raiz, config.historico.arquivo), { readonly: true, fileMustExist: true });
const [eq] = tag.split('.');
const agora = Date.now();
const de = agora - dias * 86400000;
const hora = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const n = (v, c = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(c));
const amostras = (t, a, b) => db.prepare('SELECT ts, valor FROM amostras WHERE tag = ? AND ts BETWEEN ? AND ? ORDER BY ts').all(t, a, b);

const regra = (config.alarmes || []).find((r) => r.tag === tag);
console.log(`\n${tag} — últimos ${dias} dia(s)`);
if (regra) console.log(`regra: ${regra.min !== undefined ? `mín ${regra.min}` : ''}${regra.max !== undefined ? ` máx ${regra.max}` : ''} por ${regra.atraso_s || 0} s — "${regra.mensagem}"`);

// distribuição do período: quanto tempo abaixo de cada patamar
const todas = amostras(tag, de, agora);
if (!todas.length) { console.log('nenhuma amostra gravada no período'); process.exit(0); }
const vals = todas.map((a) => a.valor).sort((a, b) => a - b);
const pct = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
const abaixo = (lim) => ((vals.filter((v) => v < lim).length / vals.length) * 100).toFixed(1);
console.log(`\n${todas.length} amostras · mín ${n(vals[0])} · 5% ${n(pct(0.05))} · mediana ${n(pct(0.5))} · máx ${n(vals[vals.length - 1])}`);
console.log(`tempo abaixo de 0,1: ${abaixo(0.1)} %  · abaixo de 0,5: ${abaixo(0.5)} %  · abaixo de 1: ${abaixo(1)} %  · igual a 0: ${((vals.filter((v) => v === 0).length / vals.length) * 100).toFixed(1)} %`);

// buracos no histórico (equipamento sem comunicação não grava)
let buracos = 0; let maior = 0;
for (let i = 1; i < todas.length; i++) {
  const g = todas[i].ts - todas[i - 1].ts;
  if (g > 60000) { buracos++; maior = Math.max(maior, g); }
}
console.log(`interrupções de gravação (> 1 min): ${buracos}${buracos ? ` · a maior: ${Math.round(maior / 60000)} min` : ''}`);

// cada abertura do alarme, com o que foi gravado em volta
const alarmes = db.prepare('SELECT * FROM alarmes WHERE tag = ? AND inicio >= ? ORDER BY inicio').all(tag, de);
console.log(`\n${alarmes.length} abertura(s) do alarme no período`);
const fases = ['corrente_a', 'corrente_b', 'corrente_c'];
for (const a of alarmes.slice(-15)) {
  const fim = a.fim || agora;
  const dur = Math.round((fim - a.inicio) / 1000);
  console.log(`\n▶ ${hora(a.inicio)} → ${a.fim ? hora(a.fim) : 'ATIVO'}  (${dur >= 120 ? `${Math.round(dur / 60)} min` : `${dur} s`})  valor ao abrir: ${n(a.valor)}`);
  const janela = amostras(tag, a.inicio - 3 * 60000, fim + 2 * 60000);
  console.log(`   ${tag.split('.')[1]} de 3 min antes a 2 min depois (amostra a cada ~15 s):`);
  console.log(`   ${janela.map((x) => n(x.valor, 1)).join(' ') || '(nenhuma amostra — sem comunicação?)'}`);
  const linhaFases = fases.map((f) => {
    // só enquanto o alarme esteve aberto (a leitura do fechamento já é a recuperada)
    const s = amostras(`${eq}.${f}`, a.inicio, fim - 1);
    if (!s.length) return `${f.slice(-1).toUpperCase()}: —`;
    return `I${'abc'.indexOf(f.slice(-1)) + 1}: ${n(Math.min(...s.map((x) => x.valor)), 1)}–${n(Math.max(...s.map((x) => x.valor)), 1)} A`;
  }).join('   ');
  console.log(`   correntes durante o alarme: ${linhaFases}`);
}
if (alarmes.length > 15) console.log(`\n(mostrando as 15 últimas de ${alarmes.length})`);
db.close();
