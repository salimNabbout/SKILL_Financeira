# 12. Roadmap — MVP e versões seguintes

## MVP (esta entrega)

Escopo priorizado e implementado:

- Cadastros: empresa, usuários (papéis + alçadas), clientes, fornecedores, contas bancárias,
  categorias, centros de custo, plano de contas — com dados fictícios de demonstração.
- Contas a pagar e a receber completos (parcelas, juros/multa, idempotência, cancelamento).
- Fluxo de caixa realizado + projetado, cenários e alertas de insuficiência.
- Conciliação simplificada: importação OFX/CSV real, matching com confiança, revisão humana.
- Orçamento × realizado com desvios; DRE gerencial e indicadores.
- Cobrança com régua, aprovação e envio mock; indicadores de inadimplência.
- Dashboard executivo, central de alertas/pendências, central de aprovações.
- Orquestrador com 8 fluxos integrados, idempotência e trilha de auditoria imutável.
- Exportação CSV e PDF; API REST com OpenAPI; testes unitários/integração/E2E.

## v1.1 — Operação diária (4–6 semanas)

- ✅ Upload de arquivo real OFX/CSV na conciliação (UI e API multipart, detecção de formato e
  codificação) — entregue. Pendente: CNAB240 e agendamento de importação.
- Paginação/índices para volumetria (hoje: filtros em memória, ok até ~10⁴ registros/empresa).
- ✅ Gestão de usuários pela UI (convite mock com senha temporária, papel, alçada,
  ativar/desativar, guardas de último admin/autoedição) e troca de empresa na sessão —
  entregue. Pendente: convite por e-mail real (v1.2).
- Baixa parcial em conciliação (uma transação ↔ várias parcelas e vice-versa) e transferências
  entre contas.
- Exportação Excel (xlsx) além de CSV; relatórios agendados por e-mail.
- Fila real: EventBus sobre Redis/BullMQ com workers, retry e DLQ (mesma interface).

## v1.2 — Integrações reais (6–10 semanas)

- Open Finance / agregador bancário (Pluggy/Belvo) para extrato automático diário.
- Emissão de cobrança real: Pix (PSP), boleto registrado; webhooks de liquidação → baixa automática.
- NFS-e/NF-e via provedor (ex.: Focus NFe) substituindo o mock por adaptador real.
- Envio real da régua de cobrança (e-mail transacional + WhatsApp Business API) mantendo a
  aprovação humana obrigatória.
- Exportação contábil em layouts específicos (Domínio, Omie, Contmatic).

## v1.3 — Inteligência e escala

- IA com LLM real atrás da interface `AiClassifier` (classificação de lançamentos, explicações,
  resumo narrativo dos relatórios) com validação determinística, redação de dados sensíveis e
  política de privacidade LGPD para envio a terceiros.
- Previsão de fluxo de caixa com modelos estatísticos (sazonalidade) e detecção de anomalias
  aprendida (mantendo regras determinísticas como piso).
- SSO (Google/Microsoft), 2FA, políticas de senha; dupla aprovação configurável por faixa.
- Multi-moeda operacional (cotações, contas em moeda estrangeira).
- App mobile de aprovações (a API de aprovações já é o contrato).

## Critérios de corte do MVP (o que ficou explicitamente fora)

Pagamento bancário real, emissão fiscal real, envio real de mensagens, Open Finance, CNAB,
upload binário, gestão de usuários via UI, Excel nativo, filas distribuídas, SSO/2FA — todos
com fronteira de adaptador já desenhada (mocks/stubs identificados no código).
