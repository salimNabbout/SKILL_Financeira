# 17. Critérios de aceite e limitações conhecidas

## Critérios de aceite do MVP — como verificar cada um

Pré-requisito: `npm install` e `npm run demo` (modo demonstração, sem banco), login
`ana@cafeaurora.com.br` / `demo1234` (ou os demais usuários demo, por papel).
Automatizado: `npm test` (unitários + integração) e `npm run test:e2e` (smoke via navegador).

| # | Critério | Como verificar |
|---|---|---|
| 1 | Cadastrar empresa, usuários, clientes e fornecedores | Empresa e usuários vêm do seed multiperfil; clientes/fornecedores: **Cadastros → Clientes/Fornecedores → formulário** (ou `POST /api/v1/customers|suppliers`) |
| 2 | Registrar contas a pagar e receber | Telas **Contas a pagar / Contas a receber** (fluxo `supplier_invoice_intake` e skill AR); testes das skills cobrem parcelas/juros |
| 3 | Importar transações bancárias | **Conciliação → Importar extrato** colando OFX ou CSV (importadores reais testados); fluxo `bank_statement_import` |
| 4 | Conciliar automática ou manualmente | Após importar: casamentos exatos auto-conciliam; sugestões ficam para **Confirmar/Rejeitar** na mesma tela |
| 5 | Fluxo de caixa realizado e projetado | Tela **Fluxo de caixa** (extrato realizado + projeção 90d + cenários); teste da skill valida a matemática |
| 6 | Comparar orçamento e realizado | Tela **Orçamento** (seed traz orçamento anual com desvios plantados) |
| 7 | DRE gerencial simplificada | Tela **DRE** (competência) + DRE por caixa no fechamento mensal (**Relatórios**) |
| 8 | Fluxo integrado com ≥ 4 skills | `supplier_invoice_intake` encadeia AP → Controles → Tesouraria → Orçamento; `schedule_payment` encadeia 4 skills com aprovação; teste de integração `src/core/__tests__/flows.integration.test.ts` percorre a cadeia completa |
| 9 | Aprovação humana em operações sensíveis | Agendar pagamento ou rodar régua de cobrança → item em **Aprovações**; aprovar com outro usuário (segregação impede autoaprovação — teste automatizado) |
| 10 | Mesma requisição não duplica lançamentos | Reenviar o mesmo payload/`idempotencyKey` em `POST /flows/...` retorna `idempotent_replay: true`; `originKey` impede duplicata na skill; testes cobrem os dois níveis |
| 11 | Trilha completa de auditoria | Tela **Auditoria** (com verificação de integridade da cadeia de hash) ou `GET /api/v1/audit` |
| 12 | Testes e execução com instruções claras | `npm test`, `npm run typecheck`, `npm run test:e2e`; instruções no README (modo demo e modo PostgreSQL) |

## Limitações conhecidas (MVP)

**Integrações são mocks/stubs identificados**
- Execução bancária de pagamento, NF-e/NFS-e, envio de e-mail/WhatsApp da cobrança e sincronização
  de extrato: mocks declarados (nenhum efeito externo). Desde a v1.2 essas fronteiras são portas
  formais (`BankDataProvider`, `ChargeProvider`, `FiscalProvider`, `MessagingProvider` em
  `src/core/integrations.ts`) com adaptadores mock determinísticos selecionados por env
  (`INTEGRATION_*="mock"`, o padrão); declarar um provedor real não implementado falha alto na
  inicialização — o mock nunca é fallback silencioso. A emissão de cobrança Pix/boleto por título
  (UI e `POST /receivables/{id}/charge`) e o fluxo `bank_sync` geram códigos/extratos FAKE: nada
  é registrado em PSP ou banco; a liquidação real continua entrando pela conciliação do extrato.
  Importação real por upload de arquivo OFX, CSV ou CNAB240 (até 2 MB, detecção automática de
  formato e codificação UTF-8/ISO-8859-1) ou texto colado. O CNAB240 implementa o segmento E
  (extrato) no layout FEBRABAN de referência — bancos publicam variantes; ajustes por banco
  entram como configuração futura (as posições estão em constantes documentadas).

**Escopo funcional**
- Multiempresa operacional: troca de empresa na sessão pela barra lateral e gestão de usuários
  pela UI (convite mock com senha temporária — e-mail real na v1.2 —, papel, alçada,
  ativar/desativar, com guardas de governança). Multi-moeda: estrutura pronta, sem conversão.
  Exportação em CSV, Excel (xlsx nativo) e PDF nos relatórios.
- Conciliação: além do casamento 1↔1, cobre baixas parciais (sempre com revisão humana), rateio
  de uma transação entre 2–4 parcelas da mesma contraparte (soma exata) e transferências entre
  contas (pares opostos). Fora do escopo: rateio com soma aproximada e N transações agrupadas
  para 1 título numa mesma decisão (parciais sequenciais cobrem o caso comum). DRE por
  competência usa data de emissão dos títulos; sem depreciação no EBITDA.
- Orçamento por categoria×mês (centro de custo aceito no modelo; a UI edita por categoria).
- Previsão estatística de caixa (`forecast_cash`) é ESTIMATIVA determinística sobre o histórico
  semanal do extrato (mediana, tendência Theil–Sen, sazonalidade só com ≥ 52 semanas, banda
  ± MAD×1.4826×√k): rotulada como estimativa nas respostas, com o comprometido por títulos como
  piso; nenhuma decisão automática deriva dela. Com menos de 8 semanas de histórico a parte
  estatística é zerada e o resultado sinaliza warning.

**Técnica**
- Barramento de eventos é in-process com outbox persistido (BullMQ/Redis na v1.1); os fluxos do
  orquestrador materializam as reações — não há workers assíncronos.
- Listagens filtram em memória em vários pontos — adequado a ~10⁴ registros por empresa;
  paginação/índices adicionais na v1.1.
- Autenticação própria (scrypt + cookie HMAC, sessão 8h) com 2FA TOTP opcional por usuário e
  política de senha configurável por empresa — recomenda-se IdP/SSO em produção.
- Modo demo mantém dados em memória (reinicia com o servidor); o modo PostgreSQL é a fonte
  oficial. Testes de repositório Prisma são de tipo/contrato (sem banco no ambiente de CI desta
  entrega); recomenda-se um smoke com banco real antes do primeiro deploy.
- IA é heurística local (mock identificado): sugestão de categoria por palavras-chave; nenhuma
  decisão automática deriva dela.

**Segurança/LGPD**
- Criptografia em repouso delegada ao PostgreSQL/infra (colunas não são cifradas
  individualmente); dados bancários entram apenas mascarados. 2FA TOTP disponível por usuário
  (tela Segurança); dupla aprovação por faixa de alçada configurável por empresa. Política de
  retenção/eliminação LGPD definida como pergunta em aberto (doc 02).
