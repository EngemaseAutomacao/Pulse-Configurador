/**
 * Mapeamento Modbus puro: tipos, ordem de palavras, extração de bits e
 * agrupamento de blocos. Sem dependência de driver, para poder ser testado
 * isoladamente.
 */
const TAMANHO = { bool: 1, int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, float64: 4 };
const FUNCOES_BIT = new Set(['coil', 'discreta']);

/** Monta um Buffer a partir dos registradores respeitando a ordem de palavras do medidor. */
function montarBuffer(regs, ordem) {
  const b = Buffer.alloc(regs.length * 2);
  regs.forEach((r, i) => b.writeUInt16BE(r & 0xffff, i * 2));
  switch ((ordem || 'ABCD').toUpperCase()) {
    case 'CDAB': { // palavras invertidas — o caso mais comum em multimedidores
      const s = Buffer.alloc(b.length);
      for (let i = 0; i + 3 < b.length; i += 4) {
        b.copy(s, i, i + 2, i + 4);
        b.copy(s, i + 2, i, i + 2);
      }
      return s;
    }
    case 'BADC': { // bytes invertidos dentro da palavra
      const s = Buffer.from(b);
      for (let i = 0; i + 1 < s.length; i += 2) { const t = s[i]; s[i] = s[i + 1]; s[i + 1] = t; }
      return s;
    }
    case 'DCBA':
      return Buffer.from(b).reverse();
    default:
      return b;
  }
}

function decodificar(regs, tipo, ordem) {
  const b = montarBuffer(regs, ordem);
  switch (tipo) {
    case 'int16':   return b.readInt16BE(0);
    case 'uint16':  return b.readUInt16BE(0);
    case 'int32':   return b.readInt32BE(0);
    case 'uint32':  return b.readUInt32BE(0);
    case 'float64': return b.readDoubleBE(0);
    case 'float32':
    default:        return b.readFloatBE(0);
  }
}

/**
 * Valores-sentinela: o equipamento responde "não sei" com um número reservado
 * no topo da faixa do tipo, em vez de uma exceção Modbus. Convenção GenComm
 * (Deep Sea), a mesma de vários controladores de grupo gerador:
 *   16 bits sem sinal  0xFFF8–0xFFFF   (0xFFFF = não implementado, 0xFFFE =
 *   16 bits com sinal  0x7FF8–0x7FFF    acima da faixa, 0xFFFD = abaixo,
 *   32 bits sem sinal  0xFFFFFFF8–…     0xFFFC = sensor em falha…)
 *   32 bits com sinal  0x7FFFFFF8–…
 * Sem este filtro, um sensor de óleo desligado apareceria como 655,35 bar.
 */
function ehSentinela(regs, tipo) {
  const b = montarBuffer(regs, 'ABCD');
  switch (tipo) {
    case 'uint16': return b.readUInt16BE(0) >= 0xfff8;
    case 'int16': { const u = b.readUInt16BE(0); return u >= 0x7ff8 && u <= 0x7fff; }
    case 'uint32': return regs.length >= 2 && b.readUInt32BE(0) >= 0xfffffff8;
    case 'int32': { if (regs.length < 2) return false; const u = b.readUInt32BE(0); return u >= 0x7ffffff8 && u <= 0x7fffffff; }
    default: return false;
  }
}

/** Normaliza uma tag aplicando os padrões do equipamento. */
function prepararTag(t, padrao) {
  const funcao = t.funcao || padrao.funcao || 'holding';
  const bit = Number.isInteger(t.bit) ? t.bit : null;
  const tipo = bit !== null ? 'uint16' : (t.tipo || padrao.tipo || 'float32');
  return {
    ...t,
    funcao,
    bit,
    // "bits": 4 lê um campo de 4 bits a partir de `bit` (0–15). É como o
    // GenComm guarda cada alarme: um código de 0 a 15 por "nibble"
    largura: bit !== null && Number.isInteger(t.bits) ? t.bits : 1,
    sentinelas: bit === null && !!(t.sentinelas ?? padrao.sentinelas),
    tipo,
    ordem: t.ordem_palavras || padrao.ordem_palavras || 'ABCD',
    escala: t.escala ?? padrao.escala ?? 1,
    deslocamento: t.offset ?? 0,
    // limitar: [min, max] corta o valor já escalonado na faixa útil. Sensor de
    // 4-20 mA passa um pouco da faixa nas pontas; sem isso a tela mostra -1,7 %.
    limitar: Array.isArray(t.limitar) && t.limitar.length === 2 ? t.limitar : null,
    // faixa_fisica: [min, max] do que a grandeza pode valer de verdade. Fora
    // dela a leitura veio corrompida (float montado com metades de grandezas
    // diferentes dá 1e36 kW) e vira "sem dado" — não vai à tela nem ao histórico
    faixa: Array.isArray(t.faixa_fisica) && t.faixa_fisica.length === 2 ? t.faixa_fisica
      : (Array.isArray(padrao.faixa_fisica) && padrao.faixa_fisica.length === 2 ? padrao.faixa_fisica : null),
    lento: !!t.lento,
    palavras: FUNCOES_BIT.has(funcao) ? 1 : (TAMANHO[tipo] || 2),
  };
}

/**
 * Junta tags vizinhas em blocos para reduzir o número de requisições.
 * Tags que leem bits do mesmo registrador caem no mesmo bloco naturalmente.
 */
function montarBlocos(tags, padrao) {
  const gapMax = padrao.gap_maximo ?? 8;
  const maxRegs = padrao.max_registradores ?? 100;
  // Equipamento que numera os registradores a partir de 1 no fio: o perfil
  // continua com o endereço do manual e só o pedido sai deslocado. O 7KT0310
  // devolve V1N (registrador 0 do manual) quando se pede o endereço 1.
  const desloc = padrao.deslocamento_endereco ?? 0;

  // tag calculada pelo supervisório (prontidão, autonomia) não tem endereço:
  // nunca entra num bloco de leitura, só existe do lado de cá
  const preparadas = tags.filter((t) => !t.calculada).map((t) => prepararTag(t, padrao))
    .sort((a, b) => Number(a.lento) - Number(b.lento)
      || a.funcao.localeCompare(b.funcao)
      || a.endereco - b.endereco);

  const blocos = [];
  for (const tag of preparadas) {
    const fim = tag.endereco + tag.palavras;
    const ultimo = blocos[blocos.length - 1];
    const cabe = ultimo
      && ultimo.funcao === tag.funcao
      && ultimo.lento === tag.lento
      && tag.endereco - ultimo.fim <= gapMax
      && fim - ultimo.inicio <= maxRegs;
    if (cabe) {
      ultimo.fim = Math.max(ultimo.fim, fim);
      ultimo.tags.push(tag);
    } else {
      blocos.push({ funcao: tag.funcao, inicio: tag.endereco, fim, tags: [tag], lento: tag.lento });
    }
  }
  for (const b of blocos) b.endereco_fisico = b.inicio + desloc;
  return blocos;
}


/**
 * Interpreta um bloco de registradores de todas as formas plausíveis ao mesmo
 * tempo. É o que resolve na prática a dúvida de ordem de palavras: basta ver
 * em qual coluna aparece o valor que o mostrador do equipamento indica.
 */
function interpretar(registradores) {
  const linhas = [];
  for (let i = 0; i < registradores.length; i++) {
    const r = registradores[i];
    const linha = {
      endereco_relativo: i,
      bruto: r,
      hex: `0x${(r & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`,
      bits: (r & 0xffff).toString(2).padStart(16, '0'),
      int16: decodificar([r], 'int16'),
      uint16: decodificar([r], 'uint16'),
    };
    if (i + 1 < registradores.length) {
      const par = [r, registradores[i + 1]];
      for (const ordem of ['ABCD', 'CDAB', 'BADC', 'DCBA']) {
        const v = decodificar(par, 'float32', ordem);
        linha[`float_${ordem}`] = Number.isFinite(v) ? +v.toPrecision(7) : null;
      }
      linha.uint32 = decodificar(par, 'uint32');
      linha.int32 = decodificar(par, 'int32');
    }
    linhas.push(linha);
  }
  return linhas;
}

/**
 * A mesma porta física escrita de jeitos diferentes — "COM7", "com7",
 * "\\.\COM7" — vira uma chave só. Sem isso, dois equipamentos na mesma RS-485
 * ganhariam filas separadas e falariam ao mesmo tempo no par trançado.
 * Só o nome COMn do Windows é normalizado: no Linux /dev/ttyUSB0 diferencia
 * maiúsculas de verdade.
 */
function normalizarPorta(porta) {
  const s = String(porta || '').trim().replace(/^\\\\\.\\/, '');
  return /^com\d+$/i.test(s) ? s.toUpperCase() : s;
}

export {
  TAMANHO, FUNCOES_BIT, montarBuffer, decodificar, prepararTag, montarBlocos, interpretar, normalizarPorta,
  ehSentinela,
};

