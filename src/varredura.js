/**
 * Varredura de endereços: descobre quem responde no barramento.
 * Abre uma conexão própria, com os parâmetros pedidos, para poder testar
 * velocidade e paridade diferentes das que estão em operação.
 */
import ModbusRTU from 'modbus-serial';
import { decodificar } from './mapa.js';

const FUNCOES = {
  holding: (c, e, q) => c.readHoldingRegisters(e, q),
  input: (c, e, q) => c.readInputRegisters(e, q),
  coil: (c, e, q) => c.readCoils(e, q),
  discreta: (c, e, q) => c.readDiscreteInputs(e, q),
};

export async function varrerBarramento(opcoes = {}, aoProgredir) {
  const {
    tipo = 'rtu',
    porta_serial = '/dev/ttyUSB0', baud = 9600, paridade = 'none',
    bits_dados = 8, bits_parada = 1,
    host = '', porta = 502,
    de = 1, ate = 32,
    funcao = 'holding', endereco = 0, quantidade = 2, timeout_ms = 300,
  } = opcoes;

  // enquanto varre, a supervisão fica parada: nada de faixa sem fim nem de
  // espera por endereço que some com minutos de leitura
  const inteiroEntre = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!inteiroEntre(de, 1, 247) || !inteiroEntre(ate, 1, 247) || de > ate) {
    throw new Error('faixa de endereços deve ficar entre 1 e 247, com início ≤ fim');
  }
  if (!inteiroEntre(timeout_ms, 50, 5000)) throw new Error('tempo de espera entre 50 e 5000 ms');
  if (!inteiroEntre(quantidade, 1, 125)) throw new Error('quantidade entre 1 e 125');

  const cliente = new ModbusRTU();
  if (tipo === 'tcp') {
    if (!/^[\w.-]+$/.test(String(host))) throw new Error('endereço IP ou nome de máquina inválido');
    // conexão que não completa fica pendurada: em rede, quem não respondeu em
    // poucos segundos não vai responder
    await Promise.race([
      cliente.connectTCP(String(host), { port: Number(porta) || 502 }),
      new Promise((_, rejeitar) => setTimeout(
        () => rejeitar(new Error(`sem resposta de ${host}:${porta} — confira IP, cabo e firewall`)),
        Math.max(2000, timeout_ms * 4),
      )),
    ]);
  } else {
    await cliente.connectRTUBuffered(porta_serial, {
      baudRate: baud, parity: paridade, dataBits: bits_dados, stopBits: bits_parada,
    });
  }
  cliente.setTimeout(timeout_ms);

  const achados = [];
  try {
    for (let id = de; id <= ate; id++) {
      cliente.setID(id);
      const t0 = Date.now();
      try {
        const r = await (FUNCOES[funcao] || FUNCOES.holding)(cliente, endereco, quantidade);
        achados.push({ unit_id: id, situacao: 'respondeu', ms: Date.now() - t0, dados: r.data });
      } catch (e) {
        const msg = e.message || String(e);
        // exceção Modbus significa que o escravo existe, só não gosta do pedido
        if (/exception|illegal/i.test(msg)) {
          achados.push({ unit_id: id, situacao: 'existe', ms: Date.now() - t0, erro: msg });
        }
      }
      aoProgredir?.({ id, de, ate, achados: achados.length });
    }
  } finally {
    await new Promise((r) => cliente.close(r));
  }
  return achados;
}

export { interpretar } from './mapa.js';
