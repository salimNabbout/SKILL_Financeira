/** Registro central: todas as skills disponíveis para o orquestrador. */

import { SkillRegistry } from "@/core/orchestrator/registry";
import { contasAPagarSkill } from "./contas-a-pagar";
import { contasAReceberSkill } from "./contas-a-receber";
import { faturamentoSkill } from "./faturamento";
import { tesourariaSkill } from "./tesouraria";
import { conciliacaoSkill } from "./conciliacao";
import { cobrancaSkill } from "./cobranca";
import { orcamentoSkill } from "./orcamento";
import { controladoriaSkill } from "./controladoria";
import { contabilSkill } from "./contabil";
import { controlesInternosSkill } from "./controles-internos";
import { relatoriosSkill } from "./relatorios";

export function buildRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(contasAPagarSkill);
  registry.register(contasAReceberSkill);
  registry.register(faturamentoSkill);
  registry.register(tesourariaSkill);
  registry.register(conciliacaoSkill);
  registry.register(cobrancaSkill);
  registry.register(orcamentoSkill);
  registry.register(controladoriaSkill);
  registry.register(contabilSkill);
  registry.register(controlesInternosSkill);
  registry.register(relatoriosSkill);
  return registry;
}
