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
- As **migrações** rodam sozinhas no start do container (entrypoint idempotente).

---

## 1. DNS

Aponte `financeira.cetemrj.com.br` (registro **A**) para o IP da VPS
(`2.25.132.128`). Espere propagar (`dig financeira.cetemrj.com.br` devolve o IP).

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
nano deploy/.env.prod          # preencha SESSION_SECRET e POSTGRES_PASSWORD
```

`deploy/.env.prod` está no `.gitignore` — **nunca** é versionado.

## 4. Subir app + banco

```bash
cd /opt/financeira/deploy
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

O build gera a imagem standalone; o entrypoint aplica as migrações (0001→0007) e
sobe o servidor. Acompanhe:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
```

Verifique que responde localmente (ainda sem HTTPS):

```bash
curl -sSf http://127.0.0.1:3000/login >/dev/null && echo "app OK"
```

> **Primeira publicação — dados iniciais:** o banco sobe vazio. Para popular a
> carga de demonstração (empresa fictícia Café Aurora) **uma vez**:
> ```bash
> docker compose -f docker-compose.prod.yml --env-file .env.prod exec app node -e "require('child_process').execSync('npx tsx prisma/seed.ts',{stdio:'inherit'})"
> ```
> Em uso real com dados próprios, **pule o seed** e crie a empresa/usuários pela aplicação.

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

```bash
cd /opt/financeira && git pull
cd deploy && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

O rebuild reaplica migrações pendentes automaticamente (idempotente).

## Operação

```bash
# logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
# reiniciar
docker compose -f docker-compose.prod.yml --env-file .env.prod restart app
# parar tudo (mantém o volume do banco)
docker compose -f docker-compose.prod.yml --env-file .env.prod down
# backup do banco (faça periodicamente)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql
```

## Rollback

`git checkout <commit-anterior>` e `up -d --build`. As migrações 0005–0007 são
aditivas — voltar o app não exige reverter o schema.

## Processos auxiliares (opcionais)

O scheduler (rotinas + reaper) e o worker BullMQ rodam como processos separados.
Para incluí-los, adicione serviços ao compose reusando a mesma imagem com
`command: npx tsx scripts/scheduler.ts` (e, para o worker, `EVENT_BUS=bullmq` +
um serviço Redis). Não são necessários para o app funcionar.
