(function (global) {
  // Base URL inyectada por el servidor al servir /sdk.js.
  // Permite usar el SDK desde cualquier dominio sin rutas relativas rotas.
  const BASE_URL = (typeof window !== "undefined" && window.__CHECKOUT_BASE_URL__) || "";

  const DEFAULT_THEME = {
    primary: "#2fbf59",
    primaryHover: "#27aa4f",
    success: "#16a34a",
    successSoft: "#dcfce7",
    error: "#dc2626",
    errorSoft: "#fee2e2",
    text: "#111827",
    muted: "#64748b",
    border: "#d9dfee",
    surface: "#f8fafc",
    background: "#ffffff",
  };

  const state = {
    step: 0,
    config: null,
    paymentResult: null,
    loading: false,
    formReady: false,
    liveValidationBound: false,
  };

  // Estado de validez de los 3 campos iframe del SDK
  const iframeValidity = {
    cardNumber: false,
    expirationDate: false,
    securityCode: false,
  };

  // Mapa de nombre de campo → selector del contenedor iframe
  const iframeSelectors = {
    cardNumber: "#form-checkout__cardNumber",
    expirationDate: "#form-checkout__expirationDate",
    securityCode: "#form-checkout__securityCode",
  };

  let overlay = null;
  let modal = null;
  let slider = null;
  let mpInstance = null;
  let cardForm = null;
  let mpInitialized = false;
  let mpInitPromise = null;

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

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getTheme() {
    return {
      ...DEFAULT_THEME,
      ...(state.config?.theme || {}),
    };
  }

  function loadStyles() {
    return new Promise((resolve) => {
      if (document.getElementById("mp-styles")) {
        resolve();
        return;
      }

      const link = document.createElement("link");
      link.id = "mp-styles";
      link.rel = "stylesheet";
      link.href = BASE_URL + "/sdk.css";
      link.onload = () => resolve();
      link.onerror = () => resolve(); // continuar aunque falle
      document.head.appendChild(link);
    });
  }

  function loadMercadoPagoSDK() {
    return new Promise((resolve, reject) => {
      if (window.MercadoPago) {
        resolve();
        return;
      }

      const existing = document.querySelector(
        'script[src="https://sdk.mercadopago.com/js/v2"]',
      );

      if (existing) {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.MercadoPago) {
            clearInterval(timer);
            resolve();
            return;
          }

          if (Date.now() - started > 15000) {
            clearInterval(timer);
            reject(
              new Error("Tiempo de espera agotado cargando MercadoPago SDK"),
            );
          }
        }, 50);

        return;
      }

      const script = document.createElement("script");
      script.src = "https://sdk.mercadopago.com/js/v2";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Error cargando MercadoPago SDK"));
      document.head.appendChild(script);
    });
  }

  async function fetchMpPublicKey() {
    const response = await fetch(BASE_URL + "/api/mp-config");
    if (!response.ok) {
      throw new Error("No se pudo obtener la configuración pública de MP");
    }

    const data = await response.json();
    if (!data?.publicKey) {
      throw new Error("La respuesta de /api/mp-config no contiene publicKey");
    }

    return data.publicKey;
  }

  function normalizePaymentResponse(result) {
    if (!result) return result;
    if (result.raw) return result;

    return {
      ...result,
      raw: result,
    };
  }

  async function waitForFinalPayment(paymentId, maxAttempts = 12) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(
        `${BASE_URL}/api/payments/${encodeURIComponent(paymentId)}/wait?timeout=25000`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      if (response.ok && data?.status && isFinalStatus(data.status)) {
        return normalizePaymentResponse(data);
      }

      if (
        response.status === 202 &&
        data?.status &&
        isFinalStatus(data.status)
      ) {
        return normalizePaymentResponse(data);
      }

      if (response.ok && data?.status && data.status !== "pending") {
        return normalizePaymentResponse(data);
      }

      await delay(1000);
    }

    throw new Error("No se obtuvo la confirmación final del pago");
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat("es-PE", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  }

  function getResultPaymentData() {
    const payment = state.paymentResult || {};
    const raw = payment.raw || payment;

    return {
      id: payment.id || raw.id || "-",
      status: payment.status || raw.status || "pending",
      date:
        raw.date_approved ||
        raw.date_created ||
        raw.date_last_updated ||
        payment.updatedAt ||
        null,
      amount:
        raw.transaction_amount ||
        payment.transaction_amount ||
        state.config?.amount ||
        0,
      paymentMethodId:
        raw.payment_method_id || payment.payment_method_id || "—",
      lastFour:
        raw.card?.last_four_digits ||
        raw.card?.lastFourDigits ||
        raw.last_four_digits ||
        null,
      email:
        raw.payer?.email ||
        payment.payer_email ||
        state.config?.customer?.email ||
        "",
      statusDetail: raw.status_detail || payment.status_detail || "",
    };
  }

  function applyTheme() {
    if (!overlay) return;

    const theme = getTheme();

    overlay.style.setProperty("--mp-primary", theme.primary);
    overlay.style.setProperty("--mp-primary-hover", theme.primaryHover);
    overlay.style.setProperty("--mp-success", theme.success);
    overlay.style.setProperty("--mp-success-soft", theme.successSoft);
    overlay.style.setProperty("--mp-error", theme.error);
    overlay.style.setProperty("--mp-error-soft", theme.errorSoft);
    overlay.style.setProperty("--mp-text", theme.text);
    overlay.style.setProperty("--mp-muted", theme.muted);
    overlay.style.setProperty("--mp-border", theme.border);
    overlay.style.setProperty("--mp-surface", theme.surface);
    overlay.style.setProperty("--mp-background", theme.background);
  }

  function clearValidationErrors() {
    const box = modal?.querySelector("#validation-error-messages");
    if (box) box.innerHTML = "";

    modal?.querySelectorAll(".mp-field-error").forEach((el) => {
      el.classList.remove("mp-field-error");
      el.removeAttribute("aria-invalid");
    });
  }

  function showValidationErrors(errors) {
    const box = modal?.querySelector("#validation-error-messages");
    if (!box) return;

    box.innerHTML = `
      <div class="mp-error-list">
        ${errors.map((e) => `<div class="mp-error-item">⚠ ${e.message}</div>`).join("")}
      </div>
    `;

    modal.querySelectorAll(".mp-field-error").forEach((el) => {
      el.classList.remove("mp-field-error");
    });

    errors.forEach((e) => {
      if (!e.selector) return;
      const el = modal.querySelector(e.selector);
      if (el) el.classList.add("mp-field-error");
    });

    const firstInput = modal.querySelector("#form-checkout__cardholderName");
    if (firstInput) firstInput.focus();

    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  // Retorna el array de errores para que onSubmit lo maneje correctamente
  function validatePaymentFields(data) {
    const validationErrors = [];

    if (!data.token) {
      validationErrors.push({
        selector: "#form-checkout__cardNumber",
        message: "Verifica los datos de tu tarjeta (Número, Fecha y CVV)",
      });
    }

    return validationErrors;
  }

  function bindLiveValidation() {
    const selectors = [
      "#form-checkout__cardholderName",
      "#form-checkout__cardholderEmail",
      "#form-checkout__identificationNumber",
      "#form-checkout__identificationType",
      "#form-checkout__installments",
    ];

    selectors.forEach((selector) => {
      const el = modal.querySelector(selector);
      if (!el) return;

      const clear = () => {
        el.classList.remove("mp-field-error");

        const box = modal.querySelector("#validation-error-messages");
        if (box) box.innerHTML = "";
      };

      el.addEventListener("input", clear);
      el.addEventListener("change", clear);
    });
  }

  function emitSuccess(result) {
    if (typeof state.config?.onSuccess === "function") {
      state.config.onSuccess(result);
    }
  }

  function emitError(error) {
    if (typeof state.config?.onError === "function") {
      state.config.onError(error);
    }
  }

  function emitClose() {
    if (typeof state.config?.onClose === "function") {
      state.config.onClose();
    }
  }

  function createModal(config) {
    state.config = config;

    const description = config.description || "Plan Enterprise";
    const quantity = config.quantity || 1;
    const price_unit = config.price_unit || 1;

    if (!state.config.amount) {
      state.config.amount = quantity * price_unit;
    }

    const amount = Number(state.config.amount).toFixed(2);

    overlay = document.createElement("div");
    overlay.className = "mp-overlay";

    modal = document.createElement("div");
    modal.className = "mp-modal";

    modal.innerHTML = `
      <div class="mp-header">
        <button class="mp-close-btn" id="mp-close-btn" aria-label="Cerrar">✕</button>
        <div class="mp-steps">
          <div class="mp-step active" id="step-0">
            <div class="mp-circle">1</div>
            <div class="mp-line"></div>
          </div>

          <div class="mp-step" id="step-1">
            <div class="mp-circle">2</div>
            <div class="mp-line"></div>
          </div>

          <div class="mp-step" id="step-2">
            <div class="mp-circle">3</div>
          </div>
        </div>
      </div>

      <div class="mp-body">
        <div class="mp-slide-container" id="slider">
          <section class="mp-slide">
            <div class="mp-title">Información del pago</div>
            <div class="mp-subtitle">Revisa el resumen antes de continuar</div>

            <div class="mp-card-info">
              <div class="mp-desc">Resumen del pedido</div>

              <div class="product-row">
                <div class="product-thumb" aria-hidden="true">
                  ${config.image
                    ? `<img src="${escapeHtml(config.image)}" alt="producto" class="product-thumb__img product-thumb__img--photo" />`
                    : `<div class="product-thumb__img">🛍️</div>`}
                </div>

                <div class="product-info">
                  <div class="product-name">${escapeHtml(description)}</div>
                  <div class="product-qty">Cantidad: ${escapeHtml(quantity)}</div>
                </div>

                <div class="product-price">S/ ${amount}</div>
              </div>

              <div class="summary-lines">
                <div class="line">
                  <span>Subtotal</span>
                  <strong>S/ ${amount}</strong>
                </div>
                <div class="line total">
                  <span>Total a pagar</span>
                  <strong>S/ ${amount}</strong>
                </div>
              </div>
            </div>
          </section>

          <section class="mp-slide">
            <div class="mp-title">Método de pago</div>
            <div class="mp-subtitle">Selecciona tu método de pago</div>

            <div class="payment-methods">
              <label class="method-card active">
                <input type="radio" name="method" checked />
                <span class="method-logo visa">VISA</span>
                <span class="method-text">
                  <strong>Tarjeta de crédito o débito</strong>
                  <small>Visa, Mastercard, American Express</small>
                </span>
                <span class="radio-dot"></span>
              </label>
            </div>

            <div class="mp-title">Datos de la tarjeta</div>
            <div class="mp-subtitle">Ingresa los datos de tu tarjeta.</div>

            <form id="form-checkout" autocomplete="on">
              <div class="row mb-3">
                <div class="col">
                  <div id="form-checkout__cardNumber" class="form-control mp-field mp-iframe-field"></div>
                </div>
              </div>

              <div class="row mb-3">
                <div class="col-sm-6">
                  <div id="form-checkout__expirationDate" class="form-control mp-field mp-iframe-field"></div>
                </div>
                <div class="col-sm-6">
                  <div id="form-checkout__securityCode" class="form-control mp-field mp-iframe-field"></div>
                </div>
              </div>

              <div class="row mb-3">
                <div class="col">
                  <input
                    id="form-checkout__cardholderName"
                    name="cardholderName"
                    type="text"
                    class="form-control mp-field"
                    placeholder="Nombre del titular"
                    autocomplete="cc-name"
                  />
                </div>
              </div>

              <div class="row mb-3">
                <div class="col-sm-4">
                  <select
                    id="form-checkout__identificationType"
                    name="identificationType"
                    class="form-control mp-field"
                  ></select>
                </div>
                <div class="col-sm-8">
                  <input
                    id="form-checkout__identificationNumber"
                    name="docNumber"
                    type="text"
                    class="form-control mp-field"
                    placeholder="Número de documento"
                    autocomplete="off"
                  />
                </div>
              </div>

              <div class="row mb-3" style="display:none;" aria-hidden="true">
                <div class="col">
                  <select
                    id="form-checkout__installments"
                    name="installments"
                    class="form-control mp-field"
                  ></select>
                </div>
              </div>

              <div class="row mb-3">
                <div class="col">
                  <input
                    id="form-checkout__cardholderEmail"
                    name="cardholderEmail"
                    type="email"
                    class="form-control mp-field"
                    placeholder="Correo electrónico"
                    autocomplete="email"
                  />
                </div>
              </div>

              <div class="row">
                <div id="issuerInput" class="col-sm-12 hidden">
                  <select id="form-checkout__issuer" name="issuer" class="form-control mp-field"></select>
                </div>

                <div class="col-sm-12">
                  <input type="hidden" id="amount" />
                  <input type="hidden" id="description" />
                  <div id="validation-error-messages"></div>
                  <div id="loading-message" class="mp-loading-state" style="display:none;">
                    <div class="mp-spinner"></div>
                    <span>Procesando pago, por favor espera...</span>
                  </div>
                  <a id="go-back" class="mp-back-link" href="#">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 10 10" class="chevron-left">
                      <path fill="currentColor" fill-rule="nonzero" id="chevron_left" d="M7.05 1.4L6.2.552 1.756 4.997l4.449 4.448.849-.848-3.6-3.6z"></path>
                    </svg>
                    Volver
                  </a>
                </div>
              </div>
            </form>
          </section>

          <section class="mp-slide" id="result-slide">
            <div class="mp-result-placeholder">
              <div class="mp-title">Resultado del pago</div>
              <div class="mp-desc">Esperando resultado...</div>
            </div>
          </section>
        </div>
      </div>

      <div class="mp-footer">
        <button class="mp-btn" id="actionBtn">Continuar</button>
        <div class="secure-note">
          <span class="secure-icon">🔒</span>
          <span>Tu información está segura y protegida.</span>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add("mp-lock-scroll");

    slider = modal.querySelector("#slider");

    const amountInput = modal.querySelector("#amount");
    const descriptionInput = modal.querySelector("#description");
    if (amountInput) amountInput.value = String(config.amount ?? "");
    if (descriptionInput)
      descriptionInput.value = String(config.description ?? "");

    applyTheme();

    const goBack = modal.querySelector("#go-back");
    if (goBack) {
      goBack.addEventListener("click", (e) => {
        e.preventDefault();
        if (state.loading) return;
        state.step = 0;
        updateUI();
      });
    }

    const closeBtn = modal.querySelector("#mp-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        if (state.loading) return;
        close();
      });
    }

    updateUI();
  }

  function updateStepClasses() {
    for (let i = 0; i < 3; i++) {
      const el = modal?.querySelector(`#step-${i}`);
      if (el) el.classList.remove("active", "completed");
    }

    for (let i = 0; i <= state.step; i++) {
      const el = modal?.querySelector(`#step-${i}`);
      if (!el) continue;
      if (i === state.step) el.classList.add("active");
      else el.classList.add("completed");
    }
  }

  function updateInertSlides() {
    const slides = modal?.querySelectorAll(".mp-slide");
    if (!slides) return;

    slides.forEach((slide, i) => {
      if (i === state.step) {
        slide.removeAttribute("inert");
      } else {
        slide.setAttribute("inert", "");
      }
    });
  }

  function attachResultActions(payment) {
    const downloadBtn = modal?.querySelector("#download-receipt-btn");
    const closeBtn = modal?.querySelector("#back-to-site-btn");

    if (downloadBtn) {
      downloadBtn.onclick = () => {
        const payload = {
          id: payment.id,
          status: payment.status,
          statusDetail: payment.statusDetail,
          date: payment.date,
          amount: payment.amount,
          paymentMethodId: payment.paymentMethodId,
          lastFour: payment.lastFour,
          email: payment.email,
          reference: state.config?.reference || null,
          description: state.config?.description || null,
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `comprobante-mp-${payment.id}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };
    }

    //const closeBtn = modal?.querySelector("#back-to-site-btn");
    const retryBtn = modal?.querySelector("#retry-payment-btn");

    if (closeBtn) {
      closeBtn.onclick = () => close();
    }

    if (retryBtn) {
      retryBtn.onclick = () => {
        state.step = 1;
        state.paymentResult = null;
        
        // Desmontar el formulario para forzar una nueva tokenización fresca
        if (cardForm?.unmount) {
          try { cardForm.unmount(); } catch (e) { console.warn(e); }
        }
        cardForm = null;
        mpInitialized = false;
        mpInitPromise = null;
        
        iframeValidity.cardNumber = false;
        iframeValidity.expirationDate = false;
        iframeValidity.securityCode = false;

        updateUI();
      };
    }
  }

  function translateStatusDetail(detail, status) {
    const translations = {
      accredited: "Tu pago fue aprobado y acreditado.",
      pending_contingency: "Estamos procesando tu pago. En menos de una hora te enviaremos por e-mail el resultado.",
      pending_review_manual: "Estamos procesando tu pago. En menos de 2 días hábiles te diremos por e-mail si se acreditó.",
      cc_rejected_bad_filled_card_number: "Revisa el número de tarjeta.",
      cc_rejected_bad_filled_date: "Revisa la fecha de vencimiento.",
      cc_rejected_bad_filled_other: "Revisa los datos ingresados.",
      cc_rejected_bad_filled_security_code: "Revisa el código de seguridad de la tarjeta.",
      cc_rejected_blacklist: "No pudimos procesar tu pago.",
      cc_rejected_call_for_authorize: "Debes autorizar ante tu tarjeta el pago a Mercado Pago.",
      cc_rejected_card_disabled: "Llama a tu tarjeta para activar tu tarjeta o usa otro medio de pago.",
      cc_rejected_card_error: "No pudimos procesar tu pago.",
      cc_rejected_duplicated_payment: "Ya hiciste un pago por ese valor. Si necesitas volver a pagar usa otra tarjeta u otro medio de pago.",
      cc_rejected_high_risk: "Tu pago fue rechazado. Elige otro de los medios de pago, te recomendamos con efectivo.",
      cc_rejected_insufficient_amount: "Tu tarjeta no tiene fondos suficientes.",
      cc_rejected_invalid_installments: "Tu tarjeta no procesa pagos en la cantidad de cuotas elegida.",
      cc_rejected_max_attempts: "Llegaste al límite de intentos permitidos. Elige otra tarjeta u otro medio de pago.",
      cc_rejected_other_reason: "Tu tarjeta no procesó el pago."
    };

    if (translations[detail]) return translations[detail];

    if (status === "pending" || status === "in_process") {
      return "Estamos procesando tu pago. Te avisaremos cuando se acredite.";
    }

    if (status === "approved") {
      return "Tu compra se ha procesado correctamente.";
    }

    return "No se pudo completar el pago.";
  }

  function renderResult() {
    const resultSlide = modal?.querySelector("#result-slide");
    if (!resultSlide) return;

    const payment = getResultPaymentData();
    const status = String(payment.status).toLowerCase();
    
    const isApproved = status === "approved";
    const isPending = status === "pending" || status === "in_process";
    
    let iconClass = "is-error";
    let iconSymbol = "!";
    let title = "Pago no aprobado";
    
    if (isApproved) {
      iconClass = "is-success";
      iconSymbol = "✓";
      title = "¡Pago exitoso!";
    } else if (isPending) {
      iconClass = "is-pending";
      iconSymbol = "⏳";
      title = "Pago en proceso";
    }

    let subMessage = translateStatusDetail(payment.statusDetail, status);

    resultSlide.innerHTML = `
      <div class="mp-success-container">
        <div class="mp-success-icon ${iconClass}">
          ${iconSymbol}
        </div>

        <div class="mp-success-title">
          ${title}
        </div>

        <div class="mp-success-sub">
          ${subMessage}
        </div>

        <div class="mp-details-card">
          <div class="mp-details-title">Detalles de la transacción</div>

          <div class="mp-detail-row">
            <span>ID de operación:</span>
            <strong>#MP-${escapeHtml(payment.id)}</strong>
          </div>

          <div class="mp-detail-row">
            <span>Fecha:</span>
            <strong>${escapeHtml(formatDate(payment.date))}</strong>
          </div>

          <div class="mp-detail-row">
            <span>Monto pagado:</span>
            <strong>S/ ${Number(payment.amount || 0).toFixed(2)}</strong>
          </div>

          <div class="mp-detail-row">
            <span>Método de pago:</span>
            <strong>
              ${escapeHtml(String(payment.paymentMethodId || "Tarjeta").toUpperCase())}
              ${payment.lastFour ? ` **** ${escapeHtml(payment.lastFour)}` : ""}
            </strong>
          </div>
        </div>

        <div class="mp-result-actions">
          ${
            (!isApproved && !isPending)
              ? `<button type="button" class="mp-btn-secondary" style="margin-bottom: 10px;" id="retry-payment-btn">
                   Volver a intentar
                 </button>`
              : ""
          }
          <button type="button" class="mp-btn-primary" id="back-to-site-btn">
            ${isApproved || isPending ? "Volver al sitio" : "Cerrar"}
          </button>
        </div>

        <div class="mp-footer-note">
          <span class="mp-footer-note__icon">🛡</span>
          <span>
            ${
              isApproved || isPending
                ? "Gracias por tu compra. ¡Vuelve pronto!"
                : "Si el pago fue rechazado, puedes intentar nuevamente."
            }
          </span>
        </div>
      </div>
    `;

    attachResultActions(payment);
  }


  async function initMercadoPago() {
    if (mpInitialized || mpInitPromise) {
      return mpInitPromise || Promise.resolve();
    }

    mpInitPromise = (async () => {
      try {
        state.loading = true;
        state.formReady = false;
        updateUI();

        const publicKey = await fetchMpPublicKey();
        await loadMercadoPagoSDK();

        mpInstance = new MercadoPago(publicKey, {
          locale: "es-PE",
        });

        cardForm = mpInstance.cardForm({
          amount: String(state.config.amount),
          iframe: true,
          form: {
            id: "form-checkout",
            cardholderName: {
              id: "form-checkout__cardholderName",
              placeholder: "Nombre del titular",
            },
            cardholderEmail: {
              id: "form-checkout__cardholderEmail",
              placeholder: "Correo electrónico",
            },
            cardNumber: {
              id: "form-checkout__cardNumber",
              placeholder: "Número de tarjeta",
              style: { fontSize: "14px" },
            },
            expirationDate: {
              id: "form-checkout__expirationDate",
              placeholder: "MM/YY",
              style: { fontSize: "14px" },
            },
            securityCode: {
              id: "form-checkout__securityCode",
              placeholder: "CVV",
              style: { fontSize: "14px" },
            },
            installments: {
              id: "form-checkout__installments",
              placeholder: "Cuotas",
            },
            identificationType: {
              id: "form-checkout__identificationType",
            },
            identificationNumber: {
              id: "form-checkout__identificationNumber",
              placeholder: "Número de documento",
            },
            issuer: {
              id: "form-checkout__issuer",
              placeholder: "Emisor",
            },
          },
          callbacks: {
            onFormMounted: (error) => {
              state.loading = false;
              state.formReady = !error;

              if (error) {
                console.warn("Form Mounted handling error:", error);
              } else {
                bindLiveValidation();
              }

              updateUI();
            },

            // Rastrea validez de campos iframe y actualiza clases CSS en tiempo real
            onValidityChange: (errors, field) => {
              if (!(field in iframeValidity)) return;

              const isValid = !errors || errors.length === 0;
              iframeValidity[field] = isValid;

              const selector = iframeSelectors[field];
              if (selector) {
                const el = modal?.querySelector(selector);
                if (el) {
                  el.classList.toggle("mp-field-error", !isValid);
                  el.classList.toggle("mp-field-success", isValid);
                }
              }
            },

            onSubmit: async (event) => {
              event.preventDefault();

              try {
                state.loading = true;
                clearValidationErrors();
                updateUI();

                const data = cardForm.getCardFormData();
                const paymentMethodId =
                  data.paymentMethodId || data.payment_method_id;
                const issuerId = data.issuerId || data.issuer_id;

                const validationErrors = validatePaymentFields({
                  ...data,
                  paymentMethodId,
                  issuerId,
                });

                if (validationErrors.length) {
                  state.loading = false;
                  showValidationErrors(validationErrors);
                  updateUI();
                  return;
                }

                const response = await fetch(BASE_URL + "/api/payments", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    amount: Number(state.config.amount),
                    description: state.config.description,
                    reference: state.config.reference,
                    payerEmail: data.cardholderEmail,
                    payerName: data.cardholderName,
                    token: data.token,
                    paymentMethodId,
                    installments: 1,
                    issuerId,
                    identificationType: data.identificationType,
                    identificationNumber: data.identificationNumber,
                  }),
                });

                const initialResult = await response.json();

                if (!response.ok) {
                  throw new Error(
                    initialResult?.message || "No se pudo procesar el pago",
                  );
                }

                let finalResult = normalizePaymentResponse(initialResult);

                if (finalResult?.id) {
                  try {
                    finalResult = await waitForFinalPayment(finalResult.id);
                  } catch (waitError) {
                    console.warn(
                      "No llegó confirmación final, se usará la respuesta inicial:",
                      waitError,
                    );
                  }
                }

                state.paymentResult = normalizePaymentResponse(finalResult);
                state.step = 2;
                renderResult();
                updateUI();
                emitSuccess(state.paymentResult);
              } catch (error) {
                console.error("Payment error:", error);
                state.paymentResult = {
                  status: "error",
                  id: null,
                  message: error?.message || "Error desconocido",
                  raw: null,
                };
                state.step = 2;
                renderResult();
                updateUI();
                emitError(error);
              } finally {
                state.loading = false;
                updateUI();
              }
            },

            onFetching: () => {},

            onError: (error) => {
              console.error("MercadoPago form error:", error);
              state.loading = false;
              state.formReady = false;
              updateUI();
              emitError(error);
            },
          },
        });

        mpInitialized = true;
      } catch (err) {
        console.error(err);
        state.loading = false;
        state.formReady = false;
        mpInitialized = false;
        cardForm = null;
        updateUI();
        throw err;
      }
    })();

    try {
      await mpInitPromise;
    } finally {
      mpInitPromise = null;
    }
  }

  function nextStep() {
    state.step = 1;
    state.formReady = false;
    updateUI();
  }

  function close() {
    try {
      if (cardForm?.unmount) cardForm.unmount();
    } catch (e) {
      console.warn("No se pudo desmontar cardForm:", e);
    }

    cardForm = null;
    mpInstance = null;
    mpInitialized = false;
    mpInitPromise = null;

    state.step = 0;
    state.config = null;
    state.paymentResult = null;
    state.loading = false;
    state.formReady = false;
    state.liveValidationBound = false;

    iframeValidity.cardNumber = false;
    iframeValidity.expirationDate = false;
    iframeValidity.securityCode = false;

    if (overlay) overlay.remove();

    overlay = null;
    modal = null;
    slider = null;

    document.body.classList.remove("mp-lock-scroll");
    emitClose();
  }

  function updateUI() {
    if (!overlay || !modal || !slider) return;

    applyTheme();

    slider.style.transform = `translateX(-${state.step * 100}%)`;
    updateStepClasses();

    updateInertSlides();

    const btn = modal.querySelector("#actionBtn");
    const loadingMessage = modal.querySelector("#loading-message");
    const footer = modal.querySelector(".mp-footer");

    if (!btn) return;

    if (footer) {
      footer.style.display = state.step === 2 ? "none" : "block";
    }

    if (state.step === 0) {
      btn.disabled = false;
      btn.textContent = "Continuar al pago →";
      btn.onclick = nextStep;

      if (loadingMessage) loadingMessage.style.display = "none";
      return;
    }

    if (state.step === 1) {
      if (!mpInitialized && !state.loading && !mpInitPromise) {
        initMercadoPago().catch((err) => console.error(err));
      }

      if (loadingMessage) {
        loadingMessage.style.display = state.loading ? "flex" : "none";
      }

      const goBack = modal.querySelector("#go-back");
      if (goBack) {
        goBack.style.pointerEvents = state.loading ? "none" : "";
        goBack.style.opacity = state.loading ? "0.35" : "";
      }
      
      const formCheckout = modal.querySelector("#form-checkout");
      if (formCheckout) {
        formCheckout.style.pointerEvents = state.loading ? "none" : "";
        formCheckout.style.opacity = state.loading ? "0.6" : "1";
      }

      btn.disabled = state.loading;
      btn.textContent = state.loading
        ? "Procesando..."
        : `Pagar S/ ${Number(state.config?.amount || 0).toFixed(2)}`;

      btn.onclick = async () => {
        if (state.loading) return;

        const nameEl  = modal.querySelector("#form-checkout__cardholderName");
        const emailEl = modal.querySelector("#form-checkout__cardholderEmail");
        const docEl   = modal.querySelector("#form-checkout__identificationNumber");

        const errors = [];

        if (!nameEl?.value?.trim()) {
          errors.push({
            selector: "#form-checkout__cardholderName",
            message: "El nombre del titular es obligatorio",
          });
        }

        if (!emailEl?.value?.trim()) {
          errors.push({
            selector: "#form-checkout__cardholderEmail",
            message: "El correo electrónico es requerido",
          });
        } else if (!isValidEmail(emailEl.value)) {
          errors.push({
            selector: "#form-checkout__cardholderEmail",
            message: "El formato del correo no es válido",
          });
        }

        if (!docEl?.value?.trim()) {
          errors.push({
            selector: "#form-checkout__identificationNumber",
            message: "El número de documento es obligatorio",
          });
        }

        if (!iframeValidity.cardNumber) {
          errors.push({
            selector: "#form-checkout__cardNumber",
            message: "El número de tarjeta es inválido o está incompleto",
          });
        }

        if (!iframeValidity.expirationDate) {
          errors.push({
            selector: "#form-checkout__expirationDate",
            message: "La fecha de vencimiento es inválida o está incompleta",
          });
        }

        if (!iframeValidity.securityCode) {
          errors.push({
            selector: "#form-checkout__securityCode",
            message: "El código de seguridad es inválido o está incompleto",
          });
        }

        if (errors.length > 0) {
          showValidationErrors(errors);
          return;
        }

        if (cardForm?.submit) {
          cardForm.submit();
        }
      };

      return;
    }

    if (state.step === 2) {
      if (loadingMessage) loadingMessage.style.display = "none";
    }
  }

  async function open(config) {
    if (!config) throw new Error("Falta la configuración del checkout");

    if (overlay) close();

    await loadStyles();

    state.step = 0;
    state.config = config;
    state.paymentResult = null;
    state.loading = false;
    state.formReady = false;
    state.liveValidationBound = false;
    cardForm = null;
    mpInstance = null;
    mpInitialized = false;
    mpInitPromise = null;

    createModal(config);
  }

  global.MyCheckout = { open };
})(window);
