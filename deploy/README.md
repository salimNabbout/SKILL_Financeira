# Publicação — financeira.cetemrj.com.br (VPS Hostinger, tudo em Docker)

Este app é **Next.js com servidor + PostgreSQL** — diferente dos outros sites da
VPS (Kanban, Planejador, etc.), que são HTML estático servido pelo nginx. Aqui,
o app e o banco rodam em **containers Docker isolados**, e o nginx existente só
ganha **um vhost novo** que faz proxy reverso. Nada toca o docroot dos outros sites.

> **VPS compartilhada — cuidado.** A mesma máquina serve outros sites. Este
> deploy **só adiciona**: containers próprios + um arquivo de vhost novo em
> `sites-available`. Não edite os vhosts nem os `/var/www/*` dos outros sites.

Pré-requisitos na VPS: **Docker + Docker Compose plugin** e **nginx** (já presente).

---

## Visão geral

```
Internet ──▶ nginx (VPS, :443 HTTPS) ──▶ 127.0.0.1:3000 (container app) ──▶ container db (Postgres, rede interna)
             financeira.cetemrj.com.br
```

- O container **app** só escuta em `127.0.0.1:3000` — não fica exposto na internet.
- O container **db** não publica porta nenhuma — só a rede interna do compose o alcança.
- As **migrações** rodam num serviço `migrate` próprio, que executa
  `prisma migrate deploy` (idempotente) e sai; o `app` só sobe depois que ele
  termina com sucesso.

---

## 1. DNS

Aponte `financeira.cetemrj.com.br` (registro **A**) para o IP público da sua VPS.
Espere propagar (`dig +short financeira.cetemrj.com.br` deve devolver esse IP).

## 2. Enviar o código para a VPS

Clone (ou `git pull`) o repositório na VPS, por ex. em `/opt/financeira`:

```bash
sudo mkdir -p /opt/financeira && sudo chown "$USER" /opt/financeira
git clone https://github.com/salimNabbout/SKILL_Financeira.git /opt/financeira
cd /opt/financeira
```

## 3. Configurar o ambiente de produção

```bash
cp deploy/.env.prod.example deploy/.env.prod
# Gere o segredo de sessão e uma senha forte de banco:
openssl rand -base64 48        # → SESSION_SECRET
openssl rand -base64 24        # → POSTGRES_PASSWORD
openssl rand -base64 24        # → APP_DB_PASSWORD
nano deploy/.env.prod          # preencha os três
```

`deploy/.env.prod` está no `.gitignore` — **nunca** é versionado.

### Duas credenciais de banco, de propósito

`POSTGRES_USER` é **superusuário** (a imagem oficial do Postgres o cria assim) e
fica só para o container `migrate`, que cria e altera tabelas.

`APP_DB_USER` é a role **restrita** que o `app` e o `scheduler` usam: sem
superpoderes e **sem permissão de alterar ou apagar a trilha de auditoria**.
Superusuário ignora `GRANT`/`REVOKE` e pode desligar gatilho — por isso a
separação existe. Detalhes em [docs/auditoria-hardening.md](../docs/auditoria-hardening.md).

Crie a role uma vez por ambiente, depois de preencher o `.env.prod` e de o banco
estar de pé:

```bash
deploy/criar-role-app.sh
```

O script cria a role, aplica os privilégios e confere, conectando **como ela**,
que um `UPDATE` na trilha é recusado. Rodar de novo é seguro: só troca a senha.

Enquanto `APP_DB_USER`/`APP_DB_PASSWORD` não existirem, `publicar.sh` cai no
usuário dono e avisa — o deploy funciona, sem esta proteção.

## 4. Subir app + banco

```bash
cd /opt/financeira/deploy
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

O build gera a imagem standalone; o serviço `migrate` aplica as migrações
(0001→0007) e sai; então o `app` sobe. Acompanhe:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
```

Verifique que responde localmente (ainda sem HTTPS):

```bash
curl -sSf http://127.0.0.1:3000/login >/dev/null && echo "app OK"
```

> **Primeira publicação — primeiro acesso:** o banco sobe vazio (sem usuários).
> Rode um dos dois no container `migrate` (que tem `tsx` + `src/`):
>
> **(a) Uso real** — cria a SUA empresa + admin (recomendado):
> ```bash
> docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
>   -e COMPANY_NAME="Minha Empresa Ltda" -e COMPANY_CNPJ="00.000.000/0001-00" \
>   -e ADMIN_NAME="Seu Nome" -e ADMIN_EMAIL="voce@empresa.com" -e ADMIN_PASSWORD="senhaForte" \
>   migrate npx tsx scripts/create-admin.ts
> ```
>
> **(b) Demonstração** — dados fictícios (Café Aurora, login `ana@cafeaurora.com.br` / `demo1234`):
> ```bash
> docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate npx tsx prisma/seed.ts
> ```

## 5. nginx + HTTPS

```bash
sudo cp /opt/financeira/deploy/nginx-financeira.conf /etc/nginx/sites-available/financeira.conf
sudo ln -s /etc/nginx/sites-available/financeira.conf /etc/nginx/sites-enabled/
sudo nginx -t                       # valida SEM afetar os outros vhosts
sudo systemctl reload nginx
sudo certbot --nginx -d financeira.cetemrj.com.br   # emite o certificado e ativa 443
```

O `certbot` reescreve o vhost para adicionar o bloco HTTPS e o redirect 80→443.
O cookie de sessão é `secure` — **só funciona sob HTTPS**, então esse passo é obrigatório.

## 6. Verificação pós-deploy

- [ ] `https://financeira.cetemrj.com.br/login` abre (cadeado válido).
- [ ] Login funciona e a sessão persiste após navegar.
- [ ] A página `/auditoria` mostra a cadeia de hash íntegra.
- [ ] Os **outros sites da VPS continuam no ar** (Kanban, Planejador, etc.).

Ver também `docs/DEPLOY.md` (checklist geral) e §8 (ligar integrações reais).

---

## Atualizar (novas versões)

**Recomendado — script `publicar.sh`** (um comando, faz tudo e verifica):

```bash
# Da sua máquina, com o atalho SSH "financeira" no ~/.ssh/config:
ssh financeira "/opt/financeira/deploy/publicar.sh"

# Ou já dentro da VPS:
/opt/financeira/deploy/publicar.sh
```

O [`publicar.sh`](publicar.sh) faz: `git fetch` + `reset --hard origin/main` → `build app migrate`
→ `up -d --force-recreate app` (o app depende do serviço `migrate`, então migrações pendentes são
aplicadas automaticamente antes de subir) → aguarda o app responder `200` em `/login` e mostra o
commit publicado. Para com erro claro se algo falhar.

Atalho SSH (no `~/.ssh/config` da sua máquina Windows/Linux), para `ssh financeira` sem senha/IP:

```
Host financeira
    HostName 2.25.132.128
    User root
    IdentityFile ~/.ssh/financeira_key
```

**Manual (alternativa):**

```bash
cd /opt/financeira && git fetch origin main && git reset --hard origin/main
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod build app migrate scheduler
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --force-recreate app scheduler
```

O `up --force-recreate` reaplica migrações pendentes automaticamente (app e scheduler dependem do `migrate`).

## Agendador (scheduler)

O serviço **`scheduler`** roda `scripts/scheduler.ts` continuamente (`restart: unless-stopped`) e dispara as rotinas nas horas locais configuradas: **recorrência de títulos (5h)**, sincronização bancária (6h), resumo diário (7h) e régua de cobrança (8h). Sem ele, essas rotinas **não** executam sozinhas. É idempotente (não duplica títulos/rotinas) e seguro (cobrança só agenda mensagens; pagamentos param em aprovação).

```bash
# logs do agendador
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f scheduler
# forçar disparo mais rápido para testar (intervalo em ms; default 60000)
# (definir SCHEDULER_INTERVAL_MS no serviço scheduler do compose)
```

## Operação

```bash
# logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
# reiniciar
docker compose -f docker-compose.prod.yml --env-file .env.prod restart app
# parar tudo (mantém o volume do banco)
docker compose -f docker-compose.prod.yml --env-file .env.prod down
# backup avulso do banco (o diário é automático — ver abaixo)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql
```

## Backup diário automático

O script [`backup.sh`](backup.sh) faz o dump do Postgres, **valida antes de aceitar** (exige o
marcador final do `pg_dump` e um tamanho mínimo — um dump truncado é descartado em vez de entrar
na rotação), comprime e aplica retenção de 14 diários + 12 mensais em `/var/backups/financeira`
(diretório `700`, arquivos `600`). O log fica em `/var/log/financeira-backup.log`.

Instalar (uma vez, na VPS):

```bash
chmod 700 /opt/financeira/deploy/backup.sh
/opt/financeira/deploy/backup.sh          # testar antes de agendar
cat /var/log/financeira-backup.log        # deve terminar com uma linha "OK:"

printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n30 2 * * * root /opt/financeira/deploy/backup.sh\n' \
  > /etc/cron.d/financeira-backup
chmod 644 /etc/cron.d/financeira-backup
systemctl restart cron
```

Restaurar (o dump usa `--clean --if-exists`, então **substitui** o conteúdo atual):

```bash
gunzip -c /var/backups/financeira/financeira-AAAA-MM-DD_HHMM.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

> ⚠️ Os backups ficam **na mesma VPS do banco**: protegem contra erro humano e migração ruim, não
> contra a perda da máquina. Uma cópia off-site continua pendente.

## Rollback

`git checkout <commit-anterior>` e `up -d --build`. As migrações 0005–0007 são
aditivas — voltar o app não exige reverter o schema.

## Processos auxiliares (opcionais)

O scheduler (rotinas + reaper) e o worker BullMQ rodam como processos separados.
Para incluí-los, adicione serviços ao compose reusando a mesma imagem com
`command: npx tsx scripts/scheduler.ts` (e, para o worker, `EVENT_BUS=bullmq` +
um serviço Redis). Não são necessários para o app funcionar.

---

## Problemas resolvidos no primeiro deploy (referência)

Registro do que apareceu ao publicar de verdade, e como foi resolvido — caso
ressurja num ambiente novo:

- **Migração falhava com `ENOENT ...prisma_schema_build_bg.wasm` / `Cannot find
  module 'effect'`.** A CLI do Prisma tem uma árvore de deps que não cabe na
  imagem enxuta do app. Solução: rodar as migrações num serviço `migrate`
  separado, com `node_modules` completo (é o que este compose já faz).
- **App acessível, mas o login dava `Invalid Server Actions request`.** O Next 15
  compara `Host`×`Origin`; atrás do nginx o `Host` chegava como FQDN com ponto
  final (`dominio.com.`). Solução: o vhost envia `Host`/`X-Forwarded-Host` do
  domínio limpo (fixo, sem `$host`) — já aplicado em `nginx-financeira.conf`.
- **Domínio em HTTPS mostrava OUTRO site da VPS.** Antes de rodar o `certbot`,
  não existia vhost 443 para este domínio, e o nginx caía no vhost 443 default
  (de outro site). Rodar o `certbot` cria o vhost HTTPS correto e resolve o
  roteamento. Por HTTP (porta 80) o roteamento já estava certo.
- **Colar comandos longos no terminal SSH corrompia** (caracteres `^M` /
  `^[[200~`). Digitar comandos curtos, um por vez, contorna. Alternativa: rodar
  via `ssh host "comando"` do PowerShell para comandos simples (sem `$`/aspas).
