# 2. Perguntas essenciais em aberto

O desenvolvimento **não foi interrompido** por nenhuma delas — para cada uma foi assumida uma
opção razoável (registrada em `01-resumo-e-premissas.md` e nas `assumptions` das skills). As
respostas refinarão o produto:

## Negócio e escopo

1. **Regime tributário predominante dos clientes?** (Simples Nacional, Lucro Presumido, Real.)
   Afeta `taxRules`, deduções na DRE e o resumo fiscal informativo. *Assumido: Simples Nacional
   como configuração de exemplo, sem cálculo de imposto.*
2. **Quem aprova o quê?** As alçadas padrão (R$ 5k/50k) refletem a realidade dos clientes-alvo?
   Deve haver dupla aprovação acima de certo valor? *Assumido: alçada única por faixa.*
3. **Padrão de parcelamento**: parcelas mensais a partir do vencimento informado atendem?
   Há necessidade de calendários (dia fixo, útil seguinte)? *Assumido: mensal simples; sem
   ajuste por dia útil/feriado.*
4. **Régua de cobrança**: os degraus 3/10/30 dias e os textos padrão estão adequados ao tom da
   empresa? WhatsApp é canal prioritário? *Assumido: e-mail; WhatsApp como canal mock.*
5. **Multi-moeda é requisito real** de curto prazo ou apenas preparação estrutural?

## Integrações

6. **Quais bancos e via qual caminho** (Open Finance regulado, agregador — Pluggy/Belvo —, ou
   OFX manual)? Define o roadmap da conciliação automática contínua.
7. **Qual sistema contábil receberá as exportações** (Domínio, Contmatic, Omie...)? Define o
   layout do lote além do CSV genérico.
8. **Emissão fiscal**: NFS-e municipal (qual município?) ou NF-e produto? Emissor próprio ou
   API de terceiros (ex.: Focus NFe)?

## Segurança e conformidade

9. **Requisitos de retenção e eliminação de dados (LGPD)**: prazo de guarda de títulos,
   mensagens de cobrança e trilha de auditoria por empresa encerrada?
10. **SSO/IdP corporativo** é necessário (Google Workspace/Microsoft) ou login próprio basta?
11. **Backup/DR**: RPO/RTO esperados para o banco transacional?

## Produto

12. **Volumetria esperada** (títulos/mês, transações bancárias/mês) para dimensionar índices e
    paginação — o MVP filtra em memória em vários pontos, adequado até ~10⁴ registros por empresa.
13. **IA com LLM real**: há apetite (e orçamento) para classificação/explicação via provedor LLM,
    ou o heurístico basta no início? Qual política de dados para envio a terceiros?
