// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const contabilSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "integracao_contabil_fiscal",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("integracao_contabil_fiscal", ctx, "not_implemented", "Skill integracao_contabil_fiscal ainda não implementada.");
  },
};
