import { estado, esc, limiteMax, defEquipamento } from '../nucleo.js';
import { blocoComandos, comandos } from './comandos.js';

const ORDEM = [
  'tensao_ab', 'tensao_bc', 'tensao_ca', 'tensao_an', 'tensao_bn', 'tensao_cn',
  'corrente_a', 'corrente_b', 'corrente_c', 'corrente_n',
  'potencia_ativa', 'potencia_reativa', 'potencia_aparente',
  'fp', 'frequencia', 'demanda', 'thd_tensao', 'thd_tensao_b', 'thd_tensao_c',
  'thd_corrente', 'thd_corrente_b', 'thd_corrente_c',
  'corrente_harmonica', 'corrente_harmonica_a', 'corrente_harmonica_b', 'corrente_harmonica_c',
  'energia_ativa', 'energia_aparente',
];

export function leitura(tag, def, { grande = false } = {}) {
  if (!def) return '';
  return `<div class="leitura" data-leitura="${tag}"${def.fase ? ` data-fase="${def.fase}"` : ''}>
    <span class="rotulo">${esc(def.rotulo)}</span>
    <span class="valor${grande ? ' g' : ''} sem-dado"><span data-tag="${tag}" data-dec="${def.decimais ?? 1}">––</span>${
  def.unidade ? `<span class="un">${esc(def.unidade)}</span>` : ''}</span>
  </div>`;
}

export function placa(isa, titulo, idEquipamento) {
  return `<div class="placa">
    <span class="isa">${esc(isa || '')}</span>
    <span class="titulo">${esc(titulo)}</span>
    ${idEquipamento ? `<span class="estado" data-estado="${idEquipamento}">em serviço</span>` : ''}
  </div>`;
}

function barrasDeFase(id, escala) {
  return `<div class="barras">${[['a', 'I1'], ['b', 'I2'], ['c', 'I3']].map(([f, r]) => `
    <div class="barra-fase">
      <span class="id">${r}</span>
      <span class="trilho"><span class="fill" data-barra="${id}.corrente_${f}" data-escala="${escala}"
            style="width:0;background:var(--fase-${f})"></span></span>
      <span class="medida" data-tag="${id}.corrente_${f}" data-dec="1">––</span>
    </div>`).join('')}</div>`;
}

/**
 * Estado vazio. Uma tela sem equipamento não some nem mostra caixas em branco:
 * ela diz o que falta e onde fazer. É o que o instalador vê antes de cadastrar
 * o primeiro medidor.
 */
export function estadoVazio({ isa = '', titulo, mensagem, passos = [] }) {
  return `
    <section class="bloco">
      ${placa(isa, titulo)}
      <div class="corpo">
        <div class="vazio-guia">
          <p class="vazio-texto">${esc(mensagem)}</p>
          ${passos.length ? `<ol class="vazio-passos">${passos.map((t) => `<li>${t}</li>`).join('')}</ol>` : ''}
        </div>
      </div>
    </section>`;
}

const SEM_MEDIDOR = {
  mensagem: 'Nenhum medidor de energia está cadastrado nesta instalação.',
  passos: [
    'Abra <b>Engenharia</b> e use <b>Varredura do barramento</b> para descobrir em que endereço cada medidor responde.',
    'Em <b>Equipamentos</b>, adicione um medidor por vez: escolha o perfil, dê um nome e informe o endereço Modbus.',
    'Confira a leitura no <b>Terminal Modbus</b> e aplique a configuração.',
  ],
};

export const telaEnergia = {
  id: 'energia',
  isa: 'QGBT-01',
  nome: 'Energia',
  titulo: 'Energia',

  // sem isto o bloco de acionamento aparece mas não responde: quem escuta o
  // clique, guarda a senha digitada e refaz o bloco a cada varredura é o
  // módulo de comandos, e ele precisa ser ligado e desligado com a tela.
  aoMontar(raiz) {
    if (estado.config.comandos_liberados) comandos.aoMontar(raiz);
  },

  destruir() {
    comandos.destruir();
  },

  montar() {
    // o acionamento é assunto de energia, então mora aqui mesmo quando o
    // disjuntor está num CLP de outro grupo
    const acionamento = estado.config.comandos_liberados ? blocoComandos() : '';

    const eqs = estado.config.equipamentos.filter((e) => e.grupo === 'energia');
    if (!eqs.length) {
      return estadoVazio({ isa: 'QGBT-01', titulo: 'Energia', ...SEM_MEDIDOR }) + acionamento;
    }
    const principal = eqs.find((e) => e.principal) || eqs[0];
    const outros = eqs.filter((e) => e.id !== principal.id);
    const escalaGeral = limiteMax(`${principal.id}.corrente_a`) || 630;

    const tags = principal.tags
      .filter((t) => !t.oculto)
      .slice()
      .sort((a, b) => ORDEM.indexOf(a.nome) - ORDEM.indexOf(b.nome));

    return `
      <section class="bloco">
        ${placa(principal.tag_isa, principal.nome, principal.id)}
        <div class="corpo">
          <div class="leituras">${tags.map((t) => leitura(`${principal.id}.${t.nome}`, t)).join('')}</div>
          ${barrasDeFase(principal.id, escalaGeral)}
        </div>
      </section>

      ${acionamento}

      <div class="grade">
        ${outros.map((e) => {
    const escala = limiteMax(`${e.id}.corrente_a`) || escalaGeral;
    const def = defEquipamento(e.id);
    const pot = def?.tags.find((t) => t.nome === 'potencia_ativa');
    return `<section class="bloco">
            ${placa(e.tag_isa, e.nome, e.id)}
            <div class="corpo">
              <div class="leituras">${leitura(`${e.id}.potencia_ativa`, pot)}</div>
              ${barrasDeFase(e.id, escala)}
              <div class="escala">
                <div class="extremos"><span>0 A</span><span>disjuntor ${escala} A</span></div>
              </div>
            </div>
          </section>`;
  }).join('')}
      </div>`;
  },
};
