import { estado, esc } from '../nucleo.js';
import { placa, estadoVazio } from './energia.js';
import { blocoComandos, comandos } from './comandos.js';

export const telaUnifilar = {
  id: 'unifilar',
  isa: 'QGBT-01',
  nome: 'Unifilar',
  titulo: 'Diagrama unifilar',

  aoMontar(raiz) {
    if (estado.config.comandos_liberados) comandos.aoMontar(raiz);
  },

  destruir() {
    comandos.destruir();
  },

  montar() {
    const acionamento = estado.config.comandos_liberados ? blocoComandos() : '';
    const u = estado.config.unifilar;
    const temEnergia = estado.config.equipamentos.some((e) => e.grupo === 'energia');
    if (!u || !temEnergia) {
      return estadoVazio({
        isa: 'QGBT-01',
        titulo: 'Diagrama unifilar',
        mensagem: !temEnergia
          ? 'O diagrama é desenhado a partir dos medidores de energia, e nenhum está cadastrado ainda.'
          : 'Os medidores existem, mas falta descrever o quadro para desenhar o diagrama.',
        passos: !temEnergia ? [
          'Cadastre os medidores em <b>Engenharia → Equipamentos</b>.',
          'Marque um deles como <b>entrada geral</b>: é o topo do diagrama.',
          'Informe a corrente do disjuntor de cada alimentador, que vira a escala da barra de carga.',
        ] : [
          'Em <b>Engenharia → Equipamentos</b>, marque qual medidor é a <b>entrada geral</b>.',
          'Os demais medidores de energia entram como alimentadores, um por linha.',
        ],
      }) + acionamento;
    }
    const saidas = (u.saidas || []).filter((s) => estado.config.equipamentos.some((e) => e.id === s.medidor));
    const p = u.entrada.medidor;
    const g = u.gerador?.medidor;

    const larg = 1000;
    const xRede = 92;
    const xGer = 258;
    const xBarra = 175;
    const yQta = 214;
    const y0 = 300;
    const passo = 54;
    const fimBarra = y0 + (saidas.length - 1) * passo + 26;
    const alt = fimBarra + 24;
    const COL = { a: 660, b: 748, c: 836, kw: 940 };

    const linhas = saidas.map((s, i) => {
      const y = y0 + i * passo;
      return `
        <path class="cond" data-cond="${s.medidor}" d="M ${xBarra} ${y} H 258"/>
        <path class="fluxo" data-fluxo="${s.medidor}" d="M ${xBarra} ${y} H 258" style="visibility:hidden"/>
        <rect class="caixa" x="258" y="${y - 13}" width="54" height="26"/>
        <text class="simbolo" x="285" y="${y + 4}" text-anchor="middle">${esc(s.disjuntor)}</text>
        <path class="cond" data-cond="${s.medidor}" d="M 312 ${y} H 352"/>
        <text class="rot" x="364" y="${y - 4}">${esc(s.tag_isa || '')}</text>
        <text x="364" y="${y + 10}">${esc(s.rotulo)}</text>
        <rect class="trilho-svg" x="530" y="${y - 3}" width="100" height="6"/>
        <rect class="carga" x="530" y="${y - 3}" width="0" height="6"
              data-carga-barra="${s.medidor}" data-largura-max="100"/>
        <text class="rot" x="530" y="${y + 16}" data-carga-txt="${s.medidor}">––</text>
        <text class="num f-a" x="${COL.a}" y="${y + 4}" text-anchor="end"><tspan data-tag="${s.medidor}.corrente_a" data-dec="1">––</tspan></text>
        <text class="num f-b" x="${COL.b}" y="${y + 4}" text-anchor="end"><tspan data-tag="${s.medidor}.corrente_b" data-dec="1">––</tspan></text>
        <text class="num f-c" x="${COL.c}" y="${y + 4}" text-anchor="end"><tspan data-tag="${s.medidor}.corrente_c" data-dec="1">––</tspan></text>
        <text class="num" x="${COL.kw}" y="${y + 4}" text-anchor="end"><tspan data-tag="${s.medidor}.potencia_ativa" data-dec="2">––</tspan></text>
        <circle class="led-svg" cx="978" cy="${y}" r="4" data-led="${s.medidor}"/>`;
    }).join('');

    const medida = (rotulo, tag, dec, unidade, x, yr, yn, fase) => `
      <text class="rot" x="${x}" y="${yr}" text-anchor="middle">${esc(rotulo)}</text>
      <text class="num ${fase ? `f-${fase}` : ''}" x="${x}" y="${yn}" text-anchor="middle" style="font-size:15px">
        <tspan data-tag="${tag}" data-dec="${dec}">––</tspan>${unidade ? ` ${unidade}` : ''}</text>`;

    return `
      <section class="bloco">
        ${placa('QGBT-01', 'Diagrama unifilar')}
        <div class="corpo">
          <div class="rolagem">
          <svg class="desenho" viewBox="0 0 ${larg} ${alt}" role="img"
               aria-label="Diagrama unifilar com corrente em tempo real">

            <!-- fonte: concessionária -->
            <text class="rot" x="${xRede}" y="18" text-anchor="middle">${esc(u.entrada.rotulo)}</text>
            <path class="cond" data-cond="${p}" d="M ${xRede} 28 V 62"/>
            <path class="fluxo" data-fluxo="${p}" d="M ${xRede} 28 V 62" style="visibility:hidden"/>
            <circle class="caixa" cx="${xRede}" cy="84" r="21"/>
            <text class="simbolo" x="${xRede}" y="88" text-anchor="middle">kWh</text>
            <path class="cond" data-cond="${p}" d="M ${xRede} 105 V 136"/>
            <rect class="caixa" x="${xRede - 17}" y="136" width="34" height="32"/>
            <path class="cond" d="M ${xRede - 9} 164 L ${xRede + 9} 140"/>
            <path class="cond" data-cond="${p}" d="M ${xRede} 168 V ${yQta}"/>
            <path class="fluxo" data-fluxo="${p}" d="M ${xRede} 168 V ${yQta}" style="visibility:hidden"/>

            <!-- fonte: grupo gerador -->
            ${g ? `
            <text class="rot" x="${xGer}" y="18" text-anchor="middle">${esc(u.gerador.rotulo)}</text>
            <path class="cond" data-cond="${g}" d="M ${xGer} 28 V 62"/>
            <path class="fluxo" data-fluxo="${g}" d="M ${xGer} 28 V 62" style="visibility:hidden"/>
            <circle class="caixa" cx="${xGer}" cy="84" r="21"/>
            <text class="simbolo" x="${xGer}" y="89" text-anchor="middle" style="font-size:15px">G</text>
            <path class="cond" data-cond="${g}" d="M ${xGer} 105 V 136"/>
            <rect class="caixa" x="${xGer - 17}" y="136" width="34" height="32"/>
            <path class="cond" d="M ${xGer - 9} 164 L ${xGer + 9} 140"/>
            <path class="cond" data-cond="${g}" d="M ${xGer} 168 V ${yQta}"/>
            <path class="fluxo" data-fluxo="${g}" d="M ${xGer} 168 V ${yQta}" style="visibility:hidden"/>
            <text class="num" x="${xGer + 30}" y="196"><tspan data-tag="${g}.potencia" data-dec="1">––</tspan> kW</text>
            ` : ''}

            <!-- chave de transferência -->
            <rect class="caixa" x="46" y="${yQta}" width="258" height="30"/>
            <text class="rot" x="56" y="${yQta + 19}">QTA-01 · chave de transferência</text>
            <path class="cond" data-cond="${p}" d="M ${xBarra} ${yQta + 30} V ${y0 - 34}"/>
            <path class="fluxo" data-fluxo="${p}" d="M ${xBarra} ${yQta + 30} V ${y0 - 34}" style="visibility:hidden"/>

            <!-- medidas da entrada -->
            ${medida('tensão V1-2', `${p}.tensao_ab`, 1, 'V', 420, 40, 66)}
            ${medida('potência ativa', `${p}.potencia_ativa`, 2, 'kW', 610, 40, 66)}
            ${medida('fator de potência', `${p}.fp`, 3, '', 790, 40, 66)}
            ${medida('neutro', `${p}.corrente_n`, 1, 'A', 930, 40, 66)}
            ${medida('corrente I1', `${p}.corrente_a`, 1, 'A', 420, 112, 138, 'a')}
            ${medida('corrente I2', `${p}.corrente_b`, 1, 'A', 610, 112, 138, 'b')}
            ${medida('corrente I3', `${p}.corrente_c`, 1, 'A', 790, 112, 138, 'c')}
            <text class="rot" x="930" y="112" text-anchor="middle">carga da entrada</text>
            <rect class="trilho-svg" x="870" y="128" width="120" height="8"/>
            <rect class="carga" x="870" y="128" width="0" height="8"
                  data-carga-barra="${p}" data-largura-max="120"/>
            <text class="rot" x="930" y="154" text-anchor="middle" data-carga-txt="${p}">––</text>

            <!-- barramento -->
            <line class="barra-geral" x1="${xBarra}" y1="${y0 - 34}" x2="${xBarra}" y2="${fimBarra}"/>
            <text class="rot" x="${xBarra + 14}" y="${y0 - 40}">${esc(u.barramento.rotulo)}</text>

            <text class="rot" x="364" y="${y0 - 28}">alimentador</text>
            <text class="rot" x="530" y="${y0 - 28}">carga</text>
            <text class="rot f-a" x="${COL.a}" y="${y0 - 28}" text-anchor="end">I1 · A</text>
            <text class="rot f-b" x="${COL.b}" y="${y0 - 28}" text-anchor="end">I2 · A</text>
            <text class="rot f-c" x="${COL.c}" y="${y0 - 28}" text-anchor="end">I3 · A</text>
            <text class="rot" x="${COL.kw}" y="${y0 - 28}" text-anchor="end">kW</text>
            <line x1="364" y1="${y0 - 22}" x2="986" y2="${y0 - 22}" stroke="var(--linha)" stroke-width="1"/>
            ${linhas}
          </svg>
          </div>
        </div>
      </section>

      ${acionamento}`;
  },
};
