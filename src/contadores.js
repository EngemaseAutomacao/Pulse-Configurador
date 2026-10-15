/**
 * Filtro dos contadores de energia (tags com "acumulador": true).
 *
 * O 7KT0310 às vezes devolve o float32 da energia com as duas metades de
 * momentos diferentes: o contador "pula" um múltiplo do bit que fica na
 * fronteira dos dois registradores (256 kWh quando o contador está na casa dos
 * 36 000 kWh) e volta na leitura seguinte. Gravado como veio, esse salto vira
 * uma barra de centenas de kWh na tela de Consumo.
 *
 * Mesma regra que o fluxo do Node-RED da planta já usa com sucesso:
 *   1. a leitura vale se, desde a última aceita, o contador não desceu e não
 *      subiu mais rápido que a taxa máxima (kWh por hora = demanda máxima);
 *   2. uma leitura recusada vira candidata; se a seguinte concordar com ela,
 *      as duas vencem a referência antiga (troca de medidor, contador zerado,
 *      ou a própria referência é que veio corrompida).
 * Enquanto uma leitura é recusada a tag mantém o último valor aceito.
 * A primeira leitura depois da partida é aceita direto: esperar a confirmação
 * deixaria a energia sem valor por até 40 s, e se ela vier corrompida a regra 2
 * corrige na leitura lenta seguinte.
 */

/** Folga para o arredondamento do float32 (~7 dígitos significativos). */
const folga = (v) => Math.abs(v) * 5e-7 + 0.001;

function plausivel(anterior, v, agora, taxaPorHora) {
  if (!anterior) return false;
  const delta = v - anterior.v;
  const horas = Math.max(0, (agora - anterior.t) / 3600000);
  return delta >= -folga(anterior.v) && delta <= taxaPorHora * horas + folga(anterior.v);
}

/**
 * @param {{ref?: {v,t}, cand?: {v,t}}} estado  guardado entre as leituras
 * @param {number|null} v                       valor lido agora
 * @returns {{valor: number|null, estado: object, recusado?: boolean, reancorado?: boolean}}
 */
export function filtrarContador(estado = {}, v, agora, taxaPorHora) {
  const ultimoAceito = estado.ref ? estado.ref.v : null;
  if (v === null || v === undefined || !Number.isFinite(v)) return { valor: ultimoAceito, estado };
  if (!estado.ref || plausivel(estado.ref, v, agora, taxaPorHora)) {
    return { valor: v, estado: { ref: { v, t: agora } } };
  }
  if (plausivel(estado.cand, v, agora, taxaPorHora)) {
    return { valor: v, estado: { ref: { v, t: agora } }, reancorado: !!estado.ref };
  }
  return { valor: ultimoAceito, estado: { ref: estado.ref, cand: { v, t: agora } }, recusado: !!estado.ref };
}

/** 500 kVA × 1,5 de folga — o mesmo teto do fluxo do Node-RED. */
export const TAXA_PADRAO = 750;
