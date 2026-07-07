# MindFlow Hub — Instruções para Deploy no Easypanel

## O que é este projeto

Hub interno de plataformas MindFlow. Substitui o dashboard Python antigo por uma versão completa em Node.js com:

- **Login seguro** via Supabase Auth (e-mail + senha)
- **Hub de plataformas** — cards com links rápidos para todas as ferramentas (Supabase, n8n, GitHub, Retell, etc.)
- **Dashboard de métricas** — gráficos e estatísticas de ligações (funil, fadiga, desconexões, horários) com Chart.js
- **Disparo de ligação** — formulário para acionar chamadas via webhook
- **Recuperação de senha** — fluxo completo de "Esqueci minha senha" com token

> **Diferença do dashboard Python antigo:** o hub Node.js lê os dados **diretamente do Supabase em tempo real**, sem precisar de ETL agendado. Os dados são os mesmos (tabela `Retell_calls_Mindflow`).

---

## Sistema de Login — Explicação Completa

### Como a autenticação funciona

O hub usa **Supabase Auth** para gerenciar todos os logins. Não existe arquivo local de usuários nem senhas armazenadas no servidor.

**Fluxo passo a passo:**

1. Usuário acessa o hub e vê a tela de login
2. Digita **e-mail** e **senha** e clica em "Entrar"
3. O servidor (Express) envia uma requisição para o Supabase:
   ```
   POST https://ghayhpwthdbmnpsptcnb.supabase.co/auth/v1/token?grant_type=password
   ```
4. O Supabase valida as credenciais e retorna:
   - **Sucesso:** dados do usuário + token de sessão
   - **Falha:** erro genérico "E-mail ou senha inválidos" (nunca revela se o e-mail existe)
5. Se o login for bem-sucedido, o servidor cria uma **sessão local** usando `express-session`
6. O navegador recebe um **cookie de sessão** e é redirecionado para o dashboard

**Por que dois níveis de sessão?** (Supabase + Express)

O Supabase gerencia a autenticação em si (valida senha). O Express gerencia a sessão do usuário no servidor (quem está logado). Isso permite:
- O servidor saber quem está logado sem consultar o Supabase a cada requisição
- Controlar o tempo de sessão (8 horas) independentemente do token do Supabase
- Destruir a sessão no logout de forma instantânea

### Gerenciamento de Usuários

Os usuários são criados **exclusivamente pelo painel do Supabase**:

```
https://supabase.com/dashboard/project/ghayhpwthdbmnpsptcnb/auth/users
```

Lá o administrador pode:
- **Criar usuário:** botão "Add User" → informa e-mail + senha temporária
- **Desativar usuário:** o acesso dele para de funcionar imediatamente
- **Excluir usuário:** remove permanentemente
- **Ver histórico:** data do último login, endereço IP, provedor usado

> **Usuários já criados:** Pedro Zimmermann (pedroernestozimmermann@gmail.com) + 7 usuários @mindflow-ia.com. Senhas na planilha de acessos.

### Fluxo de Recuperação de Senha

1. Usuário clica em **"Esqueci minha senha"** na tela de login
2. É redirecionado para `/redefinir-senha`
3. Digita o e-mail e clica em "Enviar link de recuperação"
4. O Supabase envia um **e-mail com token de recuperação** para o endereço cadastrado
5. Ao clicar no link do e-mail, o usuário chega na página com o token pré-preenchido na URL
6. Define a **nova senha** (com validação de força: fraca / média / forte)
7. A senha é atualizada no Supabase e o usuário pode fazer login normalmente

**Pré-requisito para e-mails funcionarem:** é necessário configurar um provedor SMTP no Supabase:
- Supabase > Authentication > Providers > Custom SMTP
- Pode usar SendGrid, Resend, Amazon SES, ou qualquer SMTP
- Sem SMTP configurado, os e-mails de recuperação **não serão enviados**

---

## Segurança — Explicação Detalhada

### 1. Proteção de Sessão (express-session)

A sessão do usuário é armazenada **apenas no servidor** (em memória). O navegador guarda apenas um **cookie criptografado** que identifica a sessão.

Configurações de segurança do cookie:

| Propriedade | Valor | Por quê |
|---|---|---|
| `httpOnly: true` | Não acessível via JavaScript | Impede roubo de sessão por XSS (Cross-Site Scripting) |
| `secure: true` (produção) | Só enviado via HTTPS | Impede interceptação em redes inseguras (Man-in-the-Middle) |
| `sameSite: strict` (produção) | Não enviado em requisições de outros sites | Impede ataques CSRF (Cross-Site Request Forgery) |
| `maxAge: 8 horas` | Sessão expira automaticamente | Limita a janela de uso caso o cookie seja comprometido |

### 2. Rate Limiting (proteção contra força bruta)

Na rota de login (`/api/login`):

- **Máximo 10 tentativas** por IP a cada 15 minutos
- Tentativas **bem-sucedidas não são contadas** (só falhas)
- Após atingir o limite, o IP fica bloqueado por 15 minutos
- O usuário recebe a mensagem: *"Muitas tentativas de login. Tente novamente em 15 minutos."*

Isso impede que um atacante tente milhares de senhas automaticamente.

### 3. Helmet (proteção de cabeçalhos HTTP)

O `helmet` é um middleware que configura cabeçalhos HTTP de segurança automaticamente:

- **X-Content-Type-Options:** evita que o navegador "adivinhe" o tipo de arquivo
- **X-Frame-Options:** impede que o site seja exibido dentro de um iframe (clickjacking)
- **Strict-Transport-Security:** força conexão HTTPS no navegador
- **X-XSS-Protection:** ativa proteção contra Cross-Site Scripting no navegador

### 4. Validação de Ambiente

Ao iniciar, o servidor verifica:

```
NODE_ENV=production → SESSION_SECRET precisa ser forte (mínimo 32 chars, sem "troque-isso")
SUPABASE_URL e SUPABASE_KEY → obrigatórias em qualquer ambiente
```

Se alguma validação falhar, o servidor **não inicia** — evita rodar em produção com configurações inseguras.

### 5. Chave Anon vs Service Role (⚠️ CRÍTICO)

O Supabase fornece duas chaves:

| Chave | Acesso | Uso correto |
|---|---|---|
| **anon** (`eyJ...`) | Dados públicos, respeita regras de segurança (RLS) | **Usar no hub** |
| **service_role** (`eyJ...`) | Acesso total ao banco, ignora RLS | **NUNCA usar no frontend ou servidor web** |

**O Easypanel pode estar usando a `service_role` como `SUPABASE_KEY`.** Se estiver:
- Qualquer pessoa pode ler, alterar ou deletar **todas as tabelas do banco**
- As regras de segurança (RLS) do Supabase são ignoradas
- Um vazamento dessa chave expõe todo o banco de dados

**Ação necessária:** trocar `SUPABASE_KEY` para a chave **anon** nas variáveis de ambiente do Easypanel.

### 6. Limpeza de arquivos legados

Os arquivos antigos (`users.json`, `add-user.js`) foram removidos. Eles não são mais usados — toda autenticação passa pelo Supabase. Manter arquivos com estrutura de senhas (mesmo que obsoletos) é um risco de segurança desnecessário.

### 7. Rate Limiting no Disparo de Ligações

A rota de disparo (`/api/submit-lead`) também tem proteção:
- **Máximo 30 requisições** por IP a cada 15 minutos
- Impede que um usuário mal-intencionado ou um bug dispare centenas de ligações

### 8. Sessão expira automaticamente

- O cookie de sessão expira após **8 horas** de inatividade
- O logout destrói a sessão **no servidor e no Supabase** (invalida o token)
- Após o logout, o cookie não é mais aceito

---

## ⚠️ Checklist de Segurança (obrigatório antes de ir ao ar)

- [ ] `SUPABASE_KEY` no Easypanel é a chave **anon**, não a service_role
- [ ] `SESSION_SECRET` é uma string aleatória forte de 32+ caracteres
- [ ] `NODE_ENV=production` (ativa HTTPS forçado e cookies seguros)
- [ ] Site URL configurada no Supabase Authentication apontando para a URL de produção
- [ ] SMTP configurado no Supabase para e-mails de recuperação de senha

---

## Variáveis de Ambiente (configurar no Easypanel)

| Variável | Obrigatória | Descrição | Valor |
|---|---|---|---|
| `SUPABASE_URL` | Sim | URL do projeto Supabase | `https://ghayhpwthdbmnpsptcnb.supabase.co` |
| `SUPABASE_KEY` | Sim | Chave **anon** (começa com `eyJ...`) | Extrair do Supabase > Settings > API > anon public |
| `SESSION_SECRET` | Sim | String aleatória forte (mín. 32 chars) | Gerar com `openssl rand -hex 32` |
| `NODE_ENV` | Sim | Ambiente de execução | `production` |
| `PORT` | Não | Porta do servidor | `3000` (default) |
| `WEBHOOK_URL` | Não | URL da API de disparo | `https://call-github.bkpxmb.easypanel.host/webhook` |
| `WEBHOOK_API_KEY` | Não | Chave da API de disparo | Conforme configurado no webhook |

## Configuração no Supabase

### Authentication > URL Configuration
1. **Site URL:** colocar a URL de produção do hub (ex: `https://hub.bkpxmb.easypanel.host`)
2. **Redirect URLs:** adicionar a mesma URL de produção

Link direto:  
https://supabase.com/dashboard/project/ghayhpwthdbmnpsptcnb/auth/url-configuration

### Authentication > Providers
Garantir que o provedor **Email** está habilitado (é o default).

### Authentication > SMTP (para e-mails de recuperação)
Configurar um provedor SMTP para que o Supabase possa enviar e-mails de recuperação de senha. Opções gratuitas:
- **Resend:** https://resend.com (plano gratuito: 100 e-mails/dia)
- **SendGrid:** https://sendgrid.com (plano gratuito: 100 e-mails/dia)

---

## Dockerfile

O projeto já inclui um `Dockerfile` otimizado para Node.js 18 Alpine.
Porta exposta: **3000**

## Testar localmente

```bash
cd Hub\ integrado\ mindflow/
cp .env.example .env      # preencher as credenciais
npm install
npm run dev               # http://localhost:3000
```

Login de teste: `pedroernestozimmermann@gmail.com` / senha na planilha de acessos.
Em desenvolvimento, também pode acessar `http://localhost:3000/dev-login` para bypass.

## Estrutura de arquivos

```
Hub integrado mindflow/
├── server.js              # Servidor Express com todas as rotas
├── index.html             # Tela de login
├── redefinir-senha.html   # Fluxo de recuperação de senha
├── hub.html               # Hub de plataformas
├── dashboard.html         # Dashboard de métricas
├── dashboard-app.js       # Lógica do dashboard
├── dashboard-style.css    # Estilos do dashboard
├── disparo.html           # Formulário de disparo de ligação
├── package.json           # Dependências
├── Dockerfile             # Build para Easypanel
├── .env.example           # Template de variáveis de ambiente
└── INSTRUCOES_DEPLOY.md   # Este arquivo
```

> Projeto desenvolvido por Pedro Zimmermann — MindFlow
