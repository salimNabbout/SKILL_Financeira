// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const contasAReceberSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "contas_a_receber",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("contas_a_receber", ctx, "not_implemented", "Skill contas_a_receber ainda não implementada.");
  },
};
