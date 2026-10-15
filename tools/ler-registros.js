/**
 * Varre os registradores de um equipamento e mostra cada float encontrado —
 * para achar no mapa uma grandeza que o manual não deixa clara (ex.: a corrente
 * de neutro do 7KT0310): procure na lista o valor que o display mostra.
 *
 *   sudo systemctl stop supervisorio          (a porta só abre para um programa)
 *   node tools/ler-registros.js --porta /dev/ttyUSB0 --unit 1
 *   sudo systemctl start supervisorio
 *
 * Opções: --baud 9600  --funcao 4 (input) ou 3 (holding)  --de 0  --ate 400
 *         --ordem CDAB (padrão; ABCD para outros equipamentos)  --bloco 12
 */
import ModbusRTU from 'modbus-serial';

const args = process.argv.slice(2);
const op = (n, padrao) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : padrao; };
const porta = op('porta');
const tcp = op('tcp');          // equipamento Modbus TCP: --tcp 192.168.0.10:502
if (!porta && !tcp) { console.error('informe --porta (ex.: /dev/ttyUSB0) ou --tcp maquina:502'); process.exit(1); }
const baud = Number(op('baud', 9600));
const unit = Number(op('unit', 1));
const funcao = Number(op('funcao', 4));
const de = Number(op('de', 0));
const ate = Number(op('ate', 400));
const ordem = String(op('ordem', 'CDAB')).toUpperCase();
const bloco = Number(op('bloco', 12));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const float = (a, b) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(ordem === 'CDAB' ? b : a, 0);
  buf.writeUInt16BE(ordem === 'CDAB' ? a : b, 2);
  return buf.readFloatBE(0);
};

const cliente = new ModbusRTU();
try {
  if (tcp) {
    const [host, p] = tcp.split(':');
    await cliente.connectTCP(host, { port: Number(p) || 502 });
  } else {
    await cliente.connectRTUBuffered(porta, { baudRate: baud, parity: 'none', dataBits: 8, stopBits: 1 });
  }
} catch (e) {
  console.error(`não abriu ${porta || tcp}: ${e.message}`);
  console.error('o serviço está parado? (sudo systemctl stop supervisorio)');
  process.exit(1);
}
cliente.setID(unit);
cliente.setTimeout(1000);
console.log(`escravo ${unit}, função ${funcao}, ${de}…${ate}, float ${ordem}. Valores diferentes de zero:\n`);
console.log(' endereço   30xxx      valor');

for (let ini = de - (de % 2); ini < ate; ini += bloco) {
  const q = Math.min(bloco, ate - ini);
  try {
    const r = funcao === 3 ? await cliente.readHoldingRegisters(ini, q) : await cliente.readInputRegisters(ini, q);
    for (let i = 0; i + 1 < r.data.length; i += 2) {
      const v = float(r.data[i], r.data[i + 1]);
      if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 1e7 || Math.abs(v) < 1e-4) continue;
      console.log(`${String(ini + i).padStart(9)}   ${String(30001 + ini + i).padStart(5)}   ${v.toFixed(3).padStart(12)}`);
    }
  } catch (e) {
    console.log(`${String(ini).padStart(9)}…${ini + q - 1}: ${e.message}`);
  }
  await espera(30);
}
cliente.close(() => process.exit(0));
