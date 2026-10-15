/* Estima o tempo de varredura na RS-485: node tools/orcamento.js */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { montarBlocos } from '../src/mapa.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(raiz, 'config.json'), 'utf8'));

const blocos = Object.fromEntries(cfg.medidores.map((m) => [m.id, montarBlocos(m.tags, m.padrao)]));

console.log('Requisições por equipamento');
for (const m of cfg.medidores) {
  const b = blocos[m.id];
  const r = b.filter((x) => !x.lento).length;
  const l = b.length - r;
  console.log(`  ${m.id.padEnd(13)} ID ${String(m.conexao.unit_id).padStart(2)}  ${r} rápidas + ${l} lentas`
    + `  rodízio 1/${m.varredura_a_cada || 1}  ${b.map((x) => `${x.inicio}..${x.fim - 1}${x.lento ? 'L' : ''}`).join(' ')}`);
}

for (const [baud, resposta] of [[9600, 100], [9600, 30], [19200, 30]]) {
  const ms = (bytes) => (bytes * 11 * 1000) / baud;
  const custo = (b) => ms(8) + resposta + ms(5 + (b.fim - b.inicio) * 2) + 4;
  let total = 0;
  for (const m of cfg.medidores) {
    const n = m.varredura_a_cada || 1;
    total += blocos[m.id].filter((b) => !b.lento).reduce((s, b) => s + custo(b), 0) / n;
  }
  console.log(`\n${baud} bps · resposta ${resposta} ms → varredura média ${Math.round(total)} ms`
    + ` (intervalo configurado: ${cfg.intervalo_leitura_ms} ms)`);
}

const atualizacao = (m) => (m.varredura_a_cada || 1) * cfg.intervalo_leitura_ms / 1000;
console.log('\nAtualização de cada equipamento');
for (const m of cfg.medidores) console.log(`  ${m.nome.padEnd(24)} ${atualizacao(m).toFixed(1)} s`);
