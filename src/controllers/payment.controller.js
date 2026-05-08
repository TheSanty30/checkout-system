import crypto from "crypto";
import { env } from "../config/env.js";
import {
  createCardPayment,
  getPaymentById,
} from "../services/mercadopago.service.js";

const paymentStore = new Map();
const pendingWaits = new Map();

const FINAL_STATUSES = new Set([
  "approved",
  "rejected",
  "cancelled",
  "refunded",
  "charged_back",
]);

function isFinalStatus(status) {
  return FINAL_STATUSES.has(String(status || "").toLowerCase());
}

function normalizePayment(payment) {
  if (!payment) return null;

  return {
    id: payment.id != null ? String(payment.id) : null,
    status: payment.status || null,
    status_detail: payment.status_detail || null,
    external_reference: payment.external_reference || null,
    transaction_amount: payment.transaction_amount || null,
    payment_method_id: payment.payment_method_id || null,
    payer_email: payment?.payer?.email || null,
    raw: payment,
    updatedAt: new Date().toISOString(),
  };
}

function resolvePendingWait(paymentId, payload) {
  const wait = pendingWaits.get(String(paymentId));
  if (!wait) return;

  clearTimeout(wait.timer);
  pendingWaits.delete(String(paymentId));
  wait.res.status(200).json(payload);
}

export function getMpConfig(req, res) {
  res.json({
    publicKey: env.MP_PUBLIC_KEY,
  });
}

export async function createPayment(req, res) {
  try {
    const {
      amount,
      token,
      paymentMethodId,
      installments,
      issuerId,
      payerEmail,
      description,
      reference,
      identificationType,
      identificationNumber,
    } = req.body;

    if (!amount || !token || !paymentMethodId || !payerEmail) {
      return res.status(400).json({
        message:
          "Faltan datos obligatorios: amount, token, paymentMethodId, payerEmail",
      });
    }

    const result = await createCardPayment({
      amount,
      token,
      paymentMethodId,
      installments,
      issuerId,
      payerEmail,
      description,
      reference,
      identificationType,
      identificationNumber,
    });

    const normalized = normalizePayment(result);
    if (normalized?.id) {
      paymentStore.set(normalized.id, normalized);

      if (isFinalStatus(normalized.status)) {
        resolvePendingWait(normalized.id, normalized);
      }
    }

    return res.status(201).json(normalized || result);
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo crear el pago",
      error: error?.message || String(error),
    });
  }
}

export async function getPaymentStatus(req, res) {
  try {
    const { paymentId } = req.params;

    if (!paymentId) {
      return res.status(400).json({
        message: "paymentId es obligatorio",
      });
    }

    const stored = paymentStore.get(String(paymentId));
    if (stored) {
      return res.json(stored);
    }

    const remote = await getPaymentById(paymentId);
    const normalized = normalizePayment(remote);

    if (normalized?.id) {
      paymentStore.set(normalized.id, normalized);
    }

    return res.json(normalized);
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo consultar el estado del pago",
      error: error?.message || String(error),
    });
  }
}

export async function waitPaymentStatus(req, res) {
  try {
    const { paymentId } = req.params;
    const timeoutMs = Math.min(
      Number(req.query.timeout || 30000),
      120000,
    );

    if (!paymentId) {
      return res.status(400).json({
        message: "paymentId es obligatorio",
      });
    }

    const stored = paymentStore.get(String(paymentId));
    if (stored && isFinalStatus(stored.status)) {
      return res.json(stored);
    }

    if (pendingWaits.has(String(paymentId))) {
      return res.status(409).json({
        message: "Ya existe una espera activa para ese paymentId",
      });
    }

    const timer = setTimeout(() => {
      pendingWaits.delete(String(paymentId));
      const current = paymentStore.get(String(paymentId));

      return res.status(202).json(
        current || {
          id: String(paymentId),
          status: "pending",
        },
      );
    }, timeoutMs);

    pendingWaits.set(String(paymentId), {
      res,
      timer,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo iniciar la espera del pago",
      error: error?.message || String(error),
    });
  }
}

function verifyWebhookSignature(req) {
  const secret = env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sin secret configurado, se omite la validación

  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  if (!xSignature) return false;

  // x-signature tiene formato: "ts=<timestamp>,v1=<hash>"
  const parts = Object.fromEntries(
    xSignature.split(",").map((part) => part.split("=")),
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const dataId =
    req.body?.data?.id ||
    req.body?.id ||
    req.query?.data_id ||
    req.query?.id ||
    "";

  // Manifest exacto que define MercadoPago
  const manifest = `id:${dataId};request-id:${xRequestId || ""};ts:${ts};`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(v1, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

export async function webhookMercadopago(req, res) {
  try {
    if (!verifyWebhookSignature(req)) {
      console.warn("Webhook rechazado: firma inválida");
      return res.sendStatus(400);
    }

    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.data_id ||
      req.query?.id;

    if (!paymentId) {
      return res.sendStatus(200);
    }

    const remote = await getPaymentById(paymentId);
    const normalized = normalizePayment(remote);

    if (normalized?.id) {
      paymentStore.set(normalized.id, normalized);

      if (isFinalStatus(normalized.status)) {
        resolvePendingWait(normalized.id, normalized);
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Error procesando webhook de Mercado Pago:", error);
    return res.sendStatus(200);
  }
}