/**
 * Bloco de acionamento, executado sobre o DOM mínimo.
 *
 * Existe por causa de um defeito real: a tela é remontada no mesmo elemento a
 * cada troca de tela, os ouvintes de clique se acumulavam, e um clique passava
 * a valer por dois — o primeiro armava, o segundo executava. O disjuntor abria
 * sem ninguém confirmar. Estes testes cobrem as duas travas que impedem isso:
 * ouvinte removido ao sair da tela, e tempo mínimo entre armar e confirmar.
 */
import { El } from './dom-minimo.mjs';

const corpo = new El('body');
globalThis.document = {
  body: corpo,
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  createElement: () => new El(),
};
globalThis.window = {
  DEMO_EMBUTIDO: false, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {}, AudioContext: null,
};
globalThis.location = { search: '', protocol: 'http:', host: 'x', hash: '' };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);

const enviados = [];
globalThis.fetch = async (rota, opcoes = {}) => {
  enviados.push({ rota, corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
  const dados = rota.startsWith('/api/comandos/executar')
    ? { confirmado: true, mensagem: 'Comando executado e confirmado pelo equipamento.' }
    : {
      liberados: true,
      // dois disjuntores do mesmo perfil: o nome do comando se repete
      comandos: ['clp', 'clp2'].map((medidor) => ({
        medidor,
        equipamento: medidor.toUpperCase(),
        nome: 'desligar',
        rotulo: 'Desligar disjuntor',
        descricao: 'Abertura remota',
        perigoso: true,
        papel: 'tecnico',
        autorizado: true,
        impedimentos: [],
        disponivel: true,
        exige_senha: false,
        causa: null,
      })),
    };
  return { status: 200, ok: true, json: async () => dados };
};

const { comandos, blocoComandos, _comandosInterno } = await import('../public/assets/telas/comandos.js');
const { estado } = await import('../public/assets/nucleo.js');
estado.usuario = { login: 'admin', papel: 'admin' };
estado.config = { comandos_liberados: true, equipamentos: [], limites: [] };

let passou = 0; let falhou = 0;
const ok = (nome, cond, detalhe = '') => {
  if (cond) { passou++; console.log('  ✓', nome); } else { falhou++; console.log('  ✗', nome, detalhe); }
};
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const executados = () => enviados.filter((e) => e.rota.startsWith('/api/comandos/executar')).length;

/** Um clique de verdade: dispara TODOS os ouvintes registrados na raiz. */
function clicarNoBotao(raiz, medidor = 'clp') {
  const botao = { dataset: { cmd: 'desligar', medidor } };
  const evento = { target: { closest: (sel) => (sel === '[data-cmd]' ? botao : null) } };
  for (const f of (raiz.ouvintes.click || [])) f(evento);
}

/* Remonta a tela no mesmo elemento, como o app faz ao trocar de tela. */
function montarTela(raiz) {
  comandos.destruir();
  raiz.innerHTML = blocoComandos();
  comandos.aoMontar(raiz);
}

console.log('\nBloco de acionamento: ouvintes e confirmação');
{
  const raiz = new El('div');
  montarTela(raiz);
  await pausa(50);
  ok('um ouvinte de clique depois de montar', (raiz.ouvintes.click || []).length === 1);

  // ida e volta entre telas, como o operador faz
  for (let i = 0; i < 4; i++) montarTela(raiz);
  await pausa(50);
  ok('ouvintes não se acumulam ao voltar à tela',
    (raiz.ouvintes.click || []).length === 1, `${(raiz.ouvintes.click || []).length} ouvintes`);
  ok('nem os de teclado', (raiz.ouvintes.keydown || []).length === 1);

  clicarNoBotao(raiz);
  await pausa(60);
  ok('um clique NÃO executa o comando', executados() === 0, `${executados()} execuções`);
  ok('um clique arma e pede confirmação', comandos._armado?.nome === 'desligar');

  // segundo clique imediato: ainda é o mesmo gesto, não confirma
  clicarNoBotao(raiz);
  await pausa(60);
  ok('clique repetido em milissegundos não confirma', executados() === 0);
  ok('o comando continua armado esperando o gesto', comandos._armado?.nome === 'desligar');

  // depois da espera mínima, a confirmação vale
  await pausa(_comandosInterno.ESPERA_MINIMA + 60);
  clicarNoBotao(raiz);
  await pausa(120);
  ok('o segundo gesto executa', executados() === 1);
  const envio = enviados.filter((e) => e.rota.startsWith('/api/comandos/executar')).at(-1);
  ok('o comando enviado é o declarado, com confirmação explícita',
    envio.corpo.comando === 'desligar' && envio.corpo.confirmado === true);
  ok('a senha não é inventada quando o comando não exige', envio.corpo.senha === '');
  ok('desarma depois de executar', comandos._armado === null);
}

console.log('\nBloco de acionamento: comando com o mesmo nome em dois equipamentos');
{
  const raiz = new El('div');
  montarTela(raiz);
  await pausa(50);
  const antes = executados();

  clicarNoBotao(raiz, 'clp2');
  ok('o botão do segundo equipamento arma o segundo', comandos._armado?.medidor === 'clp2');

  // armado no clp2, um toque no clp não pode confirmar o clp2 (nem o clp)
  await pausa(_comandosInterno.ESPERA_MINIMA + 60);
  clicarNoBotao(raiz, 'clp');
  await pausa(60);
  ok('toque em outro equipamento não confirma', executados() === antes);
  ok('e passa a armar o equipamento tocado', comandos._armado?.medidor === 'clp');

  clicarNoBotao(raiz, 'clp2');
  await pausa(_comandosInterno.ESPERA_MINIMA + 60);
  clicarNoBotao(raiz, 'clp2');
  await pausa(120);
  const envio = enviados.filter((e) => e.rota.startsWith('/api/comandos/executar')).at(-1);
  ok('a confirmação no segundo executa o segundo, não o primeiro',
    executados() === antes + 1 && envio.corpo.medidor === 'clp2', JSON.stringify(envio?.corpo));
}

console.log('\nBloco de acionamento: saída da tela');
{
  const raiz = new El('div');
  montarTela(raiz);
  await pausa(50);
  comandos.destruir();
  ok('sair da tela remove os ouvintes', (raiz.ouvintes.click || []).length === 0);
  const antes = executados();
  clicarNoBotao(raiz);
  await pausa(60);
  ok('clique em tela desmontada não faz nada', executados() === antes);
}

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
comandos.destruir();
process.exit(falhou ? 1 : 0);
