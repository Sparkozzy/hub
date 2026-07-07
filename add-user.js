// Script para adicionar usuários ao Hub MindFlow
// Uso: node add-user.js <username> <nome> <senha>
// Exemplo: node add-user.js pedro "Pedro Zimmermann" minhasenha123

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Uso: node add-user.js <username> "Nome Completo" <senha>');
  console.log('Exemplo: node add-user.js pedro "Pedro Zimmermann" minhasenha123');
  process.exit(1);
}

const [username, name, password] = args;
const usersPath = path.join(__dirname, 'users.json');

if (password.length < 6) {
  console.error('Erro: a senha deve ter no mínimo 6 caracteres.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));

const existing = users.find(u => u.username === username.toLowerCase());
if (existing) {
  console.log(`Usuário "${username}" já existe. Atualizando senha e nome...`);
  existing.password = hash;
  existing.name = name;
} else {
  users.push({ username: username.toLowerCase(), password: hash, name });
  console.log(`Usuário "${username}" adicionado.`);
}

fs.writeFileSync(usersPath, JSON.stringify(users, null, 2) + '\n');
console.log(`Nome: ${name}`);
console.log(`Login: ${username}`);
console.log('Pronto! Reinicie o servidor para aplicar.');
