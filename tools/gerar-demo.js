/**
 * Gera public/demo.html: uma cópia fiel da interface, autocontida em um único
 * arquivo e alimentada pelo mesmo simulador do servidor. Serve para demonstrar
 * o produto sem servidor, sem CLP e sem rede.
 *
 *   node tools/gerar-demo.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');

// ordem de dependência: cada arquivo só usa o que já foi declarado antes
const MODULOS = [
  'public/assets/nucleo.js',
  'public/assets/grafico.js',
  'public/assets/telas/energia.js',
  'public/assets/telas/comandos.js',
  'public/assets/telas/unifilar.js',
  'public/assets/telas/consumo.js',
  'public/assets/telas/agua.js',
  'public/assets/telas/indicadores.js',
  'public/assets/telas/gerador.js',
  'public/assets/telas/historico.js',
  'public/assets/telas/alarmes.js',
  'public/assets/telas/engenharia.js',
  'public/assets/telas/usuarios.js',
  'public/assets/app.js',
];

/** Junta os módulos em um escopo só: tira os imports relativos e a palavra export. */
function empacotar() {
  const nomes = new Set();
  return MODULOS.map((arquivo) => {
    const fonte = ler(arquivo)
      .replace(/import\s+[^;]*?from\s+['"][^'"]+['"];?/g, '')
      .replace(/^export\s+/gm, '');
    // acusa colisão de nomes no topo de cada arquivo, que quebraria o pacote
    for (const m of fonte.matchAll(/^(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (nomes.has(m[1])) throw new Error(`nome repetido entre módulos: ${m[1]} (${arquivo})`);
      nomes.add(m[1]);
    }
    return `/* ---- ${arquivo} ---- */\n${fonte.trim()}\n`;
  }).join('\n');
}

const { prepararConfig } = await import('../src/perfis.js');
const bruta = JSON.parse(ler('config.json'));
const { config } = prepararConfig(bruta, path.join(raiz, 'perfis'));

const configDemo = {
  planta: config.planta,
  simulado: true,
  unifilar: config.unifilar,
  caixa_agua: config.caixa_agua,
  gerador: config.gerador,
  limites: config.alarmes,
  equipamentos: config.medidores.map((m) => ({
    id: m.id,
    nome: m.nome,
    tag_isa: m.tag_isa || null,
    grupo: m.grupo || 'energia',
    principal: !!m.principal,
    perfil: m.perfil || null,
    unit_id: m.conexao?.unit_id ?? null,
    tags: m.tags.map((t) => ({
      nome: t.nome, rotulo: t.rotulo, unidade: t.unidade ?? '',
      decimais: t.decimais ?? 1, fase: t.fase || null,
      acumulador: !!t.acumulador, oculto: !!t.oculto,
      digital: t.bit !== undefined || t.tipo === 'bool',
      severidade: t.severidade || null,
      inverso: !!t.inverso,
      enum: t.enum || null,
    })),
  })),
};

/** Logos de public/assets/marcas embutidos como data URI: o demo é um arquivo só. */
function marcasEmbutidas() {
  const dir = path.join(raiz, 'public/assets/marcas');
  const tipos = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
  const saida = {};
  if (!fs.existsSync(dir)) return saida;
  for (const nome of ['cliente', 'engemase']) {
    const ext = Object.keys(tipos).find((x) => fs.existsSync(path.join(dir, `${nome}.${x}`)));
    if (ext) saida[nome] = `data:${tipos[ext]};base64,${fs.readFileSync(path.join(dir, `${nome}.${ext}`)).toString('base64')}`;
  }
  return saida;
}

// o simulador do navegador é o mesmo arquivo usado pelo servidor
const simulador = ler('src/simulador.js').replace(/^export\s+/gm, '');
const preambulo = `
${simulador}
window.DEMO_RECURSOS = { CONFIG_DEMO: ${JSON.stringify(configDemo)}, Simulador, MARCAS: ${JSON.stringify(marcasEmbutidas())} };
window.DEMO_EMBUTIDO = true;
`;

// Atenção: a substituição precisa ser por função. Com texto, o "$$" do código
// (como no seletor $$ do núcleo) seria interpretado como escape e viraria "$".
/**
 * O demo é um arquivo só, aberto direto do disco: as fontes precisam viajar
 * dentro dele. Sem isso a demonstração no cliente cai na fonte do sistema e
 * perde a identidade que o produto tem em operação.
 */
function cssComFontesEmbutidas() {
  let css = ler('public/assets/estilo.css');
  for (const arquivo of fs.readdirSync(path.join(raiz, 'public/assets/fontes'))) {
    const dados = fs.readFileSync(path.join(raiz, 'public/assets/fontes', arquivo)).toString('base64');
    css = css.replace(`url("fontes/${arquivo}")`, `url("data:font/woff2;base64,${dados}")`);
  }
  return css;
}

const saida = ler('public/index.html')
  .replace('<link rel="stylesheet" href="assets/estilo.css">',
    () => `<style>\n${cssComFontesEmbutidas()}\n</style>`)
  .replace('<link rel="icon" type="image/png" href="assets/marcas/icone.png">', () => {
    const icone = path.join(raiz, 'public/assets/marcas/icone.png');
    return fs.existsSync(icone)
      ? `<link rel="icon" type="image/png" href="data:image/png;base64,${fs.readFileSync(icone).toString('base64')}">` : '';
  })
  .replace('<title>Supervisório de utilidades</title>',
    () => '<title>Supervisório de utilidades — demonstração</title>')
  .replace('<script type="module" src="assets/app.js"></script>',
    // script clássico, não módulo: o pacote já não tem import/export, e assim o
    // arquivo abre direto do disco (file://) sem esbarrar em regra de módulo
    () => `<script>${preambulo}</script>\n<script>\n${empacotar()}\n</script>`);

fs.writeFileSync(path.join(raiz, 'public/demo.html'), saida);
console.log('public/demo.html gerado com', (saida.length / 1024).toFixed(1), 'kB');
