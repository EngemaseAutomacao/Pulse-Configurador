/* Tema claro ou escuro, como no Engemase Pulse. Roda no <head>, antes de
   desenhar a página, para não piscar no tema errado. A escolha fica no
   navegador ("automatico", "claro" ou "escuro"); no automático, segue o
   aparelho e acompanha quando ele troca. */
(function () {
  var raiz = document.documentElement;
  var midia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function escolha() {
    try { return localStorage.getItem('tema') || 'automatico'; } catch (e) { return 'automatico'; }
  }

  function aplicar() {
    var pedido = escolha();
    var escuro = pedido === 'escuro' || (pedido !== 'claro' && !!(midia && midia.matches));
    raiz.setAttribute('data-tema', escuro ? 'escuro' : 'claro');
    raiz.style.colorScheme = escuro ? 'dark' : 'light';
    try { window.dispatchEvent(new Event('tema')); } catch (e) { /* navegador antigo */ }
  }

  window.PulseTema = {
    escolha: escolha,
    trocar: function (valor) {
      try { localStorage.setItem('tema', valor); } catch (e) { /* aba privada: vale só agora */ }
      aplicar();
    },
  };

  if (midia) {
    var mudou = function () { if (escolha() === 'automatico') aplicar(); };
    if (midia.addEventListener) midia.addEventListener('change', mudou);
    else if (midia.addListener) midia.addListener(mudou);
  }
  aplicar();
})();
