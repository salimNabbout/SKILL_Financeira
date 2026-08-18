// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const faturamentoSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "faturamento",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("faturamento", ctx, "not_implemented", "Skill faturamento ainda não implementada.");
  },
};
