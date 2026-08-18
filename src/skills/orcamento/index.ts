// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const orcamentoSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "orcamento_planejamento",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("orcamento_planejamento", ctx, "not_implemented", "Skill orcamento_planejamento ainda não implementada.");
  },
};
