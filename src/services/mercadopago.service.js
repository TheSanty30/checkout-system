import crypto from "crypto";
import { Payment } from "mercadopago";
import { mpClient } from "../config/mercadopago.client.js";
import { env } from "../config/env.js";

const payment = new Payment(mpClient);

export async function createCardPayment(input) {
  const body = {
    transaction_amount: Number(input.amount),
    token: input.token,
    installments: Number(input.installments || 1),
    payment_method_id: input.paymentMethodId,
    issuer_id: input.issuerId || undefined,
    description: input.description || "Pago",
    external_reference: input.reference || undefined,
    payer: {
      email: input.payerEmail,
      ...(input.identificationType && input.identificationNumber
        ? {
            identification: {
              type: input.identificationType,
              number: input.identificationNumber,
            },
          }
        : {}),
    },
  };

  const requestOptions = {
    idempotencyKey: crypto.randomUUID(),
  };

  return await payment.create({ body, requestOptions });
}

export async function getPaymentById(paymentId) {
  if (!paymentId) {
    throw new Error("paymentId es obligatorio");
  }

  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`No se pudo consultar el pago ${paymentId}: ${text}`);
  }

  return await response.json();
}
