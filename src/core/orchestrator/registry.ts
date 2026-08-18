/** Registro central de skills — o orquestrador só conhece skills registradas aqui. */

import type { SkillDefinition, SkillName } from "../skill";
import { NotFoundError } from "../errors";

export class SkillRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private skills = new Map<SkillName, SkillDefinition<any, any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(def: SkillDefinition<any, any>): void {
    if (this.skills.has(def.name)) {
      throw new Error(`Skill já registrada: ${def.name}`);
    }
    this.skills.set(def.name, def);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: SkillName): SkillDefinition<any, any> {
    const def = this.skills.get(name);
    if (!def) throw new NotFoundError("Skill", name);
    return def;
  }

  has(name: SkillName): boolean {
    return this.skills.has(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): SkillDefinition<any, any>[] {
    return [...this.skills.values()];
  }
}
