# 10. Wireframes das telas

Layout base: barra lateral fixa (navegação + usuário/papel + sair) e conteúdo à direita.
Banner âmbar no topo em modo demonstração. Telas implementadas em `src/app/(app)/`.

## Dashboard executivo (`/`)

```
┌────────────┬──────────────────────────────────────────────────────────┐
│ Financeira │  Dashboard executivo                                     │
│ PME        │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│            │  │ Saldo    │ │Comprome- │ │ A pagar  │ │ A receber│     │
│ Dashboard  │  │disponível│ │  tido    │ │   7d     │ │    7d    │     │
│ C. a pagar │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│ C. receber │  ┌───────────────────────────┐ ┌───────────────────────┐ │
│ Faturamento│  │ ▓▓ Entradas × Saídas      │ │ ⚠ Alertas (5)         │ │
│ Fluxo caixa│  │ ▓▓ próximas 4 semanas     │ │ ● crítico: caixa…     │ │
│ Conciliação│  │ (gráfico de barras)       │ │ ● atraso: cliente…    │ │
│ Cobrança   │  └───────────────────────────┘ └───────────────────────┘ │
│ Orçamento  │  ┌───────────────────────────┐ ┌───────────────────────┐ │
│ DRE        │  │ ✔ Aprovações pendentes(2) │ │ Riscos & recomendações│ │
│ Indicadores│  │ Pagamento R$ 12.500 …     │ │ (visão executiva)     │ │
│ Aprovações │  └───────────────────────────┘ └───────────────────────┘ │
│ Alertas    │                                                          │
│ Relatórios │                                                          │
│ Cadastros  │  Ana Prado — Administradora            [Sair]            │
│ Auditoria  │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

## Contas a pagar (`/contas-a-pagar`)

```
Contas a pagar                                [filtros: Todos|Abertos|Pagos…]
┌ Novo título ──────────────────────────────────────────────────────────┐
│ Fornecedor ▼  Descrição____  Emissão__  Vencimento__  Valor R$____    │
│ Categoria ▼   Centro ▼       Parcelas_  [Criar título]                │
└───────────────────────────────────────────────────────────────────────┘
│ Fornecedor   Descrição       Parc. Vencim.    Valor      Pago  Status │
│ Torrefação   NF 8841 café    1/2  10/09/26  R$ 6.250,00   —   Aberto  │
│  └ Agendar pagamento: Conta ▼  Data__  Método ▼  [Agendar]            │
│ Energia S.A. Conta de luz    1/1  02/08/26  R$ 1.890,00   —   VENCIDO │
```

## Fluxo de caixa (`/fluxo-de-caixa`)

```
Fluxo de caixa                     [Diário] [Semanal] [Mensal]
┌ Projeção 90 dias (linha do saldo) ──────────────────────────┐
│      ___/\___                                               │
│  ___/        \____/\   ← menor saldo: R$ -3.200 em 12/09 ⚠  │
└─────────────────────────────────────────────────────────────┘
│ Período   Real.Entradas  Real.Saídas  Proj.Entr.  Proj.Saídas  Saldo acum. │
├ Cenários ─ Otimista: R$ 41k · Base: R$ 22k · Pessimista: R$ -8k ⚠ ─────────┤
├ Recomendações: antecipar recebíveis; renegociar NF 8841 …                  ┤
```

## Conciliação (`/conciliacao`)

```
Conciliação bancária
┌ Importar extrato ────────────────────────────────────────────┐
│ Conta ▼   Formato (OFX|CSV) ▼   [conteúdo do arquivo…]       │
│ [Importar e conciliar]                                       │
└──────────────────────────────────────────────────────────────┘
Sugestões pendentes (revisão humana)
│ 12/08 PIX RECEB CAFET LUA  R$ 2.400,00 ↔ Título CR #ar_10    │
│ confiança 78%                     [Confirmar] [Rejeitar]     │
Não conciliadas (8)  ·  Histórico de conciliações (30d)
```

## Aprovações (`/aprovacoes`)

```
Aprovações
│ PENDENTES                                                    │
│ Pagamento Torrefação — R$ 6.250,00 · solicitou: Carla        │
│ papel mínimo: Aprovador(a) · justificativa: [__________]     │
│                                  [✔ Aprovar]  [✘ Rejeitar]   │
│ HISTÓRICO: aprovada por Diego em 18/08 14:02 — "ok"          │
```

## DRE (`/dre`) e Indicadores (`/indicadores`)

```
DRE gerencial — Agosto/2026 (competência)      ◀ Jul | Ago | Set ▶
│ Receita bruta ............................ R$ 84.000,00      │
│ (−) Deduções ............................. R$  6.700,00      │
│ = Receita líquida ........................ R$ 77.300,00      │
│ (−) Custos ............................... R$ 31.200,00      │
│ = Lucro bruto ............................ R$ 46.100,00      │
│ (−) Despesas operacionais ................ R$ 28.400,00      │
│ = EBITDA gerencial ....................... R$ 17.700,00      │
│ (±) Resultado financeiro ................. R$ −1.150,00      │
│ = Resultado .............................. R$ 16.550,00      │

Indicadores: [Margem bruta 59,6%] [EBITDA R$ 17,7k] [Ponto de equilíbrio R$ 47,6k]
[Capital de giro R$ 38k] [Ciclo financeiro 18 dias]  — cada card: fórmula + explicação
```

## Demais telas

- **/contas-a-receber**: tabela + novo título + registrar recebimento (espelho do contas a pagar).
- **/faturamento**: faturas com status/NF-e mock + nova fatura (parcelas opcionais).
- **/cobranca**: botão "Rodar régua" → aprovação; mensagens com corpo expandível; indicadores e
  segmentação por risco. Aviso permanente: envio é mock.
- **/orcamento**: orçado × realizado com variações coloridas + edição do orçamento anual.
- **/alertas**: central de pendências por severidade com "Reconhecer".
- **/relatorios**: resumo diário, fechamento mensal, visão executiva + botões CSV/PDF.
- **/cadastros**: índice com cards → clientes, fornecedores, contas (número mascarado),
  categorias, centros de custo, plano de contas, usuários.
- **/auditoria**: trilha com verificação de integridade da cadeia no topo + filtros.
- **/login**: cartão central com credenciais demo em modo demonstração.
