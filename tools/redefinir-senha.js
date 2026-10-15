/**
 * Recupera o acesso quando a senha de um usuário se perdeu (tipicamente o admin).
 *
 *   node tools/redefinir-senha.js --config config.planta.json            usuário admin
 *   node tools/redefinir-senha.js --config config.planta.json joao
 *
 * Gera uma senha temporária, reativa a conta, derruba as sessões abertas dela e
 * exige a troca no próximo login — o mesmo estado do primeiro acesso. Fica na
 * auditoria. Pode rodar com o serviço no ar; quem tem acesso ao servidor por
 * SSH já é dono do banco, então não há senha a conferir aqui.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Banco, prepararAcesso } from '../src/db.js';
import { gerarHash } from '../src/auth.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const iConfig = args.indexOf('--config');
const arqConfig = path.resolve(raiz, iConfig >= 0 ? args.splice(iConfig, 2)[1] || '' : 'config.json');
const login = String(args[0] || 'admin').trim();

if (!fs.existsSync(arqConfig)) {
  console.error(`configuração não encontrada: ${arqConfig}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(arqConfig, 'utf8'));
if (!config.historico?.arquivo) {
  console.error(`${arqConfig} não tem historico.arquivo`);
  process.exit(1);
}
const arqBanco = path.join(raiz, config.historico.arquivo);
if (!fs.existsSync(arqBanco)) {
  console.error(`banco não encontrado: ${arqBanco} (o serviço já subiu alguma vez?)`);
  process.exit(1);
}

const banco = new Banco(arqBanco);
prepararAcesso(banco.db);
const usuario = banco.db.prepare('SELECT id, login, papel FROM usuarios WHERE login = ?').get(login);
if (!usuario) {
  const logins = banco.listarUsuarios().map((u) => `${u.login} (${u.papel})`).join(', ');
  console.error(`usuário "${login}" não existe. Cadastrados: ${logins || 'nenhum'}`);
  process.exit(1);
}

const senha = crypto.randomBytes(9).toString('base64url');
const { sal, hash } = gerarHash(senha);
banco.atualizarUsuario(usuario.id, { hash, sal, ativo: 1, trocar_senha: 1 });
banco.encerrarSessoesDoUsuario(usuario.id);
banco.registrar('senha_redefinida', `${usuario.login} pela linha de comando do servidor`, null, 'servidor');
banco.db.close();

console.log(`Usuário: ${usuario.login} (${usuario.papel})`);
console.log(`Senha temporária: ${senha}`);
console.log('A troca é obrigatória no próximo login.');
