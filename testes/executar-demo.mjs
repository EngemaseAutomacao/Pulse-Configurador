/* Executa o pacote do demo sobre o DOM mínimo e reporta qualquer erro. */
import fs from 'node:fs';
import { El } from './dom-minimo.mjs';

const raizDoc = new El('body');
// os ids fixos saem do próprio index.html, para o teste não ficar desatualizado
const casca = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const fixos = [...new Set([...casca.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]))];
const mapa = new Map(fixos.map((id) => { const e = new El(); e.id = id; return [id, e]; }));

globalThis.document = {
  body: raizDoc,
  querySelector: (s) => (s.startsWith('#') ? mapa.get(s.slice(1)) || null : null),
  querySelectorAll: (s) => {
    const tela = mapa.get('tela');
    return (tela.children || []).filter((el) => {
      const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      return m[2] === undefined ? el.attrs[m[1]] !== undefined : el.attrs[m[1]] === m[2];
    });
  },
  addEventListener() {}, removeEventListener() {},
  createElement: () => new El(),
};
globalThis.window = {
  DEMO_EMBUTIDO: true, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {}, AudioContext: null,
};
globalThis.location = { search: '', protocol: 'file:', host: '', hash: '' };
// abrir o arquivo direto do disco (file://) faz o navegador recusar
// replaceState com SecurityError — o teste reproduz esse comportamento
globalThis.history = {
  replaceState() { throw new DOMException_('Failed to execute replaceState: origin null'); },
};
function DOMException_(msg) { const e = new Error(msg); e.name = 'SecurityError'; return e; }
globalThis.CSS = { escape: (s) => s };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const [pre, mod] = blocos;

const erros = [];
process.on('uncaughtException', (e) => erros.push(e));
process.on('unhandledRejection', (e) => erros.push(e));

// o preâmbulo declara Simulador e DEMO_RECURSOS no escopo global
new Function(pre.replace('window.DEMO_RECURSOS', 'globalThis.window.DEMO_RECURSOS')
  .replace('window.DEMO_EMBUTIDO', 'globalThis.window.DEMO_EMBUTIDO'))();

// executa como script clássico, igual ao navegador
new Function(mod)();

await new Promise((r) => setTimeout(r, 400));

// troca de tela: exercita montar/aoMontar/destruir de todas
const telas = ['energia', 'unifilar', 'consumo', 'agua', 'gerador', 'historico', 'alarmes'];
const menu = mapa.get('menu');
if (raizDoc.innerHTML && raizDoc.innerHTML.includes('Não foi possível')) {
  console.log('  ✗ falha na inicialização:\n', raizDoc.innerHTML.replace(/<[^>]+>/g, '').trim().slice(0, 600));
}
for (const t of telas) {
  const btn = (menu.children || []).find((c) => c.dataset.tela === t);
  if (!btn) { erros.push(new Error(`botão da tela ${t} não foi criado`)); continue; }
  for (const f of (menu.ouvintes.click || [])) f({ target: { closest: () => btn } });
  await new Promise((r) => setTimeout(r, 120));
  const conteudo = mapa.get('tela').innerHTML;
  if (!conteudo || conteudo.length < 200) erros.push(new Error(`tela ${t} ficou vazia`));
  else console.log(`  ✓ ${t.padEnd(10)} montou e atualizou (${conteudo.length} caracteres)`);
}
await new Promise((r) => setTimeout(r, 1200)); // deixa rodar alguns ciclos do simulador

if (erros.length) {
  console.log(`\n✗ ${erros.length} erro(s) em execução:`);
  for (const e of erros.slice(0, 6)) console.log('   ', e.stack?.split('\n').slice(0, 3).join('\n    '));
  process.exit(1);
}
console.log('\nnenhum erro em execução');
process.exit(0);
