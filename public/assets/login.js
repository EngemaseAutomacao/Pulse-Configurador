/* Tela de entrada. Fica fora do pacote da aplicação de propósito: quem não
   entrou não baixa o código das telas de operação. */
(function () {
  const $ = (s) => document.querySelector(s);

  // logos (assets/marcas/<nome>.svg|png|webp): o que não existir não aparece
  document.querySelectorAll('img[data-marca]').forEach((img) => {
    const fontes = ['svg', 'png', 'webp'].map((x) => `assets/marcas/${img.dataset.marca}.${x}`);
    let i = 0;
    img.onload = () => {
      img.hidden = false;
      const caixa = img.closest('[data-marca-caixa]');
      if (caixa) caixa.hidden = false;
    };
    img.onerror = () => { i += 1; if (i < fontes.length) img.src = fontes[i]; };
    img.src = fontes[0];
  });

  async function enviar(rota, corpo) {
    const r = await fetch(rota, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Painel': '1' },
      body: JSON.stringify(corpo),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || `falha (${r.status})`);
    return dados;
  }

  // quem chegou por um link direto (ex.: /#nuvem) volta
  // para a tela pedida depois de entrar; só o nome da tela, nada de endereço externo
  function destino() {
    const tela = location.hash.slice(1);
    return /^[a-z][a-z0-9_-]{0,30}$/.test(tela) ? `/#${tela}` : '/';
  }

  function mostrar(alvo, texto) {
    const el = $(alvo);
    el.textContent = texto;
    el.hidden = !texto;
  }

  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const botao = $('#entrar');
    botao.disabled = true;
    mostrar('#aviso', '');
    try {
      const r = await enviar('/api/login', { login: $('#login').value, senha: $('#senha').value });
      if (r.usuario?.trocar_senha) {
        $('#form').hidden = true;
        $('#form-troca').hidden = false;
        $('#atual').value = $('#senha').value;
        $('#nova').focus();
      } else {
        location.href = destino();
      }
    } catch (e) {
      mostrar('#aviso', e.message);
      $('#senha').value = '';
      $('#senha').focus();
    } finally {
      botao.disabled = false;
    }
  });

  $('#form-troca').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrar('#aviso-troca', '');
    if ($('#nova').value !== $('#nova2').value) return mostrar('#aviso-troca', 'as senhas não conferem');
    try {
      await enviar('/api/senha', { atual: $('#atual').value, nova: $('#nova').value });
      // a troca derruba a sessão de propósito: entra de novo com a senha nova
      const r = await enviar('/api/login', { login: $('#login').value, senha: $('#nova').value });
      if (r.usuario) location.href = destino();
    } catch (e) {
      mostrar('#aviso-troca', e.message);
    }
    return undefined;
  });

  $('#login').focus();
}());
