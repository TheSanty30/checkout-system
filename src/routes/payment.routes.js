import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { env } from "../config/env.js";
import {
  createPayment,
  getMpConfig,
  getPaymentStatus,
  waitPaymentStatus,
  webhookMercadopago,
} from "../controllers/payment.controller.js";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cacheamos el contenido del SDK una sola vez al iniciar el servidor.
// El dominio se inyecta dinámicamente en cada request, pero el resto del
// archivo se lee del disco una única vez para mejorar el rendimiento.
const SDK_SOURCE = readFileSync(
  path.join(__dirname, "../sdk/index.js"),
  "utf-8",
);

// Servimos el SDK inyectando el dominio del servidor al inicio del archivo.
// Esto permite que el cliente lo use desde cualquier dominio sin rutas relativas rotas.
router.get("/sdk.js", (req, res) => {
  const injected =
    `window.__CHECKOUT_BASE_URL__ = ${JSON.stringify(env.DOMAIN)};\n` +
    SDK_SOURCE;

  res.setHeader("Content-Type", "application/javascript");
  res.send(injected);
});


router.get("/sdk.css", (req, res) => {
  res.sendFile(path.join(__dirname, "../sdk/styles.css"));
});

router.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "../views/app.js"));
});

router.get("/test.css", (req, res) => {
  res.sendFile(path.join(__dirname, "../views/test.css"));
});

router.get("/test", (req, res) => {
  res.sendFile(path.join(__dirname, "../views/test.html"));
});

router.get("/api/mp-config", getMpConfig);
router.post("/api/payments", createPayment);
router.get("/api/payments/:paymentId/status", getPaymentStatus);
router.get("/api/payments/:paymentId/wait", waitPaymentStatus);
router.post("/webhook/mercadopago", webhookMercadopago);

export default router;
