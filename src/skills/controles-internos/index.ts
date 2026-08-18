// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const controlesInternosSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "controles_internos_auditoria",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("controles_internos_auditoria", ctx, "not_implemented", "Skill controles_internos_auditoria ainda não implementada.");
  },
};
