const AVATAR_MAX_DATA_URL_LENGTH = 450000;
const AVATAR_SOFT_LIMIT = 320000;
const CHART_COLORS = ["#8e63ff", "#ff8eaa", "#ffb768", "#7bd9c4", "#6ca9ff", "#c9a1ff"];

const state = {
  authMode: "login",
  currentView: "dashboard",
  monthKey: currentMonthKey(),
  bootstrap: null,
  deferredInstallPrompt: null,
  toastTimer: null,
  avatarDrafts: {
    register: "",
    settings: undefined
  }
};

const nodes = {};

window.addEventListener("DOMContentLoaded", () => {
  cacheNodes();
  bindEvents();
  switchAuthMode("login");
  nodes.monthPicker.value = state.monthKey;
  loadBootstrap({ quietAuth: true });
  registerServiceWorker();
});

function cacheNodes() {
  [
    "auth-screen",
    "app-screen",
    "login-form",
    "register-form",
    "recover-form",
    "recover-email",
    "recover-step",
    "recover-code",
    "recover-password",
    "recover-password-confirm",
    "recover-preview-note",
    "register-avatar-input",
    "register-avatar-preview",
    "register-avatar-fallback",
    "register-name-input",
    "settings-avatar-input",
    "settings-avatar-preview",
    "settings-avatar-fallback",
    "header-avatar-preview",
    "header-avatar-fallback",
    "month-picker",
    "install-btn",
    "hello-line",
    "household-title",
    "dashboard-welcome",
    "partner-status",
    "available-total",
    "ideal-budget-total",
    "bank-total",
    "cash-total",
    "invite-code-pill",
    "dashboard-scope-cards",
    "dashboard-insights",
    "trend-chart",
    "trend-labels",
    "dashboard-account-preview",
    "dashboard-plan-preview",
    "dashboard-transactions",
    "accounts-summary",
    "bank-accounts",
    "cash-accounts",
    "transaction-summary",
    "transaction-list",
    "analytics-scope-cards",
    "personal-category-chart",
    "personal-category-legend",
    "shared-category-chart",
    "shared-category-legend",
    "weekly-expense-chart",
    "weekly-expense-legend",
    "plan-summary",
    "income-plan-list",
    "expense-plan-list",
    "settings-form",
    "settings-name",
    "settings-currency",
    "invite-code-value",
    "member-list",
    "modal-backdrop",
    "transaction-modal",
    "account-modal",
    "plan-modal",
    "transaction-form",
    "account-form",
    "plan-form",
    "transaction-kind",
    "transaction-account",
    "transaction-plan-item",
    "transaction-category",
    "transaction-amount",
    "transaction-date",
    "transaction-note",
    "plan-kind",
    "toast"
  ].forEach((id) => {
    nodes[toCamel(id)] = document.getElementById(id);
  });
}

function bindEvents() {
  document.addEventListener("click", onDocumentClick);

  nodes.loginForm.addEventListener("submit", submitLogin);
  nodes.registerForm.addEventListener("submit", submitRegister);
  nodes.recoverForm.addEventListener("submit", submitRecover);
  nodes.settingsForm.addEventListener("submit", submitSettings);
  nodes.accountForm.addEventListener("submit", submitAccount);
  nodes.planForm.addEventListener("submit", submitPlanItem);
  nodes.transactionForm.addEventListener("submit", submitTransaction);

  nodes.monthPicker.addEventListener("change", async (event) => {
    state.monthKey = event.target.value || currentMonthKey();
    await loadBootstrap();
  });

  nodes.transactionKind.addEventListener("change", () => refreshTransactionPlanOptions());
  nodes.transactionAccount.addEventListener("change", () => refreshTransactionPlanOptions());
  nodes.transactionDate.addEventListener("change", () => refreshTransactionPlanOptions());

  nodes.registerNameInput.addEventListener("input", refreshRegisterAvatarPreview);
  nodes.settingsName.addEventListener("input", refreshSettingsAvatarPreview);
  nodes.registerAvatarInput.addEventListener("change", onRegisterAvatarSelected);
  nodes.settingsAvatarInput.addEventListener("change", onSettingsAvatarSelected);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    nodes.installBtn.classList.remove("hidden");
  });

  nodes.installBtn.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      return;
    }

    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    nodes.installBtn.classList.add("hidden");
  });

  nodes.modalBackdrop.addEventListener("click", closeAllModals);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllModals();
    }
  });
}

async function onDocumentClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;

  if (action === "switch-auth") {
    switchAuthMode(target.dataset.mode);
    return;
  }

  if (action === "switch-view") {
    state.currentView = target.dataset.view || "dashboard";
    renderViewState();
    return;
  }

  if (action === "copy-invite") {
    await copyInviteCode();
    return;
  }

  if (action === "open-account-modal") {
    openAccountModal();
    return;
  }

  if (action === "open-plan-modal") {
    openPlanModal(target.dataset.kind || "expense");
    return;
  }

  if (action === "open-transaction-modal") {
    openTransactionModal({ kind: target.dataset.kind || "expense" });
    return;
  }

  if (action === "register-plan-item") {
    openTransactionModal({ planItemId: target.dataset.planId || "" });
    return;
  }

  if (action === "close-modal") {
    closeAllModals();
    return;
  }

  if (action === "pick-register-avatar") {
    nodes.registerAvatarInput.click();
    return;
  }

  if (action === "clear-register-avatar") {
    state.avatarDrafts.register = "";
    nodes.registerAvatarInput.value = "";
    refreshRegisterAvatarPreview();
    return;
  }

  if (action === "pick-settings-avatar") {
    nodes.settingsAvatarInput.click();
    return;
  }

  if (action === "clear-settings-avatar") {
    state.avatarDrafts.settings = "";
    nodes.settingsAvatarInput.value = "";
    refreshSettingsAvatarPreview();
    return;
  }

  if (action === "request-reset-code") {
    await requestResetCode();
    return;
  }

  if (action === "logout") {
    await logout();
  }
}

function switchAuthMode(mode) {
  const nextMode = ["login", "register", "recover"].includes(mode) ? mode : "login";
  state.authMode = nextMode;

  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === nextMode);
  });

  nodes.loginForm.classList.toggle("hidden", nextMode !== "login");
  nodes.registerForm.classList.toggle("hidden", nextMode !== "register");
  nodes.recoverForm.classList.toggle("hidden", nextMode !== "recover");

  if (nextMode !== "recover") {
    setRecoverStepVisible(false);
    nodes.recoverPreviewNote.classList.add("hidden");
    nodes.recoverPreviewNote.textContent = "";
  }

  refreshRegisterAvatarPreview();
}

async function submitLogin(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    await request("/api/auth/login", {
      method: "POST",
      body: {
        email: formData.get("email"),
        password: formData.get("password")
      }
    });

    event.currentTarget.reset();
    await loadBootstrap();
    showToast("Sesion iniciada.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const password = `${formData.get("password") || ""}`;
  const confirmPassword = `${formData.get("confirmPassword") || ""}`;

  if (password !== confirmPassword) {
    showToast("Las contrasenas no coinciden.");
    return;
  }

  try {
    await request("/api/auth/register", {
      method: "POST",
      body: {
        name: formData.get("name"),
        email: formData.get("email"),
        password,
        inviteCode: formData.get("inviteCode"),
        avatarDataUrl: state.avatarDrafts.register || ""
      }
    });

    event.currentTarget.reset();
    state.avatarDrafts.register = "";
    refreshRegisterAvatarPreview();
    await loadBootstrap();
    showToast("Cuenta creada.");
  } catch (error) {
    showToast(error.message);
  }
}

async function requestResetCode() {
  const email = `${nodes.recoverEmail.value || ""}`.trim();
  if (!email) {
    showToast("Escribe tu email primero.");
    nodes.recoverEmail.focus();
    return;
  }

  try {
    const payload = await request("/api/auth/request-reset", {
      method: "POST",
      body: { email }
    });

    setRecoverStepVisible(true);
    nodes.recoverPreviewNote.classList.remove("hidden");

    if (payload.previewCode) {
      nodes.recoverPreviewNote.textContent = `Codigo temporal para pruebas locales: ${payload.previewCode}`;
    } else {
      nodes.recoverPreviewNote.textContent = "Si el correo existe, ya se genero un codigo temporal.";
    }

    showToast("Revisa el codigo temporal.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitRecover(event) {
  event.preventDefault();

  if (nodes.recoverStep.classList.contains("hidden")) {
    showToast("Primero solicita el codigo temporal.");
    return;
  }

  const email = `${nodes.recoverEmail.value || ""}`.trim();
  const code = `${nodes.recoverCode.value || ""}`.trim();
  const newPassword = `${nodes.recoverPassword.value || ""}`;
  const confirmPassword = `${nodes.recoverPasswordConfirm.value || ""}`;

  if (!email || !code || !newPassword) {
    showToast("Completa el correo, el codigo y la nueva contrasena.");
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast("Las contrasenas nuevas no coinciden.");
    return;
  }

  try {
    await request("/api/auth/reset-password", {
      method: "POST",
      body: {
        email,
        code,
        newPassword
      }
    });

    event.currentTarget.reset();
    setRecoverStepVisible(false);
    nodes.recoverPreviewNote.classList.add("hidden");
    nodes.recoverPreviewNote.textContent = "";
    await loadBootstrap();
    showToast("Contrasena restablecida.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitSettings(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const body = {
    name: formData.get("name"),
    currency: formData.get("currency")
  };

  if (state.avatarDrafts.settings !== undefined) {
    body.avatarDataUrl = state.avatarDrafts.settings;
  }

  try {
    await request("/api/settings", {
      method: "POST",
      body
    });

    state.avatarDrafts.settings = undefined;
    nodes.settingsAvatarInput.value = "";
    await loadBootstrap();
    showToast("Perfil actualizado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitAccount(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    await request("/api/accounts", {
      method: "POST",
      body: {
        name: formData.get("name"),
        type: formData.get("type"),
        scope: formData.get("scope"),
        openingBalance: Number(formData.get("openingBalance"))
      }
    });

    event.currentTarget.reset();
    closeAllModals();
    await loadBootstrap();
    showToast("Cuenta creada.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitPlanItem(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    await request("/api/plan-items", {
      method: "POST",
      body: {
        monthKey: state.monthKey,
        kind: formData.get("kind"),
        title: formData.get("title"),
        category: formData.get("category"),
        amount: Number(formData.get("amount")),
        dueDay: Number(formData.get("dueDay")),
        scope: formData.get("scope"),
        repeatMonthly: formData.get("repeatMonthly") === "on"
      }
    });

    event.currentTarget.reset();
    closeAllModals();
    await loadBootstrap();
    showToast("Item del mes guardado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitTransaction(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    await request("/api/transactions", {
      method: "POST",
      body: {
        kind: formData.get("kind"),
        accountId: formData.get("accountId"),
        planItemId: formData.get("planItemId") || "",
        category: formData.get("category"),
        amount: Number(formData.get("amount")),
        occurredOn: formData.get("occurredOn"),
        note: formData.get("note")
      }
    });

    event.currentTarget.reset();
    closeAllModals();
    await loadBootstrap();
    showToast("Movimiento guardado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function onRegisterAvatarSelected(event) {
  try {
    state.avatarDrafts.register = await readAvatarFromInput(event.currentTarget);
    refreshRegisterAvatarPreview();
  } catch (error) {
    event.currentTarget.value = "";
    state.avatarDrafts.register = "";
    refreshRegisterAvatarPreview();
    showToast(error.message);
  }
}

async function onSettingsAvatarSelected(event) {
  try {
    state.avatarDrafts.settings = await readAvatarFromInput(event.currentTarget);
    refreshSettingsAvatarPreview();
  } catch (error) {
    event.currentTarget.value = "";
    state.avatarDrafts.settings = undefined;
    refreshSettingsAvatarPreview();
    showToast(error.message);
  }
}

async function logout() {
  try {
    await request("/api/auth/logout", {
      method: "POST",
      body: {}
    });
  } catch {
    // noop
  }

  state.bootstrap = null;
  state.currentView = "dashboard";
  state.avatarDrafts.settings = undefined;
  closeAllModals();
  switchAuthMode("login");
  showAuthScreen();
  showToast("Sesion cerrada.");
}

async function copyInviteCode() {
  const inviteCode = state.bootstrap?.household?.inviteCode;
  if (!inviteCode) {
    showToast("Aun no hay codigo disponible.");
    return;
  }

  try {
    await navigator.clipboard.writeText(inviteCode);
    showToast("Codigo copiado.");
  } catch {
    showToast(`Codigo: ${inviteCode}`);
  }
}

async function loadBootstrap(options = {}) {
  try {
    const payload = await request(`/api/bootstrap?month=${state.monthKey}`, { method: "GET" });
    state.bootstrap = payload;
    state.avatarDrafts.settings = undefined;
    nodes.monthPicker.value = state.monthKey;
    showAppScreen();
    renderApp();
  } catch (error) {
    if (error.status === 401) {
      state.bootstrap = null;
      closeAllModals();
      showAuthScreen();
      if (!options.quietAuth) {
        showToast("Inicia sesion para continuar.");
      }
      return;
    }

    showToast(error.message);
  }
}

function showAuthScreen() {
  nodes.authScreen.classList.remove("hidden");
  nodes.appScreen.classList.add("hidden");
}

function showAppScreen() {
  nodes.authScreen.classList.add("hidden");
  nodes.appScreen.classList.remove("hidden");
}

function renderApp() {
  if (!state.bootstrap) {
    return;
  }

  renderViewState();
  renderHeader();
  renderDashboard();
  renderAccounts();
  renderTransactions();
  renderAnalytics();
  renderSettings();
}

function renderViewState() {
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${state.currentView}-view`);
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.currentView);
  });
}

function renderHeader() {
  const { user, household } = state.bootstrap;
  const partner = household.members.find((member) => member.id !== user.id);

  nodes.helloLine.textContent = `Hola, ${firstName(user.name)}`;
  nodes.householdTitle.textContent = "Home";
  nodes.dashboardWelcome.textContent = partner
    ? "Tus finanzas personales y el espacio compartido ya conviven sin mezclarse."
    : "Tu espacio privado ya esta listo y Home espera a tu pareja.";
  nodes.partnerStatus.textContent = partner
    ? "Lo tuyo solo lo ves tu. Lo compartido si lo ven ambos, con registros y presupuesto reales."
    : "Comparte tu codigo para activar el espacio compartido con tu pareja.";

  renderAvatar(nodes.headerAvatarPreview, nodes.headerAvatarFallback, user.avatarDataUrl, user.name);
}

function renderDashboard() {
  const { summary, household, accounts, planItems, transactions, analytics } = state.bootstrap;
  const topPersonal = analytics.categoryBreakdowns.personal[0];
  const topShared = analytics.categoryBreakdowns.shared[0];

  nodes.availableTotal.textContent = formatMoney(summary.availableTotal);
  nodes.idealBudgetTotal.textContent = formatMoney(summary.idealBudget);
  nodes.bankTotal.textContent = formatMoney(summary.bankTotal);
  nodes.cashTotal.textContent = formatMoney(summary.cashTotal);
  nodes.inviteCodePill.textContent = `Codigo ${household.inviteCode}`;

  nodes.dashboardScopeCards.innerHTML = analytics.scopes
    .map(renderScopeCard)
    .join("");

  nodes.dashboardInsights.innerHTML = [
    {
      label: "Ingresos reales",
      value: formatMoney(summary.actualIncome),
      hint: "Entradas registradas este mes."
    },
    {
      label: "Gastos reales",
      value: formatMoney(summary.actualExpense),
      hint: "Salidas registradas este mes."
    },
    {
      label: "Resultado real",
      value: formatMoney(summary.realizedBudget),
      hint: "Lo que realmente va dejando el mes."
    },
    {
      label: "Pendientes",
      value: `${summary.pendingItems}`,
      hint: "Items del checklist aun sin marcar."
    },
    {
      label: "Categoria personal",
      value: topPersonal ? escapeHtml(topPersonal.category) : "Sin gastos",
      hint: topPersonal ? formatMoney(topPersonal.total) : "Todavia no hay gastos en tu espacio."
    },
    {
      label: "Categoria compartida",
      value: topShared ? escapeHtml(topShared.category) : "Sin gastos",
      hint: topShared ? formatMoney(topShared.total) : "Todavia no hay gastos compartidos."
    }
  ].map(renderInsightCard).join("");

  nodes.trendChart.innerHTML = buildTrendChart(summary.trend);
  nodes.trendLabels.innerHTML = summary.trend
    .map((item) => `<span>${escapeHtml(item.label)}</span>`)
    .join("");

  renderAccountList(nodes.dashboardAccountPreview, accounts.slice(0, 4), {
    empty: "Aun no tienes cuentas. Crea la primera bancaria o de efectivo."
  });

  renderPlanList(
    nodes.dashboardPlanPreview,
    sortPlanItems(planItems.filter((item) => !item.completed)).slice(0, 4),
    { empty: "Todavia no agregas ingresos o gastos del mes." }
  );

  renderTransactionList(nodes.dashboardTransactions, transactions.slice(0, 5), {
    empty: "Todavia no hay movimientos en este mes."
  });
}

function renderAccounts() {
  const { accounts, summary, analytics } = state.bootstrap;
  const bankBreakdown = analytics.holdingsByType.find((item) => item.label === "Banco");
  const cashBreakdown = analytics.holdingsByType.find((item) => item.label === "Efectivo");

  nodes.accountsSummary.innerHTML = [
    {
      label: "Total en bancos",
      value: formatMoney(summary.bankTotal),
      hint: `Privado ${formatMoney(bankBreakdown?.personal || 0)} | Compartido ${formatMoney(bankBreakdown?.shared || 0)}`
    },
    {
      label: "Total en efectivo",
      value: formatMoney(summary.cashTotal),
      hint: `Privado ${formatMoney(cashBreakdown?.personal || 0)} | Compartido ${formatMoney(cashBreakdown?.shared || 0)}`
    },
    {
      label: "Cuentas privadas",
      value: `${accounts.filter((account) => account.scope === "personal").length}`,
      hint: "Solo visibles para ti."
    },
    {
      label: "Cuentas compartidas",
      value: `${accounts.filter((account) => account.scope === "shared").length}`,
      hint: "Visibles para ambos."
    }
  ].map(renderInsightCard).join("");

  renderAccountList(nodes.bankAccounts, accounts.filter((account) => account.type === "bank"), {
    empty: "No hay cuentas bancarias todavia."
  });

  renderAccountList(nodes.cashAccounts, accounts.filter((account) => account.type === "cash"), {
    empty: "No hay espacios de efectivo todavia."
  });
}

function renderTransactions() {
  const { transactions, summary } = state.bootstrap;
  const linked = transactions.filter((item) => item.planLinked).length;

  nodes.transactionSummary.innerHTML = [
    {
      label: "Ingresos del mes",
      value: formatMoney(summary.actualIncome),
      hint: "Todo lo registrado como entrada."
    },
    {
      label: "Gastos del mes",
      value: formatMoney(summary.actualExpense),
      hint: "Todo lo registrado como salida."
    },
    {
      label: "Balance real",
      value: formatMoney(summary.realizedBudget),
      hint: "Ingresos menos gastos ya registrados."
    },
    {
      label: "Ligados al plan",
      value: `${linked}`,
      hint: "Movimientos que tacharon items del checklist."
    }
  ].map(renderInsightCard).join("");

  renderTransactionList(nodes.transactionList, transactions, {
    empty: "Este mes aun no tiene registros."
  });
}

function renderAnalytics() {
  const { analytics, summary, planItems } = state.bootstrap;
  const incomeItems = sortPlanItems(planItems.filter((item) => item.kind === "income"));
  const expenseItems = sortPlanItems(planItems.filter((item) => item.kind === "expense"));

  nodes.analyticsScopeCards.innerHTML = analytics.scopes
    .map(renderScopeCard)
    .join("");

  renderDonutBreakdown(
    nodes.personalCategoryChart,
    nodes.personalCategoryLegend,
    analytics.categoryBreakdowns.personal,
    "Todavia no hay gastos personales en este mes."
  );

  renderDonutBreakdown(
    nodes.sharedCategoryChart,
    nodes.sharedCategoryLegend,
    analytics.categoryBreakdowns.shared,
    "Todavia no hay gastos compartidos en este mes."
  );

  renderWeeklyExpenseChart(analytics.weeklyExpenses);

  nodes.planSummary.innerHTML = [
    {
      label: "Ingresos planeados",
      value: formatMoney(summary.plannedIncome),
      note: `${summary.completedIncome}/${incomeItems.length || 0} registrados`
    },
    {
      label: "Gastos previstos",
      value: formatMoney(summary.plannedExpense),
      note: `${summary.completedExpense}/${expenseItems.length || 0} registrados`
    },
    {
      label: "Resultado real",
      value: formatMoney(summary.realizedBudget),
      note: "Lo que ya paso de verdad en el mes."
    },
    {
      label: "Presupuesto ideal",
      value: formatMoney(summary.idealBudget),
      note: "Ingresos previstos menos gastos previstos.",
      emphasis: true
    }
  ].map(renderSummaryCard).join("");

  renderPlanList(nodes.incomePlanList, incomeItems, {
    empty: "Aun no hay ingresos planeados para este mes."
  });

  renderPlanList(nodes.expensePlanList, expenseItems, {
    empty: "Aun no hay gastos planeados para este mes."
  });
}

function renderSettings() {
  const { user, household } = state.bootstrap;

  nodes.settingsName.value = user.name;
  nodes.settingsCurrency.value = household.currency;
  nodes.inviteCodeValue.textContent = household.inviteCode;
  refreshSettingsAvatarPreview();

  nodes.memberList.innerHTML = household.members.map((member) => {
    const isCurrentUser = member.id === user.id;
    return `
      <article class="member-card">
        <header>
          <div class="member-chip">
            ${renderAvatarMarkup(member.avatarDataUrl, member.name)}
            <div>
              <strong>${escapeHtml(member.name)}</strong>
              <span>${isCurrentUser ? "Tu espacio privado" : "Su espacio privado"}</span>
            </div>
          </div>
          <span class="scope-pill">${isCurrentUser ? "Tu" : "Pareja"}</span>
        </header>
      </article>
    `;
  }).join("");
}

function renderScopeCard(item) {
  const progress = item.totalItems ? `${item.completedItems}/${item.totalItems}` : "0/0";
  return `
    <article class="scope-card">
      <header>
        <div>
          <span>${escapeHtml(item.label)}</span>
          <strong>${formatMoney(item.available)}</strong>
        </div>
        <span class="scope-badge">${progress}</span>
      </header>
      <span>Ingresos ${formatMoney(item.income)}</span>
      <span>Gastos ${formatMoney(item.expense)}</span>
      <span>Planeado ${formatMoney(item.plannedIncome - item.plannedExpense)}</span>
      <span>${item.totalItems ? `${progress} del checklist` : "Sin items planeados"}</span>
    </article>
  `;
}

function renderInsightCard(item) {
  return `
    <article class="insight-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${item.value}</strong>
      <span>${escapeHtml(item.hint)}</span>
    </article>
  `;
}

function renderSummaryCard(item) {
  return `
    <article class="summary-card ${item.emphasis ? "emphasis" : ""}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${item.value}</strong>
      <small>${escapeHtml(item.note)}</small>
    </article>
  `;
}

function renderAccountList(container, accounts, options) {
  if (!accounts.length) {
    container.innerHTML = renderEmptyCard(options.empty);
    return;
  }

  container.innerHTML = accounts.map((account) => `
    <article class="account-card">
      <header>
        <div>
          <span class="scope-pill">${escapeHtml(account.scopeLabel)}</span>
          <h4>${escapeHtml(account.name)}</h4>
        </div>
        <span class="fixed-pill">${account.type === "bank" ? "Banco" : "Efectivo"}</span>
      </header>
      <strong>${formatMoney(account.balance)}</strong>
      <footer>
        <span>Saldo inicial ${formatMoney(account.openingBalance)}</span>
        <span>${escapeHtml(account.colorName)}</span>
      </footer>
    </article>
  `).join("");
}

function renderPlanList(container, items, options) {
  if (!items.length) {
    container.innerHTML = renderEmptyCard(options.empty);
    return;
  }

  container.innerHTML = items.map((item) => `
    <article class="plan-card ${item.completed ? "is-done" : ""}">
      <header>
        <div>
          <span class="scope-pill">${escapeHtml(item.scopeLabel)}</span>
          <h4>${escapeHtml(item.title)}</h4>
        </div>
        ${item.completed
          ? '<span class="status-pill">Registrado</span>'
          : '<span class="fixed-pill">Pendiente</span>'}
      </header>
      <strong class="plan-amount">${formatMoney(item.amount)}</strong>
      <span class="plan-line">${escapeHtml(item.category)} | Dia ${item.dueDay}</span>
      <footer>
        <span>${item.isFixed ? "Fijo mensual" : "Solo este mes"}</span>
        ${item.completed
          ? `<span>${formatDate(item.completedAt || `${item.monthKey}-01`)}</span>`
          : `<div class="plan-actions"><button class="ghost-btn compact" data-action="register-plan-item" data-plan-id="${item.id}" type="button">Registrar</button></div>`}
      </footer>
    </article>
  `).join("");
}

function renderTransactionList(container, items, options) {
  if (!items.length) {
    container.innerHTML = renderEmptyCard(options.empty);
    return;
  }

  container.innerHTML = items.map((item) => `
    <article class="transaction-card">
      <header>
        <div>
          <span class="scope-pill">${escapeHtml(item.scopeLabel)}</span>
          <h4>${escapeHtml(item.category)}</h4>
        </div>
        <strong class="amount ${item.kind}">
          ${item.kind === "income" ? "+" : "-"}${formatMoney(item.amount)}
        </strong>
      </header>
      <span>${escapeHtml(item.accountName)} | ${item.accountType === "bank" ? "Banco" : "Efectivo"}</span>
      ${item.note ? `<span>${escapeHtml(item.note)}</span>` : ""}
      <footer>
        <span>${formatDate(item.occurredOn)}</span>
        <span>${item.planLinked ? "Marco un item del plan" : "Registro libre"}</span>
      </footer>
    </article>
  `).join("");
}

function renderDonutBreakdown(chartNode, legendNode, rows, emptyMessage) {
  const total = rows.reduce((sum, item) => sum + item.total, 0);
  if (!rows.length || total <= 0) {
    chartNode.innerHTML = renderEmptyCard(emptyMessage);
    legendNode.innerHTML = "";
    return;
  }

  let start = 0;
  const segments = rows.map((item, index) => {
    const share = (item.total / total) * 100;
    const end = start + share;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    const segment = `${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    start = end;
    return segment;
  });

  chartNode.innerHTML = `
    <div class="donut-chart" style="background: conic-gradient(${segments.join(", ")});">
      <div class="donut-center">
        <span>Total</span>
        <strong>${formatMoney(total)}</strong>
      </div>
    </div>
  `;

  legendNode.innerHTML = rows.map((item, index) => {
    const color = CHART_COLORS[index % CHART_COLORS.length];
    const percentage = total ? Math.round((item.total / total) * 100) : 0;
    return `
      <div class="legend-item">
        <span class="legend-dot" style="background:${color};"></span>
        <span>${escapeHtml(item.category)}</span>
        <strong>${formatMoney(item.total)}</strong>
        <span>${percentage}%</span>
      </div>
    `;
  }).join("");
}

function renderWeeklyExpenseChart(rows) {
  const max = Math.max(
    ...rows.flatMap((row) => [row.personal, row.shared]),
    0
  );

  if (!rows.length || max <= 0) {
    nodes.weeklyExpenseChart.innerHTML = renderEmptyCard("Aun no hay gastos suficientes para comparar semanas.");
    nodes.weeklyExpenseLegend.innerHTML = "";
    return;
  }

  nodes.weeklyExpenseChart.innerHTML = rows.map((row) => `
    <div class="bar-group">
      <div class="bar-pair">
        <span class="bar" style="height:${barHeight(row.personal, max)}rem;" title="Mi espacio ${formatMoney(row.personal)}"></span>
        <span class="bar shared" style="height:${barHeight(row.shared, max)}rem;" title="Compartido ${formatMoney(row.shared)}"></span>
      </div>
      <span class="bar-label">${escapeHtml(row.label)}</span>
    </div>
  `).join("");

  const personalTotal = rows.reduce((sum, item) => sum + item.personal, 0);
  const sharedTotal = rows.reduce((sum, item) => sum + item.shared, 0);

  nodes.weeklyExpenseLegend.innerHTML = `
    <span class="chart-pill">Mi espacio ${formatMoney(personalTotal)}</span>
    <span class="chart-pill shared">Compartido ${formatMoney(sharedTotal)}</span>
  `;
}

function buildTrendChart(points) {
  if (!points.length) {
    return renderEmptyCard("Sin tendencia disponible.");
  }

  const width = 340;
  const height = 176;
  const paddingX = 18;
  const paddingY = 18;
  const values = points.map((item) => item.net);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;

  const mapped = points.map((item, index) => {
    const x = paddingX + (index * (width - paddingX * 2)) / Math.max(points.length - 1, 1);
    const y = height - paddingY - ((item.net - min) / range) * (height - paddingY * 2);
    return { x, y };
  });

  const linePath = mapped
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${mapped[mapped.length - 1].x.toFixed(2)} ${(height - paddingY).toFixed(2)} L ${mapped[0].x.toFixed(2)} ${(height - paddingY).toFixed(2)} Z`;

  return `
    <svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tendencia mensual">
      <defs>
        <linearGradient id="trend-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#8e63ff" stop-opacity="0.34"></stop>
          <stop offset="100%" stop-color="#ff8eaa" stop-opacity="0.04"></stop>
        </linearGradient>
        <linearGradient id="trend-line" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#8e63ff"></stop>
          <stop offset="100%" stop-color="#ff8eaa"></stop>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#trend-area)"></path>
      <path d="${linePath}" fill="none" stroke="url(#trend-line)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
      ${mapped.map((point) => `
        <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4.8" fill="#ffffff"></circle>
        <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.8" fill="#8e63ff"></circle>
      `).join("")}
    </svg>
  `;
}

function openAccountModal() {
  nodes.accountForm.reset();
  showModal(nodes.accountModal);
}

function openPlanModal(kind) {
  nodes.planForm.reset();
  nodes.planKind.value = kind || "expense";
  nodes.planForm.querySelector("input[name='dueDay']").value = `${new Date().getDate()}`;
  showModal(nodes.planModal);
}

function openTransactionModal(options = {}) {
  if (!state.bootstrap?.accounts?.length) {
    showToast("Primero crea una cuenta bancaria o de efectivo.");
    return;
  }

  nodes.transactionForm.reset();
  nodes.transactionKind.value = options.kind || "expense";
  nodes.transactionDate.value = isCurrentMonth(state.monthKey) ? currentDateIso() : `${state.monthKey}-01`;

  let preferredScope = "";
  let preferredPlanId = "";

  if (options.planItemId) {
    const item = state.bootstrap.planItems.find((entry) => entry.id === options.planItemId);
    if (item) {
      preferredScope = item.scope;
      preferredPlanId = item.id;
      nodes.transactionKind.value = item.kind;
      nodes.transactionCategory.value = item.category;
      nodes.transactionAmount.value = `${item.amount}`;
    }
  }

  populateTransactionAccounts({ preferredScope });
  refreshTransactionPlanOptions(preferredPlanId);
  showModal(nodes.transactionModal);
}

function showModal(modal) {
  nodes.modalBackdrop.classList.remove("hidden");
  [nodes.transactionModal, nodes.accountModal, nodes.planModal].forEach((entry) => {
    const active = entry === modal;
    entry.classList.toggle("hidden", !active);
    entry.setAttribute("aria-hidden", active ? "false" : "true");
  });
}

function closeAllModals() {
  nodes.modalBackdrop.classList.add("hidden");
  [nodes.transactionModal, nodes.accountModal, nodes.planModal].forEach((entry) => {
    entry.classList.add("hidden");
    entry.setAttribute("aria-hidden", "true");
  });
}

function populateTransactionAccounts(options = {}) {
  const accounts = state.bootstrap?.accounts || [];
  if (!accounts.length) {
    nodes.transactionAccount.innerHTML = "";
    return;
  }

  nodes.transactionAccount.innerHTML = accounts.map((account) => `
    <option value="${account.id}">
      ${escapeHtml(account.name)} | ${account.type === "bank" ? "Banco" : "Efectivo"} | ${escapeHtml(account.scopeLabel)}
    </option>
  `).join("");

  const preferredAccount = options.preferredAccountId
    ? accounts.find((account) => account.id === options.preferredAccountId)
    : accounts.find((account) => account.scope === options.preferredScope);

  if (preferredAccount) {
    nodes.transactionAccount.value = preferredAccount.id;
  }
}

function refreshTransactionPlanOptions(preferredId = "") {
  if (!state.bootstrap) {
    return;
  }

  const accounts = state.bootstrap.accounts || [];
  const selectedAccount = accounts.find((account) => account.id === nodes.transactionAccount.value) || accounts[0];

  if (!selectedAccount) {
    nodes.transactionPlanItem.innerHTML = '<option value="">Crea primero una cuenta</option>';
    return;
  }

  const selectedKind = nodes.transactionKind.value;
  const monthKey = `${nodes.transactionDate.value || `${state.monthKey}-01`}`.slice(0, 7);

  const options = state.bootstrap.planItems.filter((item) => {
    return !item.completed
      && item.kind === selectedKind
      && item.scope === selectedAccount.scope
      && item.monthKey === monthKey;
  });

  nodes.transactionPlanItem.innerHTML = [
    '<option value="">Sin vincular al plan</option>',
    ...options.map((item) => `
      <option value="${item.id}">
        ${escapeHtml(item.title)} | ${formatMoney(item.amount)} | dia ${item.dueDay}
      </option>
    `)
  ].join("");

  if (preferredId && options.some((item) => item.id === preferredId)) {
    nodes.transactionPlanItem.value = preferredId;
  }
}

function refreshRegisterAvatarPreview() {
  renderAvatar(
    nodes.registerAvatarPreview,
    nodes.registerAvatarFallback,
    state.avatarDrafts.register,
    nodes.registerNameInput.value || "Home"
  );
}

function refreshSettingsAvatarPreview() {
  const user = state.bootstrap?.user;
  const dataUrl = state.avatarDrafts.settings !== undefined
    ? state.avatarDrafts.settings
    : user?.avatarDataUrl || "";

  renderAvatar(
    nodes.settingsAvatarPreview,
    nodes.settingsAvatarFallback,
    dataUrl,
    nodes.settingsName.value || user?.name || "Home"
  );
}

function setRecoverStepVisible(visible) {
  nodes.recoverStep.classList.toggle("hidden", !visible);
  [nodes.recoverCode, nodes.recoverPassword, nodes.recoverPasswordConfirm].forEach((input) => {
    input.required = visible;
  });
}

function renderAvatar(imageNode, fallbackNode, dataUrl, seedText) {
  fallbackNode.textContent = getInitials(seedText);

  if (dataUrl) {
    imageNode.src = dataUrl;
    imageNode.classList.remove("hidden");
    fallbackNode.classList.add("hidden");
    return;
  }

  imageNode.removeAttribute("src");
  imageNode.classList.add("hidden");
  fallbackNode.classList.remove("hidden");
}

function renderAvatarMarkup(dataUrl, name) {
  if (dataUrl) {
    return `
      <span class="avatar avatar-sm">
        <img class="avatar-image" src="${escapeHtml(dataUrl)}" alt="${escapeHtml(name)}">
      </span>
    `;
  }

  return `
    <span class="avatar avatar-sm">
      <span class="avatar-fallback">${escapeHtml(getInitials(name))}</span>
    </span>
  `;
}

function renderEmptyCard(message) {
  return `<article class="empty-card">${escapeHtml(message)}</article>`;
}

function sortPlanItems(items) {
  return [...items].sort((left, right) => {
    if (left.completed !== right.completed) {
      return Number(left.completed) - Number(right.completed);
    }

    if (left.dueDay !== right.dueDay) {
      return left.dueDay - right.dueDay;
    }

    return left.title.localeCompare(right.title, "es");
  });
}

function barHeight(value, max) {
  if (value <= 0 || max <= 0) {
    return 0.3;
  }
  return 0.3 + (value / max) * 8.4;
}

async function readAvatarFromInput(input) {
  const file = input.files?.[0];
  if (!file) {
    return "";
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("Selecciona una imagen valida.");
  }

  let dataUrl = await readFileAsDataUrl(file);
  if (dataUrl.length <= AVATAR_SOFT_LIMIT) {
    return dataUrl;
  }

  const image = await loadImage(dataUrl);
  let longestSide = 720;
  let quality = 0.9;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    dataUrl = await compressImage(image, longestSide, quality);
    if (dataUrl.length <= AVATAR_MAX_DATA_URL_LENGTH) {
      return dataUrl;
    }

    longestSide = Math.max(240, Math.floor(longestSide * 0.82));
    quality = Math.max(0.45, quality - 0.1);
  }

  throw new Error("La foto es demasiado pesada. Prueba con una imagen mas ligera.");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("No se pudo procesar la imagen."));
    image.src = dataUrl;
  });
}

function compressImage(image, longestSide, quality) {
  const ratio = image.width && image.height
    ? Math.min(1, longestSide / Math.max(image.width, image.height))
    : 1;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function formatMoney(value) {
  const currency = state.bootstrap?.household?.currency || "COP";
  const locales = {
    COP: "es-CO",
    USD: "en-US",
    EUR: "es-ES",
    MXN: "es-MX"
  };

  return new Intl.NumberFormat(locales[currency] || "es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "Sin fecha";
  }

  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function showToast(message) {
  nodes.toast.textContent = message;
  nodes.toast.classList.remove("hidden");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    nodes.toast.classList.add("hidden");
  }, 2600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const raw = await response.text();
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { error: raw || "Error inesperado." };
  }

  if (!response.ok) {
    const error = new Error(payload.error || "Algo salio mal.");
    error.status = response.status;
    throw error;
  }

  return payload;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      nodes.installBtn.classList.add("hidden");
    });
  });
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentDateIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isCurrentMonth(monthKey) {
  return monthKey === currentMonthKey();
}

function getInitials(value) {
  const words = `${value || ""}`.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "H";
  }

  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function firstName(value) {
  const words = `${value || ""}`.trim().split(/\s+/).filter(Boolean);
  return words[0] || "Home";
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
