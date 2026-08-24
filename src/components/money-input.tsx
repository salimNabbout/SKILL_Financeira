"use client";

import { useState } from "react";

/**
 * Campo de valor com máscara monetária pt-BR, estilo caixa eletrônico: o
 * usuário digita apenas dígitos e a máscara é aplicada da direita para a
 * esquerda (centavos primeiro). Digitar 1 → "0,01"; 15 → "0,15";
 * 150000000 → "1.500.000,00".
 *
 * Renderiza DOIS inputs: o visível (formatado, SEM name) e um hidden com o
 * name real. Assim o servidor continua recebendo o mesmo formato de sempre e
 * `parseBRLToCents` não precisa mudar.
 *
 * Toda a aritmética é feita sobre strings de dígitos — nunca com float, como o
 * resto do domínio monetário (ver src/core/money.ts).
 */

/** Teto de dígitos: ~10 trilhões, bem acima de qualquer valor real, e evita
 *  que colar um texto enorme trave a formatação. */
const MAX_DIGITOS = 15;

/**
 * Extrai os dígitos e descarta zeros à esquerda.
 *
 * Descartar os zeros é o que permite ESVAZIAR o campo: apagando o "5" de
 * "0,05" sobram os dígitos "00", que sem essa normalização voltariam a
 * formatar como "0,00" — o campo ficaria preso em zeros e o hidden enviaria
 * "0,00" onde deveria ir vazio.
 */
function apenasDigitos(bruto: string): string {
  return bruto
    .replace(/\D/g, "")
    .replace(/^0+/, "")
    .slice(0, MAX_DIGITOS);
}

/** Separa os dígitos em parte inteira e centavos, sempre com 2 casas. */
function partes(digitos: string): { inteiros: string; centavos: string } {
  const significativos = digitos.replace(/^0+/, "") || "0";
  const preenchido = significativos.padStart(3, "0");
  return { inteiros: preenchido.slice(0, -2), centavos: preenchido.slice(-2) };
}

/** O que o usuário vê: "1.500.000,00". */
function formatarVisivel(digitos: string): string {
  if (!digitos) return "";
  const { inteiros, centavos } = partes(digitos);
  return `${inteiros.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${centavos}`;
}

/**
 * O que vai no hidden: "1500000,00" — sem separador de milhar, para não haver
 * ambiguidade entre ponto decimal e ponto de milhar. `parseBRLToCents` já
 * aceita exatamente esse formato hoje.
 */
function formatarParaServidor(digitos: string): string {
  if (!digitos) return "";
  const { inteiros, centavos } = partes(digitos);
  return `${inteiros},${centavos}`;
}

export interface MoneyInputProps {
  /** Nome do campo enviado ao servidor (vai no input hidden). */
  name: string;
  required?: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
  id?: string;
  /** Valor inicial em qualquer formato ("1234,56", "1.234,56", "123456"). */
  defaultValue?: string;
}

export function MoneyInput({
  name,
  required,
  className,
  placeholder,
  title,
  id,
  defaultValue,
}: MoneyInputProps) {
  const [digitos, setDigitos] = useState(() => apenasDigitos(defaultValue ?? ""));

  return (
    <>
      <input
        type="text"
        // inputMode decimal abre o teclado numérico no celular.
        inputMode="decimal"
        autoComplete="off"
        value={formatarVisivel(digitos)}
        // Reformatar a partir dos dígitos resolve de uma vez colagem de texto
        // já formatado, letras, mais de uma vírgula e o backspace: qualquer
        // entrada vira "só os dígitos" e é remontada.
        onChange={(e) => setDigitos(apenasDigitos(e.target.value))}
        // Máscara da direita para a esquerda pressupõe o cursor no fim.
        onFocus={(e) => {
          const fim = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(fim, fim);
        }}
        required={required}
        className={className}
        placeholder={placeholder}
        title={title}
        id={id}
      />
      <input type="hidden" name={name} value={formatarParaServidor(digitos)} />
    </>
  );
}
