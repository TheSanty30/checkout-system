(function () {
  const screens = Array.from(document.querySelectorAll(".screen"));
  const buttons = {
    step2: document.getElementById("goToStep2"),
    pay: document.getElementById("payButton"),
  };

  let currentStep = 1;
  let transitionLock = false;

  function getScreen(step) {
    return screens.find((s) => Number(s.dataset.step) === step);
  }

  function setActiveMethod() {
    const methods = Array.from(document.querySelectorAll(".method-card"));
    methods.forEach((card) => {
      const input = card.querySelector('input[type="radio"]');
      card.classList.toggle("active", input.checked);
      card.addEventListener("click", () => {
        methods.forEach((other) => {
          other.querySelector('input[type="radio"]').checked = false;
          other.classList.remove("active");
        });
        input.checked = true;
        card.classList.add("active");
      });
    });
  }

  function showStep(nextStep, direction = "forward") {
    if (transitionLock || nextStep === currentStep) return;

    const current = getScreen(currentStep);
    const next = getScreen(nextStep);
    if (!current || !next) return;

    transitionLock = true;

    current.classList.remove("active");
    current.classList.add(direction === "forward" ? "exit-left" : "exit-right");

    next.classList.remove("exit-left", "exit-right");
    next.classList.add("active");

    if (direction === "forward") {
      next.style.transform = "translateX(20px) scale(0.985)";
      requestAnimationFrame(() => {
        next.style.transform = "translateX(0) scale(1)";
      });
    } else {
      next.style.transform = "translateX(-20px) scale(0.985)";
      requestAnimationFrame(() => {
        next.style.transform = "translateX(0) scale(1)";
      });
    }

    setTimeout(() => {
      current.classList.remove("exit-left", "exit-right");
      currentStep = nextStep;
      transitionLock = false;
    }, 430);
  }

  // Eventos
  buttons.step2?.addEventListener("click", () => {
    showStep(2, "forward");
  });

  buttons.pay?.addEventListener("click", () => {
    showStep(3, "forward");
  });

  // Cambio visual de botones / tarjetas
  setActiveMethod();

  // Permite avanzar con Enter desde inputs del primer paso
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && currentStep === 1) {
      showStep(2, "forward");
    }
  });

  // Opcional: clic en el fondo de la tarjeta no hace nada, mantiene foco limpio
})();
