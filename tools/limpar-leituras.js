/**
 * Apaga do histórico as leituras que se sabe que vieram erradas do medidor.
 *
 *   node tools/limpar-leituras.js --config config.planta.json             só mostra o que apagaria
 *   node tools/limpar-leituras.js --config config.planta.json --aplicar   apaga
 *
 * Duas limpezas:
 *   1. valores fisicamente impossíveis — fora da `faixa_fisica` da tag (float
 *      montado com metades de grandezas diferentes dá 1e36 kW). Qualquer data.
 *   2. contadores de energia dos medidores 7KT0310 gravados até `--ate`
 *      (padrão: agora). Lidos na ordem de palavras errada, andavam em degraus de
 *      1024 kWh. Junto saem as horas de consumo já consolidadas desses
 *      medidores: a tela de Consumo recalcula essas horas pela potência média
 *      (marcadas como "estimado pela potência"), que estava quase certa.
 *   Outros equipamentos: --equipamentos geral,padaria (padrão: perfil 7kt0310*).
 *
 * Pode rodar com o serviço no ar. Fica registrado na auditoria.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Banco, prepararAcesso } from '../src/db.js';
import { prepararConfig } from '../src/perfis.js';
import { prepararTag } from '../src/mapa.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opcao = (nome) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
const aplicar = args.includes('--aplicar');
const arqConfig = path.resolve(raiz, opcao('--config') || 'config.json');
const ateTxt = opcao('--ate');
const ate = ateTxt ? new Date(ateTxt.replace(' ', 'T')).getTime() : Date.now();
if (!Number.isFinite(ate)) { console.error(`--ate inválido: ${ateTxt} (use "AAAA-MM-DD HH:MM")`); process.exit(1); }

const bruta = JSON.parse(fs.readFileSync(arqConfig, 'utf8'));
const { config } = prepararConfig(bruta, path.join(raiz, 'perfis'));
const banco = new Banco(path.join(raiz, config.historico.arquivo));
banco.db.pragma('busy_timeout = 10000');     // o serviço pode estar gravando
prepararAcesso(banco.db);                     // tabela de auditoria

const escolhidos = opcao('--equipamentos')?.split(',').map((s) => s.trim()).filter(Boolean);
const alvoContador = (m) => (escolhidos ? escolhidos.includes(m.id) : /^7kt0310/.test(m.perfil || ''));

const conta = (sql, ...p) => banco.db.prepare(sql.replace(/^DELETE/, 'SELECT COUNT(*) n')).get(...p).n;
const tarefas = [];
for (const m of config.medidores) {
  for (const t of m.tags || []) {
    if (t.calculada) continue;
    const { faixa } = prepararTag(t, m.padrao || {});
    if (faixa) {
      tarefas.push({
        oque: `${m.id}.${t.nome} fora de ${faixa[0]}…${faixa[1]}`,
        sql: 'DELETE FROM amostras WHERE tag = ? AND (valor < ? OR valor > ?)',
        p: [`${m.id}.${t.nome}`, faixa[0], faixa[1]],
      });
    }
    if (t.acumulador && alvoContador(m)) {
      tarefas.push({
        oque: `${m.id}.${t.nome} (contador) até ${new Date(ate).toLocaleString('pt-BR')}`,
        sql: 'DELETE FROM amostras WHERE tag = ? AND ts <= ?',
        p: [`${m.id}.${t.nome}`, ate],
      });
    }
  }
  if (alvoContador(m) && (m.tags || []).some((t) => t.acumulador)) {
    tarefas.push({
      oque: `${m.id}: horas de consumo consolidadas até ${new Date(ate).toLocaleString('pt-BR')}`,
      sql: 'DELETE FROM consumo_horario WHERE medidor = ? AND hora < ?',
      p: [m.id, ate],
    });
  }
}

let total = 0;
for (const t of tarefas) {
  t.n = conta(t.sql, ...t.p);
  total += t.n;
  if (t.n) console.log(`${String(t.n).padStart(8)}  ${t.oque}`);
}
if (!total) { console.log('nada a apagar'); process.exit(0); }

if (!aplicar) {
  console.log(`\n${total} linhas seriam apagadas. Para apagar de fato, repita com --aplicar`);
  process.exit(0);
}
banco.db.transaction(() => { for (const t of tarefas) if (t.n) banco.db.prepare(t.sql).run(...t.p); })();
banco.registrar('historico_limpo', `${total} linhas: valores fora da faixa física e contadores 7KT0310 até ${new Date(ate).toISOString()}`, null, 'servidor');
banco.db.close();
console.log(`\n${total} linhas apagadas. A tela de Consumo recalcula as horas pela potência.`);
