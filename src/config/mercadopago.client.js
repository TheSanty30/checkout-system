import { MercadoPagoConfig } from "mercadopago";
import { env } from "./env.js";

if (!env.MP_ACCESS_TOKEN) {
  throw new Error("Falta MP_ACCESS_TOKEN en el archivo .env");
}

export const mpClient = new MercadoPagoConfig({
  accessToken: env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});
