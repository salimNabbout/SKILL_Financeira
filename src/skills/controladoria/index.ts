// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const controladoriaSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "controladoria_indicadores",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("controladoria_indicadores", ctx, "not_implemented", "Skill controladoria_indicadores ainda não implementada.");
  },
};
