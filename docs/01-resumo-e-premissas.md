# 1. Resumo da solução e premissas adotadas

## Resumo

**Financeira PME** é uma plataforma financeira para pequenas e médias empresas brasileiras
construída sobre uma arquitetura de **11 skills especializadas** (agentes de domínio) coordenadas
por um **orquestrador central**. Cada skill é dona de uma disciplina financeira (contas a pagar,
contas a receber, faturamento, tesouraria, conciliação, cobrança, orçamento, controladoria,
integração contábil, controles internos e relatórios), com contrato de entrada/saída padronizado
em JSON, indicador de confiança, lista de pendências, suposições explícitas e trilha de auditoria.

O orquestrador recebe as solicitações, identifica as skills necessárias, resolve a ordem e as
dependências, repassa contexto entre passos, garante **idempotência** (a mesma requisição nunca
gera lançamentos duplicados), aplica **permissões e alçadas**, suspende fluxos para **aprovação
humana** em operações sensíveis, valida a consistência entre resultados e consolida tudo em uma
resposta única que explica **quais dados foram usados e quais suposições foram feitas**.

Princípios estruturais:

- **Banco transacional como fonte oficial** (PostgreSQL via Prisma). Respostas de IA nunca são
  fonte de dados financeiros.
- **Regras financeiras determinísticas em código** (juros, alçadas, conciliação, DRE,
  indicadores — todos com fórmula, período e fonte declarados). IA é usada apenas para
  classificação sugerida, explicação e recomendação, atrás de uma interface plugável cujo
  provedor padrão é um mock heurístico identificado.
- **Arquitetura orientada a eventos**: as skills publicam eventos de domínio em um barramento
  in-process com outbox persistido (evolução natural para Redis/BullMQ sem mudar contrato).
- **Governança em primeiro lugar**: RBAC por empresa, segregação de funções (quem cria não
  aprova; quem solicita não aprova a própria solicitação), alçadas por valor, trilha de auditoria
  imutável com encadeamento de hash, e aprovação humana obrigatória para pagamentos, envio de
  cobranças e alterações sensíveis. **Nenhuma skill movimenta dinheiro sem aprovação humana
  verificável** — e, no MVP, toda "execução" bancária é mock declarado.
- **Multiempresa** desde o modelo de dados (todas as entidades são escopadas por `companyId`),
  valores em BRL como inteiros de centavos (estrutura pronta para outras moedas) e fuso horário
  configurável por empresa (padrão `America/Sao_Paulo`).

## Modos de execução

| Modo | Persistência | Uso |
|------|--------------|-----|
| `DEMO_MODE=1` | Adaptadores em memória + dados fictícios (Café Aurora Ltda) | Demonstração, desenvolvimento sem banco, testes E2E |
| Produção | PostgreSQL via Prisma (docker compose incluso) | Fonte oficial dos registros |

Ambos os modos executam **o mesmo domínio** — as skills e o orquestrador dependem apenas das
interfaces de repositório.

## Premissas adotadas (registradas, com racional)

1. **Execução bancária é mock.** Não há integração real com bancos, Pix, boleto ou cartão no MVP.
   O pagamento "executado" registra o fato aprovado no sistema; a conciliação com o extrato
   importado (OFX/CSV) é o que confirma a movimentação real. Adaptadores mock são claramente
   identificados (`api_mock`, `nfeMock.provider = "mock"`, envio de cobrança mock).
2. **NF-e/NFS-e é conceitual.** A skill de faturamento emite um documento com número e chave de
   acesso fictícios (`provider: "mock"`); a integração real com SEFAZ/prefeituras fica para
   versões futuras.
3. **Regras tributárias são dados de configuração** (`CompanyConfig.taxRules`), nunca código.
   Nenhuma alíquota é fixada; a validação final é sempre de um contador.
4. **Juros e multa por atraso**: política configurável por empresa (padrão: multa 2%, juros 1%
   a.m. *pro rata die*) — fórmula sempre exposta no resultado.
5. **DRE gerencial por competência** usando a data de emissão dos títulos e o grupo DRE da
   categoria; o fechamento mensal também traz uma visão simplificada por regime de caixa,
   com a distinção declarada. Sem depreciação/amortização no EBITDA gerencial (PME sem controle
   patrimonial no MVP).
6. **Custos fixos = despesas operacionais; variáveis = custos + deduções** — simplificação
   declarada para ponto de equilíbrio, ajustável quando houver marcação por categoria.
7. **Conciliação registra fatos**: quando um débito do extrato casa com um título a pagar, a
   baixa é registrada (o dinheiro já saiu do banco). A aprovação humana governa *ordens futuras*
   de pagamento, não fatos bancários já ocorridos.
8. **Alçadas padrão**: até R$ 5.000 → aprovador; até R$ 50.000 → gestor financeiro; acima →
   admin. Configurável por empresa (`approvalTiers`).
9. **Autenticação**: sessão assinada (HMAC) com senha scrypt, RBAC por empresa. Em produção
   recomenda-se IdP dedicado (roadmap).
10. **Fila de eventos in-process com outbox persistido** cumpre o papel de "Redis/BullMQ ou
    equivalente" no MVP; a interface `EventBus` permite trocar a implementação sem tocar nas skills.
11. **Moeda única BRL no MVP**; o modelo (`amountCents` + `currency`) já comporta múltiplas moedas,
    sem conversão implementada.
12. **Importação por colagem de conteúdo** (OFX/CSV como texto) no MVP; upload de arquivo e
    Open Finance ficam no roadmap. CNAB tem stub honesto que declara indisponibilidade.
