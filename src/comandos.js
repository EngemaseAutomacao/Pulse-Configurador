/**
 * Comandos de acionamento.
 *
 * Um supervisório que escreve no processo precisa de mais cuidado que um que
 * só lê. As regras aqui são as mesmas de um comando de painel:
 *
 *   1. o acionamento é declarado na configuração, nunca montado pelo cliente;
 *   2. os intertravamentos são avaliados NO SERVIDOR, com a última leitura —
 *      a tela desabilita o botão por conveniência, mas quem decide é aqui;
 *   3. nada é escrito sem a instalação liberar (`seguranca.comandos_liberados`)
 *      e sem o operador ter o papel exigido pelo comando;
 *   4. depois de escrever, o resultado é conferido pela realimentação do
 *      equipamento: comando aceito não é comando cumprido;
 *   5. tudo fica na auditoria, inclusive o que foi recusado e por quê.
 */

export const PRAZO_CONFIRMACAO_PADRAO = 10;

/**
 * Palavras que o comando escreve, a partir de `endereco`:
 *   "valor": 2                 → [2], uma palavra (FC6), como no flow original
 *   "complemento": true        → [2, 65533]: o valor e o seu complemento, no
 *                                 mesmo quadro (FC16). O CLP só executa se a
 *                                 segunda for o inverso bit a bit da primeira
 *   "valores": [1, 1]          → lista livre (FC16; em coil, FC15 — os "dois
 *                                 bits para ligar")
 * Em quadro único: as duas palavras chegam juntas ou não chegam.
 */
export function palavrasDoComando(c) {
  if (Array.isArray(c.valores)) return c.valores;
  if (c.complemento) return [c.valor, (~c.valor) & 0xffff];
  return [c.valor];
}

/** Registradores que o comando ocupa: [primeiro, último]. */
export function faixaDoComando(c) {
  return [c.endereco, c.endereco + palavrasDoComando(c).length - 1];
}

/** Valor atual de uma tag na última varredura. */
function leitura(equipamentos, idEquipamento, nome) {
  const eq = equipamentos[idEquipamento];
  if (!eq || !eq.online) return null;
  const v = eq.valores?.[nome];
  return v === undefined ? null : v;
}

const igualA = (v, alvo) => Math.abs(v - alvo) < 0.5;

/**
 * Condição de um intertravamento. Além de igual/min/max, aceita listas — que é
 * como se declara religamento por tipo de falha:
 *   "em":      [0, 2, 3]   só religa se a causa do disparo estiver nesta lista
 *   "fora_de": [1, 4]      bloqueia se a causa for uma destas
 */
export function condicaoAtendida(trava, v) {
  if (Array.isArray(trava.em)) return trava.em.some((x) => igualA(v, x));
  if (Array.isArray(trava.fora_de)) return !trava.fora_de.some((x) => igualA(v, x));
  if (trava.igual !== undefined) return igualA(v, trava.igual);
  return (trava.min === undefined || v >= trava.min)
    && (trava.max === undefined || v <= trava.max);
}

/** Texto de uma tag de código: "2" vira "sobretensão" quando há enum no perfil. */
export function textoDoValor(nomeTag, v, defTags = []) {
  const def = (defTags || []).find((d) => d.nome === nomeTag);
  const chave = String(Math.round(v));
  return def?.enum?.[chave] ?? String(v);
}

/**
 * Avalia os intertravamentos de um comando.
 * Devolve a lista de impedimentos em linguagem de operador — vazia significa
 * que o comando pode ser executado agora. `{valor}` na mensagem é trocado pelo
 * texto do estado que bloqueou, para o operador ler "disparo por sobrecorrente"
 * em vez de "condição não atendida".
 */
export function impedimentos(comando, idEquipamento, equipamentos, defTags = []) {
  const eq = equipamentos[idEquipamento];
  if (!eq) return ['Equipamento não existe nesta configuração'];
  if (!eq.online) return ['Sem comunicação com o equipamento'];

  const lista = [];
  for (const trava of comando.intertravamentos || []) {
    const v = leitura(equipamentos, idEquipamento, trava.tag);
    if (v === null) {
      lista.push(trava.senao || `Sem leitura de ${trava.tag}`);
      continue;
    }
    if (!condicaoAtendida(trava, v)) {
      lista.push((trava.senao || `Condição não atendida: ${trava.tag}`)
        .replace('{valor}', textoDoValor(trava.tag, v, defTags)));
    }
  }
  return lista;
}

/** O comando, com o que a tela precisa para desenhar o botão e explicar o bloqueio. */
export function estadoDosComandos(config, equipamentos, papelDoUsuario, podeNoPapel) {
  if (!config.seguranca?.comandos_liberados) return [];
  const saida = [];
  for (const m of config.medidores || []) {
    for (const c of m.comandos || []) {
      const papel = c.papel || 'tecnico';
      const travas = impedimentos(c, m.id, equipamentos, m.tags);
      saida.push({
        medidor: m.id,
        equipamento: m.nome,
        nome: c.nome,
        rotulo: c.rotulo || c.nome,
        descricao: c.descricao || null,
        perigoso: !!c.perigoso,
        papel,
        autorizado: podeNoPapel(papelDoUsuario, papel),
        impedimentos: travas,
        disponivel: travas.length === 0 && podeNoPapel(papelDoUsuario, papel),
        prazo_s: c.confirma_com?.prazo_s ?? PRAZO_CONFIRMACAO_PADRAO,
        exige_senha: !!c.exige_senha,
        // causa do último disparo, quando o equipamento informa: é o que
        // explica na tela por que o religamento remoto está liberado ou não
        causa: c.mostrar_causa
          ? textoDoValor(c.mostrar_causa, leitura(equipamentos, m.id, c.mostrar_causa) ?? -1, m.tags)
          : null,
      });
    }
  }
  return saida;
}

export function acharComando(config, idMedidor, nome) {
  const m = (config.medidores || []).find((x) => x.id === idMedidor);
  const c = (m?.comandos || []).find((x) => x.nome === nome);
  return c ? { medidor: m, comando: c } : null;
}

/**
 * Executa um comando já autorizado: escreve o valor e espera a realimentação
 * confirmar. `lerAgora` devolve a leitura mais recente do equipamento.
 */
export async function executar({
  comando, idMedidor, coletor, unitId, barramento, lerAgora, esperar = 400,
}) {
  const palavras = palavrasDoComando(comando);
  const escrita = await coletor.escreverBruto({
    barramento,
    unit_id: unitId,
    funcao: comando.funcao || 'holding',
    endereco: comando.endereco,
    valor: palavras[0],
    ...(palavras.length > 1 ? { valores: palavras } : {}),
    urgente: true,             // passa na frente da varredura que estiver na fila
  });

  // eco fora do padrão não derruba o comando: vai para a auditoria, e quem
  // decide se o equipamento obedeceu é a realimentação logo abaixo
  const eco = escrita?.ecoDivergente ? { eco_divergente: escrita.ecoDivergente } : {};

  const conferir = comando.confirma_com;
  if (!conferir) {
    return { escrito: true, confirmado: null, ...eco, mensagem: 'Comando enviado. Este comando não tem realimentação configurada.' };
  }

  const prazo = (conferir.prazo_s ?? PRAZO_CONFIRMACAO_PADRAO) * 1000;
  const limite = Date.now() + prazo;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, esperar));
    const v = leitura(await lerAgora(), idMedidor, conferir.tag);
    if (v !== null && Math.abs(v - conferir.igual) < 0.5) {
      return { escrito: true, confirmado: true, ...eco, mensagem: 'Comando executado e confirmado pelo equipamento.' };
    }
  }
  return {
    escrito: true,
    confirmado: false,
    ...eco,
    mensagem: `Comando enviado, mas o equipamento não confirmou em ${conferir.prazo_s ?? PRAZO_CONFIRMACAO_PADRAO} s. Verifique no painel.`,
  };
}
