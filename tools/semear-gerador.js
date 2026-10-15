/**
 * Semeia histórico do grupo gerador para demonstração e para conferir a tela de
 * indicadores sem esperar semanas de operação.
 *
 *   node tools/semear-gerador.js [--config config.gerador.json] [--semanas 12]
 *
 * Gera corridas plausíveis (teste semanal + quedas de rede), com a bateria se
 * degradando aos poucos, e as amostras de prontidão do período. Recusa rodar
 * sobre um banco que já tenha histórico de verdade — isto é ferramenta de
 * apresentação, não de campo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Banco } from '../src/db.js';
import { prepararConfig } from '../src/perfis.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const arquivoConfig = path.join(raiz, arg('config', 'config.gerador.json'));
const semanas = Number(arg('semanas', 12));
const { config } = prepararConfig(JSON.parse(fs.readFileSync(arquivoConfig, 'utf8')),
  path.join(raiz, 'perfis'));

const g = config.gerador;
if (!g?.medidor) {
  console.error(`${path.basename(arquivoConfig)} não tem seção "gerador".`);
  process.exit(1);
}

const banco = new Banco(path.join(raiz, config.historico.arquivo));
if (banco.corridas(g.medidor, 0, 1).length && !process.argv.includes('--forcar')) {
  console.error('Este banco já tem corridas registradas. Use --forcar para semear mesmo assim.');
  process.exit(1);
}

const DIA = 86400000;
const agora = Date.now();
const nominal = g.potencia_nominal_kw || 180;
const tanque = g.capacidade_tanque_litros || 500;
const consumo = g.consumo_litros_hora || 38;
const ruido = (a) => (Math.random() - 0.5) * a;

let corridas = 0;
let amostras = 0;

for (let s = semanas; s >= 1; s--) {
  // teste semanal, sempre no mesmo dia e horário
  const eventos = [{ ts: agora - s * 7 * DIA, motivo: 'teste', minutos: 30 }];
  // uma queda de rede a cada três semanas, em horário aleatório
  if (s % 3 === 0) {
    eventos.push({
      ts: agora - s * 7 * DIA + 2 * DIA + Math.random() * DIA,
      motivo: 'queda de rede',
      minutos: 25 + Math.random() * 90,
    });
  }

  for (const e of eventos) {
    // a bateria envelhece: a mínima do arranque cai devagar ao longo das semanas
    const repouso = 26.9 + ruido(0.2);
    const minima = 21.6 - (semanas - s) * 0.16 + ruido(0.3);
    const falhou = minima < 18.6;                  // bateria fraca demais para o arranque
    const duracao = falhou ? 35 : e.minutos * 60;
    const horas = duracao / 3600;
    const kwh = falhou ? 0 : horas * nominal * (0.5 + Math.random() * 0.25);
    const litros = falhou ? 0 : horas * consumo * (0.85 + Math.random() * 0.2);
    const nivelInicial = 92 - ((semanas - s) * 0.7);

    const id = banco.abrirCorrida({
      medidor: g.medidor,
      inicio: e.ts,
      motivo: e.motivo,
      resultado: 'em andamento',
      bateria_repouso: repouso,
      nivel_inicial: nivelInicial,
    });
    banco.atualizarCorrida(id, {
      fim: e.ts + duracao * 1000,
      resultado: falhou ? 'falha de partida (bateria)' : 'normal',
      bateria_minima: minima,
      tempo_partida_s: falhou ? null : 8 + Math.random() * 4,
      duracao_s: duracao,
      kwh,
      litros,
      pico_kw: falhou ? 0 : nominal * (0.6 + Math.random() * 0.25),
      nivel_final: nivelInicial - (litros / tanque) * 100,
    });
    corridas += 1;
  }
}

/* Prontidão: uma amostra por hora nas últimas semanas. O grupo fica indisponível
   nas horas que antecedem cada falha de partida — é assim que a prontidão de
   verdade se comporta, e é o que a tela precisa mostrar. */
const inicio = agora - semanas * 7 * DIA;
const indisponiveis = banco.corridas(g.medidor, inicio, 500)
  .filter((c) => /falha/.test(c.resultado || ''))
  .map((c) => c.inicio);
const lote = [];
for (let ts = inicio; ts <= agora; ts += 3600000) {
  const ruim = indisponiveis.some((t) => ts > t - 6 * 3600000 && ts < t + 2 * 3600000);
  lote.push([ts, ruim ? 0 : 1]);
}
const gravar = banco.db.transaction((pares) => {
  for (const [ts, v] of pares) banco.inserir.run(ts, `${g.medidor}.pronto`, v);
});
gravar(lote);
amostras = lote.length;

console.log(`${corridas} corridas e ${amostras} amostras de prontidão gravadas em ${config.historico.arquivo}`);
console.log(`Suba com: node server.js --config ${path.basename(arquivoConfig)} --sem-modbus`);
