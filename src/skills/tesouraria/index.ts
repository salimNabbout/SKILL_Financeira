// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const tesourariaSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "tesouraria_fluxo_caixa",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("tesouraria_fluxo_caixa", ctx, "not_implemented", "Skill tesouraria_fluxo_caixa ainda não implementada.");
  },
};
