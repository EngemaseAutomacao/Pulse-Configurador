/* DOM mínimo, só o suficiente para executar o pacote do demo e detectar
   erros de execução (referências indefinidas, chamadas em nulo). */
class Classe {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, f) { if (f === undefined) f = !this.set.has(c); f ? this.set.add(c) : this.set.delete(c); return f; }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
    this.classList = new Classe(this); this._html = ''; this.textContent = '';
    this.attrs = {}; this.hidden = false; this.isConnected = true;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml'; this.ouvintes = {};
  }
  set innerHTML(v) { this._html = v; this.children = analisar(v, this); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.classList = new Classe(this); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.ouvintes[t] ||= []).push(f); }
  removeEventListener(t, f) { this.ouvintes[t] = (this.ouvintes[t] || []).filter((x) => x !== f); }
  closest() { return null; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return buscar(this.children, s); }
  appendChild(c) { this.children.push(c); return c; }
  getContext() { return contexto2d(); }
  get clientWidth() { return 900; }
  get clientHeight() { return 320; }
}
// "analisador" bem simples: extrai elementos com id, data-* e class do HTML gerado
function analisar(html, pai) {
  const saida = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\s([^>]*?)\/?>/g)) {
    const el = new El(m[1]);
    if (['svg', 'rect', 'text', 'tspan', 'circle', 'line', 'path'].includes(m[1])) {
      el.namespaceURI = 'http://www.w3.org/2000/svg';
    }
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      const [, k, v] = a;
      el.attrs[k] = v;
      if (k === 'id') el.id = v;
      if (k === 'class') v.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      if (k.startsWith('data-')) {
        el.dataset[k.slice(5).replace(/-([a-z])/g, (x, y) => y.toUpperCase())] = v;
      }
    }
    el.pai = pai;
    saida.push(el);
  }
  return saida;
}
function casa(el, s) {
  if (s.startsWith('#')) return el.id === s.slice(1);
  const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (m) return m[2] === undefined ? el.attrs[m[1]] !== undefined : el.attrs[m[1]] === m[2];
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  return el.tagName === s;
}
function buscar(lista, s) {
  const partes = s.split(',').map((x) => x.trim());
  return lista.filter((el) => partes.some((p) => casa(el, p)));
}
function contexto2d() {
  const noop = () => {};
  return new Proxy({ measureText: () => ({ width: 40 }), canvas: {} }, {
    get: (alvo, k) => (k in alvo ? alvo[k] : noop),
    set: () => true,
  });
}
export { El, analisar };
