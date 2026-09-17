import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { THEME_INIT, THEME_MAX_AGE, parseTheme, themeCookie } from "@/lib/theme";

/**
 * Roda o script inline do layout raiz num DOM mínimo simulado. É ele que decide
 * o tema na 1ª visita (sem cookie) — e que NÃO pode mexer quando o servidor já
 * renderizou `data-theme` a partir do cookie gravado pelo botão.
 */
function runInit(opts: {
  serverAttr?: string;
  storage?: string | null | "throw";
  osDark?: boolean;
  https?: boolean;
}) {
  const attrs: Record<string, string> = {};
  if (opts.serverAttr !== undefined) attrs["data-theme"] = opts.serverAttr;
  const cookies: string[] = [];
  const ctx = {
    document: {
      documentElement: {
        getAttribute: (k: string) => attrs[k] ?? null,
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
      },
      set cookie(v: string) {
        cookies.push(v);
      },
      get cookie() {
        return cookies.join("; ");
      },
    },
    localStorage: {
      getItem: () => {
        if (opts.storage === "throw") throw new Error("armazenamento bloqueado");
        return opts.storage ?? null;
      },
    },
    window: { matchMedia: () => ({ matches: Boolean(opts.osDark) }) },
    location: { protocol: opts.https ? "https:" : "http:" },
  };
  vm.runInNewContext(THEME_INIT, ctx);
  return { theme: attrs["data-theme"], cookies };
}

describe("tema — helpers", () => {
  it("parseTheme aceita só light/dark", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("auto")).toBeUndefined();
    expect(parseTheme("")).toBeUndefined();
    expect(parseTheme(undefined)).toBeUndefined();
    expect(parseTheme(null)).toBeUndefined();
  });

  it("themeCookie dura um ano, vale para o site inteiro e é Secure só em https", () => {
    expect(themeCookie("dark", true)).toBe(
      `theme=dark; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax; Secure`
    );
    expect(themeCookie("light", false)).toBe(`theme=light; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax`);
    expect(THEME_MAX_AGE).toBe(31_536_000);
  });
});

describe("tema — script inline (1ª pintura)", () => {
  it("com o tema já renderizado pelo servidor (cookie do botão), não mexe em nada — nem o sistema nem o localStorage interferem", () => {
    const r = runInit({ serverAttr: "dark", storage: "light", osDark: false });
    expect(r.theme).toBe("dark");
    expect(r.cookies).toEqual([]);

    const r2 = runInit({ serverAttr: "light", storage: "dark", osDark: true });
    expect(r2.theme).toBe("light");
    expect(r2.cookies).toEqual([]);
  });

  it("sem cookie: reaproveita a escolha legada do localStorage e grava o cookie (trava a escolha)", () => {
    const r = runInit({ storage: "dark", osDark: false });
    expect(r.theme).toBe("dark");
    expect(r.cookies).toEqual([`theme=dark; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax`]);
  });

  it("sem cookie e sem escolha salva: segue o sistema UMA vez e grava o cookie", () => {
    expect(runInit({ storage: null, osDark: true }).theme).toBe("dark");
    const claro = runInit({ storage: null, osDark: false });
    expect(claro.theme).toBe("light");
    expect(claro.cookies[0]).toMatch(/^theme=light; /);
  });

  it("localStorage bloqueado não impede a decisão", () => {
    const r = runInit({ storage: "throw", osDark: true });
    expect(r.theme).toBe("dark");
    expect(r.cookies).toHaveLength(1);
  });

  it("valor inválido vindo do servidor é tratado como ausente", () => {
    const r = runInit({ serverAttr: "banana", storage: "light", osDark: true });
    expect(r.theme).toBe("light");
    expect(r.cookies).toHaveLength(1);
  });

  it("em https o cookie leva Secure", () => {
    const r = runInit({ storage: "dark", https: true });
    expect(r.cookies[0]).toMatch(/; Secure$/);
  });
});
