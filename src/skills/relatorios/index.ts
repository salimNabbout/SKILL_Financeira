// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const relatoriosSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "relatorios_gerenciais",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("relatorios_gerenciais", ctx, "not_implemented", "Skill relatorios_gerenciais ainda não implementada.");
  },
};
