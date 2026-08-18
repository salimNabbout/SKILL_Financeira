// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const conciliacaoSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "conciliacao_bancaria",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("conciliacao_bancaria", ctx, "not_implemented", "Skill conciliacao_bancaria ainda não implementada.");
  },
};
