import { describe, expect, it } from "vitest";
import { isForbiddenCrossSiteMutation } from "../csrf";

function req(method: string, url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

describe("isForbiddenCrossSiteMutation", () => {
  it("bloqueia POST em /api/v1 com Origin de outro host", () => {
    const r = req("POST", "https://app.exemplo.com/api/v1/payables", {
      origin: "https://malicioso.tld",
    });
    expect(isForbiddenCrossSiteMutation(r)).toBe(true);
  });

  it("permite POST em /api/v1 com Origin do mesmo host", () => {
    const r = req("POST", "https://app.exemplo.com/api/v1/payables", {
      origin: "https://app.exemplo.com",
    });
    expect(isForbiddenCrossSiteMutation(r)).toBe(false);
  });

  it("permite métodos seguros (GET) mesmo com Origin de outro host", () => {
    const r = req("GET", "https://app.exemplo.com/api/v1/payables", {
      origin: "https://malicioso.tld",
    });
    expect(isForbiddenCrossSiteMutation(r)).toBe(false);
  });

  it("permite mutação sem header Origin (cliente não-navegador / mesma origem)", () => {
    const r = req("POST", "https://app.exemplo.com/api/v1/payables");
    expect(isForbiddenCrossSiteMutation(r)).toBe(false);
  });

  it("não interfere fora de /api/v1", () => {
    const r = req("POST", "https://app.exemplo.com/login", {
      origin: "https://malicioso.tld",
    });
    expect(isForbiddenCrossSiteMutation(r)).toBe(false);
  });

  it("usa Sec-Fetch-Site=cross-site como sinal quando presente", () => {
    const r = req("POST", "https://app.exemplo.com/api/v1/payables", {
      "sec-fetch-site": "cross-site",
    });
    expect(isForbiddenCrossSiteMutation(r)).toBe(true);
  });
});
