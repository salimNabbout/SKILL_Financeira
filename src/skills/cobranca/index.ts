// STUB — substituído pela implementação completa da skill.
import { z } from "zod";
import { errorResult, type SkillDefinition } from "@/core/skill";

const inputSchema = z.object({ action: z.string() }).passthrough();

export const cobrancaSkill: SkillDefinition<z.infer<typeof inputSchema>, unknown> = {
  name: "cobranca_inadimplencia",
  responsibility: "(stub)",
  objective: "(stub)",
  inputSchema,
  consumes: [],
  publishes: [],
  dataSources: [],
  async execute(ctx) {
    return errorResult("cobranca_inadimplencia", ctx, "not_implemented", "Skill cobranca_inadimplencia ainda não implementada.");
  },
};
