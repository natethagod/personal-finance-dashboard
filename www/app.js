(() => {
  "use strict";

  const STORAGE_KEY = "finance-dashboard-v1";
  const LEGACY_GOALS_KEY = "finance-dashboard-goals-v1"; // goals used to live here; migrated on load
  const SAVINGS_ID = "savings"; // the expense category goal contributions are filed under
  const OTHER_ID = "other"; // fallback category in each list; entries from deleted categories move here
  const DEFAULT_ACCENT = "#2f6bff";

  const ACCENTS = [
    ["Cobalt", "#2f6bff"],
    ["Crimson", "#e5484d"],
    ["Emerald", "#12a874"],
    ["Violet", "#8b5cf6"],
    ["Amber", "#f59e0b"],
    ["Teal", "#14b8a6"],
    ["Pink", "#ec4899"],
  ];

  const DEFAULT_CATEGORIES = {
    income: ["Salary", "Freelance", "Investments", "Gifts", "Refunds", "Other"],
    expense: ["Housing", "Food & Dining", "Transportation", "Utilities", "Entertainment", "Shopping", "Health", "Savings", "Other"],
  };

  // ---------- Helpers ----------
  const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const fmt = (n) => money.format(n);
  const round2 = (n) => Math.round(n * 100) / 100;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sum = (list) => round2(list.reduce((acc, t) => acc + t.amount, 0));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const listJoin = (items) => (items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]);

  // ---------- Dates (local time, not UTC) ----------
  const pad = (n) => String(n).padStart(2, "0");
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const currentMonthKey = () => todayISO().slice(0, 7);
  const parseISO = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const monthLabel = (key) => parseISO(key + "-01").toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const monthName = (key) => parseISO(key + "-01").toLocaleDateString(undefined, { month: "long" });
  const dateLabel = (iso) => parseISO(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const daysUntil = (iso) => Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
  const monthsBetween = (fromKey, toKey) => {
    const [fy, fm] = fromKey.split("-").map(Number);
    const [ty, tm] = toKey.split("-").map(Number);
    return (ty - fy) * 12 + (tm - fm);
  };

  // ---------- State ----------
  function defaultCategories() {
    const out = {};
    for (const type of ["income", "expense"]) {
      out[type] = DEFAULT_CATEGORIES[type].map((name) => ({ id: name === "Savings" ? SAVINGS_ID : slug(name), name }));
    }
    return out;
  }

  let migratedLegacy = false;

  function load() {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (_) { data = {}; }

    const s = {
      transactions: Array.isArray(data.transactions) ? data.transactions : [],
      budgets: data.budgets && typeof data.budgets === "object" ? data.budgets : {},
      // Monthly snapshots of budget limits ({ "2026-11": { Housing: 2000, ... } }) so past
      // months are judged against the limits that applied then, not today's.
      budgetHistory: data.budgetHistory && typeof data.budgetHistory === "object" ? data.budgetHistory : {},
      goals: Array.isArray(data.goals) ? data.goals : [],
      categories:
        data.categories && Array.isArray(data.categories.income) && Array.isArray(data.categories.expense)
          ? data.categories
          : defaultCategories(),
      settings: { theme: "dark", accent: DEFAULT_ACCENT, ...(data.settings || {}) },
    };

    // Always have a Savings category for goal contributions.
    if (!s.categories.expense.some((c) => c.id === SAVINGS_ID)) {
      const otherIdx = s.categories.expense.findIndex((c) => c.name === "Other");
      const existing = s.categories.expense.find((c) => c.name === "Savings");
      if (existing) existing.id = SAVINGS_ID;
      else s.categories.expense.splice(otherIdx === -1 ? s.categories.expense.length : otherIdx, 0, { id: SAVINGS_ID, name: "Savings" });
    }

    // Always have a permanent "Other" category in each list.
    for (const type of ["income", "expense"]) {
      const list = s.categories[type];
      if (list.some((c) => c.id === OTHER_ID)) continue;
      const named = list.find((c) => c.name === "Other");
      if (named) named.id = OTHER_ID;
      else list.push({ id: OTHER_ID, name: "Other" });
    }

    // Migrate goals saved by the earlier standalone Savings Goals module.
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_GOALS_KEY) || "null");
      if (legacy && Array.isArray(legacy.goals)) {
        const savingsName = s.categories.expense.find((c) => c.id === SAVINGS_ID).name;
        for (const g of legacy.goals) {
          if (s.goals.some((x) => x.id === g.id)) continue;
          s.goals.push({ id: g.id, name: g.name, target: g.target, date: g.date, created: g.created });
          for (const c of g.contributions || []) {
            s.transactions.push({
              id: c.id, type: "expense", description: `Saved for ${g.name}`, amount: c.amount,
              category: savingsName, date: c.date, created: c.created, goalId: g.id,
            });
          }
        }
        migratedLegacy = true;
      }
    } catch (_) { /* ignore */ }

    // Any category used by an existing entry must exist in the list.
    for (const t of s.transactions) {
      const list = s.categories[t.type];
      if (list && !list.some((c) => c.name === t.category)) list.push({ id: uid(), name: t.category });
    }
    return s;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  const state = load();
  if (migratedLegacy) {
    try { localStorage.removeItem(LEGACY_GOALS_KEY); } catch (_) { /* ignore */ }
  }

  // Record this month's limits. Called on load and whenever limits change.
  function snapshotBudgets() {
    state.budgetHistory[currentMonthKey()] = { ...state.budgets };
  }
  snapshotBudgets();
  save();

  // Limits that applied in a given month: that month's snapshot, else the most recent
  // earlier one. Months before any snapshot fall back to the earliest one we have.
  function budgetsFor(key) {
    if (key === currentMonthKey()) return { limits: state.budgets, source: key };
    const keys = Object.keys(state.budgetHistory).sort();
    const earlier = keys.filter((k) => k <= key);
    const source = earlier.length ? earlier[earlier.length - 1] : keys[0];
    return source ? { limits: state.budgetHistory[source] || {}, source } : { limits: {}, source: null };
  }

  const catNames = (type) => state.categories[type].map((c) => c.name);
  const savingsName = () => state.categories.expense.find((c) => c.id === SAVINGS_ID).name;
  const otherName = (type) => state.categories[type].find((c) => c.id === OTHER_ID).name;

  const byType = (type) =>
    state.transactions
      .filter((t) => t.type === type)
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);

  const inMonth = (t, key) => t.date.slice(0, 7) === key;

  function spentByCategory(key) {
    const out = {};
    for (const t of state.transactions) {
      if (t.type === "expense" && inMonth(t, key)) out[t.category] = round2((out[t.category] || 0) + t.amount);
    }
    return out;
  }

  // ---------- Goals ----------
  const goalById = (id) => state.goals.find((g) => g.id === id);
  const goalTx = (id) => state.transactions.filter((t) => t.goalId === id);
  const savedFor = (id) => sum(goalTx(id));

  // How much a goal needs this calendar month to stay on track: whatever is left
  // at the start of the month, split evenly over the months up to the target date.
  function goalPlan(g, key = currentMonthKey()) {
    const txs = goalTx(g.id);
    const saved = sum(txs);
    const done = saved >= g.target;
    const before = sum(txs.filter((t) => t.date < key + "-01"));
    const thisMonth = sum(txs.filter((t) => inMonth(t, key)));
    const monthsLeft = monthsBetween(key, g.date.slice(0, 7)) + 1; // includes this month
    const remainingAtStart = Math.max(0, g.target - before);
    const monthlyTarget = done ? 0 : monthsLeft <= 0 ? remainingAtStart : remainingAtStart / monthsLeft;
    const stillNeeded = done ? 0 : round2(Math.min(Math.max(0, monthlyTarget - thisMonth), g.target - saved));
    return {
      saved, done, thisMonth, stillNeeded,
      monthlyTarget: round2(monthlyTarget),
      remaining: round2(Math.max(0, g.target - saved)),
      overdue: !done && g.date < todayISO(),
    };
  }

  // ---------- Appearance ----------
  const hexToRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || "");
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const mix = (rgb, target, t) => rgb.map((v, i) => Math.round(v + (target[i] - v) * t));
  const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  function applyAppearance(accentOverride) {
    const root = document.documentElement;
    const light = state.settings.theme === "light";
    root.dataset.theme = light ? "light" : "dark";
    const rgb = hexToRgb(accentOverride || state.settings.accent) || hexToRgb(DEFAULT_ACCENT);
    root.style.setProperty("--accent", toHex(rgb));
    root.style.setProperty("--accent-rgb", rgb.join(", "));
    // "strong" is used for accent-coloured text: lighter on dark, darker on light, for contrast.
    root.style.setProperty("--accent-strong", toHex(light ? mix(rgb, [0, 0, 0], 0.2) : mix(rgb, [255, 255, 255], 0.22)));
    root.style.setProperty("--accent-deep", toHex(mix(rgb, [0, 0, 0], 0.4)));
    root.style.setProperty("--on-accent", luminance(rgb) > 0.4 ? "#111114" : "#ffffff");
  }

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // In-page confirmation dialog. (window.confirm is suppressed in some embedded
  // browsers, where it returns false instantly and silently cancels the action.)
  function askConfirm({ title, message, confirmLabel = "Delete" }) {
    return new Promise((resolve) => {
      const wrap = $("#confirm");
      const ok = $("#confirmOk");
      const cancel = $("#confirmCancel");
      $("#confirmTitle").textContent = title;
      $("#confirmMsg").textContent = message;
      ok.textContent = confirmLabel;
      const prevFocus = document.activeElement;
      wrap.hidden = false;
      cancel.focus();

      const finish = (value) => {
        wrap.hidden = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        wrap.removeEventListener("mousedown", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        if (prevFocus && prevFocus.isConnected) prevFocus.focus();
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (e) => { if (e.target === wrap) finish(false); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
        else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      };
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      wrap.addEventListener("mousedown", onBackdrop);
      document.addEventListener("keydown", onKey, true);
    });
  }

  // ---------- Navigation ----------
  const VIEWS = ["dashboard", "income", "expenses", "budget", "goals", "history", "settings"];
  function show(view) {
    if (!VIEWS.includes(view)) view = "dashboard";
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    try { sessionStorage.setItem("fd-view", view); } catch (_) {}
    window.scrollTo(0, 0);
  }
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (go) show(go.dataset.goto);
  });

  // ---------- Transactions ----------
  const delIcon = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function txItem(t, { deletable = true } = {}) {
    const isIn = t.type === "income";
    const goal = t.goalId ? goalById(t.goalId) : null;
    return `<li class="tx">
      <span class="tx-icon ${isIn ? "in" : "out"}">${esc(t.category.charAt(0))}</span>
      <div class="tx-main">
        <div class="tx-desc">${esc(t.description)}</div>
        <div class="tx-meta">${esc(t.category)} · ${dateLabel(t.date)}${goal ? ` · <span class="tx-goal">Goal: ${esc(goal.name)}</span>` : ""}</div>
      </div>
      <span class="tx-amt ${isIn ? "income" : "expense"}">${isIn ? "+" : "−"}${fmt(t.amount)}</span>
      ${deletable ? `<button class="tx-del" data-id="${t.id}" aria-label="Delete ${esc(t.description)}">${delIcon}</button>` : ""}
    </li>`;
  }

  function renderList(type) {
    const list = byType(type);
    const el = $(type === "income" ? "#incomeList" : "#expenseList");
    $(type === "income" ? "#incomeCount" : "#expenseCount").textContent = list.length;
    el.innerHTML = list.length
      ? list.map((t) => txItem(t)).join("")
      : `<li class="empty">No ${type === "income" ? "income" : "expenses"} recorded yet.</li>`;
  }

  function barClass(spent, limit) {
    if (!limit) return "none";
    const pct = spent / limit;
    if (pct > 1) return "over";
    if (pct >= 0.8) return "warn";
    return "ok";
  }

  // ---------- Insights ----------
  function buildInsights(key, monthTx, income, expenses) {
    const month = monthName(key);
    const net = round2(income - expenses);
    const spent = spentByCategory(key);
    const ranked = Object.entries(spent).sort((a, b) => b[1] - a[1]);
    const activeGoals = state.goals
      .map((g) => ({ g, p: goalPlan(g, key) }))
      .filter(({ p }) => !p.done);
    const sentences = [];
    const points = [];

    if (!monthTx.length && !activeGoals.length) {
      return {
        summary: `No entries for ${month} yet. Add some income and expenses and this section will summarize where your money is going.`,
        points,
      };
    }

    if (monthTx.length) {
      // Highest spending category
      if (ranked.length) {
        const [topCat, topAmt] = ranked[0];
        let s = `Your highest spending category in ${month} is <b>${esc(topCat)}</b> at <b>${fmt(topAmt)}</b>`;
        s += ranked.length > 1 ? `, ${Math.round((topAmt / expenses) * 100)}% of everything you spent.` : `, the only category with spending so far.`;
        if (ranked.length > 1) s += ` ${esc(ranked[1][0])} comes next at ${fmt(ranked[1][1])}.`;
        sentences.push(s);
        points.push({ tone: "", html: `Top category: <b>${esc(topCat)}</b> (${fmt(topAmt)})` });
      } else {
        sentences.push(`You haven't recorded any expenses in ${month} yet.`);
      }

      // Overall balance
      if (net > 0) {
        const rate = income > 0 ? Math.round((net / income) * 100) : 0;
        sentences.push(
          `Overall your balance is <b class="income">positive</b>: you brought in ${fmt(income)} and spent ${fmt(expenses)}, leaving you <b>${fmt(net)}</b> ahead${income > 0 ? `, which is ${rate}% of your income` : ""}.`
        );
        points.push({ tone: "good", html: `Balance: <b>+${fmt(net)}</b> · ${rate}% of income kept` });
      } else if (net < 0) {
        sentences.push(
          income > 0
            ? `Overall your balance is <b class="expense">negative</b>: you've spent ${fmt(expenses)} against ${fmt(income)} of income, which is <b>${fmt(-net)}</b> more than you earned.`
            : `Overall your balance is <b class="expense">negative</b>: you've spent ${fmt(expenses)} and haven't recorded any income in ${month} yet.`
        );
        points.push({ tone: "bad", html: `Balance: <b>−${fmt(-net)}</b> · spending exceeds income` });
      } else {
        sentences.push(`Overall you've <b>broken even</b>: income and expenses both come to ${fmt(income)}.`);
        points.push({ tone: "", html: `Balance: <b>${fmt(0)}</b> · broke even` });
      }
    } else {
      sentences.push(`No income or expenses recorded for ${month} yet.`);
    }

    // Savings goals: how much to set aside this month
    if (activeGoals.length) {
      const needing = activeGoals.filter(({ p }) => p.stillNeeded > 0);
      const total = round2(needing.reduce((a, { p }) => a + p.stillNeeded, 0));
      if (!needing.length) {
        sentences.push(
          activeGoals.length === 1
            ? `You've already set aside enough this month to stay on track for <b>${esc(activeGoals[0].g.name)}</b>.`
            : `You've already set aside enough this month to stay on track for all ${activeGoals.length} savings goals.`
        );
        points.push({ tone: "good", html: `Savings goals: <b>on track</b> this month` });
      } else if (needing.length === 1) {
        const { g, p } = needing[0];
        const sofar = p.thisMonth > 0 ? ` (you've put in ${fmt(p.thisMonth)} so far)` : "";
        sentences.push(
          p.overdue
            ? `Your <b>${esc(g.name)}</b> goal is past its target date; you need <b>${fmt(p.stillNeeded)}</b> more to reach it.`
            : `To reach <b>${esc(g.name)}</b> by ${dateLabel(g.date)}, set aside <b>${fmt(p.stillNeeded)}</b> more this month${sofar}.`
        );
        points.push({ tone: "warn", html: `Save this month: <b>${fmt(total)}</b> for ${esc(g.name)}` });
      } else {
        const parts = needing.map(({ g, p }) => `${esc(g.name)} ${fmt(p.stillNeeded)}${p.overdue ? " (past due)" : ""}`);
        sentences.push(`To stay on track with your savings goals, set aside <b>${fmt(total)}</b> more this month: ${listJoin(parts)}.`);
        points.push({ tone: "warn", html: `Save this month: <b>${fmt(total)}</b> across ${plural(needing.length, "goal")}` });
      }
    }

    if (monthTx.length) {
      // Budget health
      const limited = catNames("expense").filter((c) => state.budgets[c] > 0);
      if (limited.length) {
        const over = limited.filter((c) => (spent[c] || 0) > state.budgets[c]);
        const near = limited.filter((c) => {
          const r = (spent[c] || 0) / state.budgets[c];
          return r >= 0.8 && r <= 1;
        });
        if (over.length) {
          sentences.push(`Heads up: you're over budget in ${listJoin(over.map(esc))}.`);
          points.push({ tone: "bad", html: `Over budget: <b>${listJoin(over.map(esc))}</b>` });
        } else if (near.length) {
          points.push({ tone: "warn", html: `Close to limit: <b>${listJoin(near.map(esc))}</b>` });
        } else {
          points.push({ tone: "good", html: `All <b>${limited.length}</b> budgeted ${limited.length === 1 ? "category is" : "categories are"} on track` });
        }
      }

      // Largest single expense
      const biggest = monthTx.filter((t) => t.type === "expense").sort((a, b) => b.amount - a.amount)[0];
      if (biggest) points.push({ tone: "", html: `Largest expense: <b>${esc(biggest.description)}</b> (${fmt(biggest.amount)})` });
    }

    return { summary: sentences.join(" "), points };
  }

  function renderInsights(key, monthTx, income, expenses) {
    const { summary, points } = buildInsights(key, monthTx, income, expenses);
    $("#insightsSummary").innerHTML = summary;
    $("#insightsPoints").innerHTML = points
      .map((p) => `<li class="insight"><span class="insight-dot ${p.tone}"></span><span>${p.html}</span></li>`)
      .join("");
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const key = currentMonthKey();
    const monthTx = state.transactions.filter((t) => inMonth(t, key));
    const income = sum(monthTx.filter((t) => t.type === "income"));
    const expenses = sum(monthTx.filter((t) => t.type === "expense"));
    const toGoals = sum(monthTx.filter((t) => t.goalId));
    const net = round2(income - expenses);

    $("#dashMonth").textContent = `Overview for ${monthLabel(key)}`;
    $("#sidebarMonth").innerHTML = `Current month<strong>${monthLabel(key)}</strong>`;
    $("#statIncome").textContent = fmt(income);
    $("#statExpenses").textContent = fmt(expenses);
    $("#statExpensesSub").textContent = toGoals > 0 ? `Includes ${fmt(toGoals)} set aside for goals` : "";
    const netEl = $("#statNet");
    netEl.textContent = (net < 0 ? "−" : "") + fmt(Math.abs(net));
    netEl.className = "stat-value " + (net < 0 ? "expense" : net > 0 ? "income" : "");

    renderInsights(key, monthTx, income, expenses);

    const recent = [...monthTx].sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created).slice(0, 6);
    const recentEl = $("#recentList");
    recentEl.classList.add("compact");
    recentEl.innerHTML = recent.length
      ? recent.map((t) => txItem(t, { deletable: false })).join("")
      : '<li class="empty">No activity this month yet.</li>';

    const spent = spentByCategory(key);
    const budgeted = catNames("expense").filter((c) => state.budgets[c] > 0);
    const mini = $("#dashBudget");
    if (!budgeted.length) {
      mini.innerHTML = '<p class="empty">No budgets set. <button class="link-btn" data-goto="budget">Set one up</button></p>';
      return;
    }
    mini.innerHTML = budgeted
      .map((c) => {
        const s = spent[c] || 0, l = state.budgets[c];
        return `<div class="mini-row">
          <div class="budget-info"><span>${esc(c)}</span><span class="budget-figs"><b>${fmt(s)}</b> / ${fmt(l)}</span></div>
          <div class="bar"><div class="bar-fill ${barClass(s, l)}" style="width:${Math.min(100, (s / l) * 100)}%"></div></div>
        </div>`;
      })
      .join("");
  }

  // ---------- Budget ----------
  function budgetStatus(s, l) {
    if (!l) return { cls: "", text: s ? `${fmt(s)} spent · no limit set` : "No limit set" };
    const left = l - s;
    if (left < 0) return { cls: "over", text: `Over budget by ${fmt(-left)}` };
    const pct = Math.round((s / l) * 100);
    return { cls: pct >= 80 ? "warn" : "", text: `${fmt(left)} remaining · ${pct}% used` };
  }

  function renderBudget() {
    const key = currentMonthKey();
    const spent = spentByCategory(key);
    const cats = catNames("expense");
    const totalLimit = cats.reduce((a, c) => a + (state.budgets[c] || 0), 0);
    const totalSpent = cats.reduce((a, c) => a + (state.budgets[c] ? spent[c] || 0 : 0), 0);
    $("#budgetTotal").innerHTML = totalLimit
      ? `${monthLabel(key)} · <b>${fmt(totalSpent)}</b> of <b>${fmt(totalLimit)}</b> budgeted`
      : monthLabel(key);

    $("#budgetList").innerHTML = cats
      .map((c) => {
        const s = spent[c] || 0, l = state.budgets[c] || 0;
        const st = budgetStatus(s, l);
        return `<li class="budget-row">
          <div class="budget-info">
            <span class="budget-name">${esc(c)}</span>
            <span class="budget-figs"><b>${fmt(s)}</b>${l ? ` / ${fmt(l)}` : ""}</span>
          </div>
          <div class="budget-input">
            <div class="input-prefix"><span>$</span>
              <input type="number" min="0" step="1" placeholder="No limit" value="${l || ""}" data-cat="${esc(c)}" aria-label="Monthly limit for ${esc(c)}">
            </div>
          </div>
          <div>
            <div class="bar"><div class="bar-fill ${barClass(s, l)}" style="width:${l ? Math.min(100, (s / l) * 100) : 0}%"></div></div>
            <div class="budget-status ${st.cls}" style="margin-top:6px">${st.text}</div>
          </div>
        </li>`;
      })
      .join("");
  }

  // ---------- Savings Goals ----------
  const openGoals = new Set(); // which contribution lists are expanded

  function goalTimeline(g, p) {
    if (p.done) return '<span class="done">Goal reached</span>';
    const days = daysUntil(g.date);
    if (days < 0) return `<span class="over">${plural(Math.abs(days), "day")} past target date</span> · ${fmt(p.remaining)} still needed`;
    const lead = days === 0 ? "Due today" : `${plural(days, "day")} left`;
    return `${lead} · ${p.stillNeeded > 0 ? `save ${fmt(p.stillNeeded)} more this month to stay on track` : "on track this month"}`;
  }

  function goalItem(g) {
    const p = goalPlan(g);
    const pct = g.target > 0 ? Math.floor((p.saved / g.target) * 100) : 0;
    const contribs = goalTx(g.id).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);

    return `<li class="goal" data-goal="${g.id}">
      <div class="goal-head">
        <div>
          <div class="goal-name">${esc(g.name)}</div>
          <div class="goal-meta">${fmt(g.target)} by ${dateLabel(g.date)} · ${goalTimeline(g, p)}</div>
        </div>
        <button class="tx-del" type="button" data-action="delete-goal" aria-label="Delete goal ${esc(g.name)}">${delIcon}</button>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct)}" aria-label="${esc(g.name)} progress">
        <div class="bar-fill ${p.done ? "done" : p.saved > 0 ? "ok" : "none"}" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <div class="goal-figs">
        <span><b>${fmt(p.saved)}</b> saved · <span class="goal-pct">${pct}%</span></span>
        <span>${p.done ? (p.saved > g.target ? `${fmt(p.saved - g.target)} over target` : "Fully funded") : `<b>${fmt(p.remaining)}</b> remaining`}</span>
      </div>
      <form class="contrib-form" novalidate>
        <div class="input-prefix"><span>$</span><input name="amount" type="number" step="0.01" min="0.01" placeholder="Add contribution" aria-label="Contribution amount for ${esc(g.name)}"></div>
        <input name="date" type="date" value="${todayISO()}" aria-label="Contribution date">
        <button class="btn" type="submit">Log</button>
      </form>
      <p class="form-error" role="alert"></p>
      ${contribs.length ? `<details${openGoals.has(g.id) ? " open" : ""}>
        <summary>${plural(contribs.length, "contribution")}</summary>
        <ul class="contrib-list">
          ${contribs.map((c) => `<li class="contrib" data-contrib="${c.id}">
            <span>${dateLabel(c.date)}</span>
            <span class="contrib-amt">+${fmt(c.amount)}</span>
            <button class="tx-del" type="button" data-action="delete-contrib" aria-label="Delete ${fmt(c.amount)} contribution">${delIcon}</button>
          </li>`).join("")}
        </ul>
      </details>` : ""}
    </li>`;
  }

  function renderGoals() {
    const goals = [...state.goals].sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
    $("#goalCount").textContent = goals.length;
    $("#goalList").innerHTML = goals.length
      ? goals.map(goalItem).join("")
      : '<li class="empty">No savings goals yet. Create one to start tracking.</li>';

    const totalTarget = goals.reduce((a, g) => a + g.target, 0);
    const totalSaved = goals.reduce((a, g) => a + Math.min(savedFor(g.id), g.target), 0);
    const total = $("#goalsTotal");
    total.innerHTML = `<b>${fmt(totalSaved)}</b> of <b>${fmt(totalTarget)}</b> saved across ${plural(goals.length, "goal")}`;
    total.hidden = !goals.length;
  }

  // ---------- History (completed months) ----------
  const openMonths = new Set();

  function monthSummary(key) {
    const txs = state.transactions.filter((t) => inMonth(t, key));
    const income = sum(txs.filter((t) => t.type === "income"));
    const expenses = sum(txs.filter((t) => t.type === "expense"));
    const spent = spentByCategory(key);
    const { limits, source } = budgetsFor(key);
    const rows = Object.entries(limits)
      .filter(([, l]) => l > 0)
      .map(([cat, limit]) => ({ cat, limit, spent: spent[cat] || 0 }))
      .sort((a, b) => b.spent / b.limit - a.spent / a.limit);
    const over = rows.filter((r) => r.spent > r.limit);
    const unbudgeted = round2(Object.entries(spent).filter(([c]) => !(limits[c] > 0)).reduce((a, [, v]) => a + v, 0));
    return {
      key, income, expenses, net: round2(income - expenses), rows, over, unbudgeted, source,
      budgetedSpent: round2(rows.reduce((a, r) => a + r.spent, 0)),
      budgetedLimit: round2(rows.reduce((a, r) => a + r.limit, 0)),
    };
  }

  function renderHistory() {
    const current = currentMonthKey();
    const keys = [...new Set(state.transactions.map((t) => t.date.slice(0, 7)))]
      .filter((k) => k < current)
      .sort()
      .reverse();
    const months = keys.map(monthSummary);
    const list = $("#historyList");
    const stats = $("#historyStats");

    if (!months.length) {
      stats.hidden = true;
      list.innerHTML = `<div class="card"><p class="empty">No previous months yet. Once ${monthName(current)} is over, its totals and budget results will appear here.</p></div>`;
      return;
    }

    const avg = (f) => round2(months.reduce((a, m) => a + f(m), 0) / months.length);
    const judged = months.filter((m) => m.rows.length);
    const within = judged.filter((m) => !m.over.length).length;
    stats.hidden = false;
    $("#histAvgIncome").textContent = fmt(avg((m) => m.income));
    $("#histAvgExpenses").textContent = fmt(avg((m) => m.expenses));
    $("#histWithin").textContent = judged.length ? `${within} of ${judged.length}` : "—";
    $("#histWithinSub").textContent = judged.length
      ? `${plural(months.length, "month")} tracked`
      : "No budget limits recorded";

    list.innerHTML = months
      .map((m) => {
        const status = !m.rows.length
          ? { cls: "", label: "No budget set" }
          : m.over.length
            ? { cls: "bad", label: `Over budget in ${m.over.length} ${m.over.length === 1 ? "category" : "categories"}` }
            : { cls: "good", label: "Within budget" };
        const netCls = m.net < 0 ? "expense" : m.net > 0 ? "income" : "";
        const sourceNote = m.rows.length && m.source && m.source !== m.key
          ? `<p class="hist-note">Compared with the limits you had in ${monthLabel(m.source)}.</p>`
          : "";
        return `<article class="card hist-month" data-month="${m.key}">
          <div class="hist-head">
            <h2>${monthLabel(m.key)}</h2>
            <span class="hist-badge ${status.cls}">${status.label}</span>
          </div>
          <div class="hist-figs">
            <div><span class="stat-label">Income</span><span class="hist-val income">${fmt(m.income)}</span></div>
            <div><span class="stat-label">Expenses</span><span class="hist-val expense">${fmt(m.expenses)}</span></div>
            <div><span class="stat-label">Net</span><span class="hist-val ${netCls}">${m.net < 0 ? "−" : m.net > 0 ? "+" : ""}${fmt(Math.abs(m.net))}</span></div>
          </div>
          ${m.rows.length ? `<details${openMonths.has(m.key) ? " open" : ""}>
            <summary>Budget breakdown · ${fmt(m.budgetedSpent)} of ${fmt(m.budgetedLimit)} budgeted</summary>
            ${sourceNote}
            <ul class="hist-rows">
              ${m.rows.map((r) => {
                const diff = round2(r.limit - r.spent);
                return `<li class="hist-row">
                  <div class="budget-info">
                    <span>${esc(r.cat)}</span>
                    <span class="budget-figs"><b>${fmt(r.spent)}</b> / ${fmt(r.limit)}</span>
                  </div>
                  <div class="bar"><div class="bar-fill ${barClass(r.spent, r.limit)}" style="width:${Math.min(100, (r.spent / r.limit) * 100)}%"></div></div>
                  <div class="budget-status ${diff < 0 ? "over" : ""}">${diff < 0 ? `Over by ${fmt(-diff)}` : `Under by ${fmt(diff)}`}</div>
                </li>`;
              }).join("")}
            </ul>
            ${m.unbudgeted > 0 ? `<p class="hist-note">Plus ${fmt(m.unbudgeted)} in categories without a limit.</p>` : ""}
          </details>` : ""}
        </article>`;
      })
      .join("");
  }

  $("#historyList").addEventListener("toggle", (e) => {
    if (e.target.tagName !== "DETAILS") return;
    const key = e.target.closest(".hist-month").dataset.month;
    if (e.target.open) openMonths.add(key); else openMonths.delete(key);
  }, true);

  // ---------- Settings ----------
  function renderSettings() {
    $$("[data-theme-choice]").forEach((b) => {
      const on = b.dataset.themeChoice === state.settings.theme;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });

    const current = state.settings.accent.toLowerCase();
    const isPreset = ACCENTS.some(([, hex]) => hex === current);
    $("#accentSwatches").innerHTML =
      ACCENTS.map(([name, hex]) =>
        `<button type="button" class="swatch${hex === current ? " active" : ""}" data-accent="${hex}" style="--swatch:${hex}" aria-label="${name}" aria-pressed="${hex === current}" title="${name}"></button>`
      ).join("") +
      `<label class="swatch swatch-custom${isPreset ? "" : " active"}" title="Custom colour" style="--swatch:${current}">
        <input type="color" id="accentCustom" value="${current}" aria-label="Custom accent colour">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </label>`;

    for (const type of ["income", "expense"]) {
      $(`#catList-${type}`).innerHTML = state.categories[type]
        .map((c) => {
          const used = state.transactions.filter((t) => t.type === type && t.category === c.name).length;
          const locked = c.id === OTHER_ID || c.id === SAVINGS_ID;
          const lockTitle = c.id === OTHER_ID
            ? "Default category: entries from deleted categories move here, so it can't be deleted"
            : "Used for savings goal contributions, so it can't be deleted";
          return `<li class="cat-item">
            <input type="text" value="${esc(c.name)}" maxlength="30" data-cat-type="${type}" data-cat-id="${esc(c.id)}" aria-label="Rename ${esc(c.name)}">
            <span class="cat-uses">${used ? `${used} ${used === 1 ? "entry" : "entries"}` : ""}</span>
            ${locked
              ? `<span class="pill cat-lock" title="${lockTitle}">${c.id === OTHER_ID ? "Default" : "Goals"}</span>`
              : `<button class="tx-del cat-del" type="button" data-del-cat="${esc(c.id)}" data-cat-type="${type}" aria-label="Delete ${esc(c.name)} category">${delIcon}</button>`}
          </li>`;
        })
        .join("");
    }
  }

  function validateCategoryName(type, name, ignoreId) {
    if (!name) return "Category name can't be empty.";
    if (name.length > 30) return "Keep category names under 30 characters.";
    const clash = state.categories[type].find((c) => c.id !== ignoreId && c.name.toLowerCase() === name.toLowerCase());
    if (clash) return `There's already a "${clash.name}" category.`;
    return "";
  }

  function populateSelects() {
    for (const form of [$("#incomeForm"), $("#expenseForm")]) {
      const select = form.elements.category;
      const prev = select.value;
      const names = catNames(form.dataset.type);
      select.innerHTML =
        '<option value="" disabled>Select a category</option>' + names.map((c) => `<option>${esc(c)}</option>`).join("");
      select.value = names.includes(prev) ? prev : "";
    }
  }

  function renderAll() {
    populateSelects();
    renderDashboard();
    renderList("income");
    renderList("expense");
    renderBudget();
    renderGoals();
    renderHistory();
    renderSettings();
  }

  // ---------- Income / expense forms ----------
  function setupForm(form) {
    const type = form.dataset.type;
    const select = form.elements.category;
    form.elements.date.value = todayISO();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const err = $(".form-error", form);
      const description = form.elements.description.value.trim();
      const amount = round2(parseFloat(form.elements.amount.value));
      const category = select.value;
      const date = form.elements.date.value;

      let problem = "";
      if (!description) problem = "Please enter a description.";
      else if (!(amount > 0)) problem = "Please enter an amount greater than zero.";
      else if (!category) problem = "Please choose a category.";
      else if (!isISO(date)) problem = "Please choose a date.";
      err.textContent = problem;
      if (problem) return;

      state.transactions.push({ id: uid(), type, description, amount, category, date, created: Date.now() });
      save();
      renderAll();

      form.elements.description.value = "";
      form.elements.amount.value = "";
      select.value = "";
      form.elements.description.focus();
      toast(`${type === "income" ? "Income" : "Expense"} of ${fmt(amount)} added`);
    });
  }
  setupForm($("#incomeForm"));
  setupForm($("#expenseForm"));

  // Delete income/expense entries
  ["#incomeList", "#expenseList"].forEach((sel) =>
    $(sel).addEventListener("click", async (e) => {
      const btn = e.target.closest(".tx-del");
      if (!btn) return;
      const t = state.transactions.find((x) => x.id === btn.dataset.id);
      if (!t) return;
      const goal = t.goalId ? goalById(t.goalId) : null;
      const ok = await askConfirm({
        title: "Delete entry?",
        message: `"${t.description}" (${fmt(t.amount)}) will be removed.` + (goal ? ` It will also be removed from your "${goal.name}" goal.` : ""),
      });
      if (!ok) return;
      state.transactions = state.transactions.filter((x) => x.id !== t.id);
      save();
      renderAll();
      toast("Entry deleted");
    })
  );

  // Budget limits: save on change (blur / enter)
  $("#budgetList").addEventListener("change", (e) => {
    const input = e.target.closest("input[data-cat]");
    if (!input) return;
    const val = parseFloat(input.value);
    const cat = input.dataset.cat;
    if (val > 0) state.budgets[cat] = round2(val);
    else delete state.budgets[cat];
    snapshotBudgets();
    save();
    toast(val > 0 ? `${cat} limit set to ${fmt(state.budgets[cat])}` : `${cat} limit removed`);
    rerenderKeepingFocus("#budgetList input[data-cat]", "cat");
  });
  $("#budgetList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input[data-cat]")) e.target.blur();
  });

  // Re-render after focus settles so Tab-ing to the next field keeps focus there.
  function rerenderKeepingFocus(selector, dataKey) {
    setTimeout(() => {
      const active = document.activeElement;
      const next = active && active.matches && active.matches(selector) ? active.dataset[dataKey] : null;
      renderAll();
      if (next) {
        const el = $$(selector).find((i) => i.dataset[dataKey] === next);
        if (el) el.focus();
      }
    });
  }

  // ---------- Goal events ----------
  const goalForm = $("#goalForm");
  goalForm.elements.date.min = todayISO();

  goalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const err = $(".form-error", goalForm);
    const name = goalForm.elements.name.value.trim();
    const target = round2(parseFloat(goalForm.elements.target.value));
    const date = goalForm.elements.date.value;

    let problem = "";
    if (!name) problem = "Please enter a goal name.";
    else if (!(target > 0)) problem = "Please enter a target amount greater than zero.";
    else if (!isISO(date)) problem = "Please choose a target date.";
    else if (date < todayISO()) problem = "Target date can't be in the past.";
    err.textContent = problem;
    if (problem) return;

    state.goals.push({ id: uid(), name, target, date, created: Date.now() });
    save();
    renderAll();
    goalForm.reset();
    goalForm.elements.name.focus();
    toast(`Goal "${name}" created`);
  });

  const goalList = $("#goalList");

  goalList.addEventListener("submit", (e) => {
    const cf = e.target.closest(".contrib-form");
    if (!cf) return;
    e.preventDefault();
    const goal = goalById(cf.closest(".goal").dataset.goal);
    if (!goal) return;
    const err = cf.nextElementSibling;
    const amount = round2(parseFloat(cf.elements.amount.value));
    const date = cf.elements.date.value;

    let problem = "";
    if (!(amount > 0)) problem = "Enter a contribution greater than zero.";
    else if (!isISO(date)) problem = "Choose a date for this contribution.";
    err.textContent = problem;
    if (problem) return;

    const wasDone = savedFor(goal.id) >= goal.target;
    // A contribution is money set aside, so it's recorded as an expense.
    state.transactions.push({
      id: uid(), type: "expense", description: `Saved for ${goal.name}`, amount,
      category: savingsName(), date, created: Date.now(), goalId: goal.id,
    });
    save();
    renderAll();
    const nowDone = savedFor(goal.id) >= goal.target;
    toast(!wasDone && nowDone ? `"${goal.name}" goal reached!` : `${fmt(amount)} set aside for ${goal.name}`);
    const input = $(`.goal[data-goal="${goal.id}"] .contrib-form input[name="amount"]`);
    if (input) input.focus();
  });

  goalList.addEventListener("toggle", (e) => {
    if (e.target.tagName !== "DETAILS") return;
    const id = e.target.closest(".goal").dataset.goal;
    if (e.target.open) openGoals.add(id); else openGoals.delete(id);
  }, true);

  goalList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const goal = goalById(btn.closest(".goal").dataset.goal);
    if (!goal) return;

    if (btn.dataset.action === "delete-goal") {
      const contribs = goalTx(goal.id);
      const ok = await askConfirm({
        title: "Delete goal?",
        message: contribs.length
          ? `"${goal.name}" and its ${plural(contribs.length, "contribution")} (${fmt(sum(contribs))}) will be deleted, and those contributions will be removed from your expenses.`
          : `"${goal.name}" will be deleted.`,
        confirmLabel: "Delete goal",
      });
      if (!ok) return;
      state.goals = state.goals.filter((g) => g.id !== goal.id);
      state.transactions = state.transactions.filter((t) => t.goalId !== goal.id);
      openGoals.delete(goal.id);
      save();
      renderAll();
      toast("Goal deleted");
    } else if (btn.dataset.action === "delete-contrib") {
      const cid = btn.closest(".contrib").dataset.contrib;
      const c = state.transactions.find((t) => t.id === cid);
      if (!c) return;
      const ok = await askConfirm({
        title: "Delete contribution?",
        message: `The ${fmt(c.amount)} contribution from ${dateLabel(c.date)} will be removed from "${goal.name}" and from your expenses.`,
      });
      if (!ok) return;
      state.transactions = state.transactions.filter((t) => t.id !== cid);
      save();
      renderAll();
      toast("Contribution deleted");
    }
  });

  // ---------- Settings events ----------
  $("#view-settings").addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-del-cat]");
    if (delBtn) {
      await deleteCategory(delBtn.dataset.catType, delBtn.dataset.delCat);
      return;
    }
    const themeBtn = e.target.closest("[data-theme-choice]");
    if (themeBtn) {
      state.settings.theme = themeBtn.dataset.themeChoice;
      save();
      applyAppearance();
      renderSettings();
      toast(`${state.settings.theme === "light" ? "Light" : "Dark"} mode on`);
      return;
    }
    const sw = e.target.closest("[data-accent]");
    if (sw) {
      state.settings.accent = sw.dataset.accent;
      save();
      applyAppearance();
      renderSettings();
      $(`[data-accent="${sw.dataset.accent}"]`).focus();
      toast(`Accent set to ${sw.getAttribute("aria-label")}`);
    }
  });

  // Custom accent: preview live while dragging, save when the picker closes.
  $("#view-settings").addEventListener("input", (e) => {
    if (e.target.id === "accentCustom") {
      applyAppearance(e.target.value);
      e.target.closest(".swatch-custom").style.setProperty("--swatch", e.target.value);
    }
  });

  $("#view-settings").addEventListener("change", (e) => {
    if (e.target.id === "accentCustom") {
      state.settings.accent = e.target.value.toLowerCase();
      save();
      applyAppearance();
      renderSettings();
      toast("Custom accent saved");
      return;
    }

    // Rename a category
    const input = e.target.closest("input[data-cat-id]");
    if (!input) return;
    const type = input.dataset.catType;
    const cat = state.categories[type].find((c) => c.id === input.dataset.catId);
    if (!cat) return;
    const name = input.value.trim().replace(/\s+/g, " ");
    const errEl = $(`.cat-col[data-type="${type}"] .form-error`);
    if (name === cat.name) { input.value = cat.name; errEl.textContent = ""; return; }
    const problem = validateCategoryName(type, name, cat.id);
    if (problem) {
      errEl.textContent = problem;
      input.value = cat.name;
      return;
    }
    errEl.textContent = "";
    const old = cat.name;
    cat.name = name;
    for (const t of state.transactions) if (t.type === type && t.category === old) t.category = name;
    if (type === "expense") {
      for (const limits of [state.budgets, ...Object.values(state.budgetHistory)]) {
        if (old in limits) {
          limits[name] = limits[old];
          delete limits[old];
        }
      }
    }
    save();
    toast(`Renamed "${old}" to "${name}"`);
    rerenderKeepingFocus("input[data-cat-id]", "catId");
  });

  $("#view-settings").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input[data-cat-id]")) e.target.blur();
    if (e.key === "Escape" && e.target.matches("input[data-cat-id]")) {
      const cat = state.categories[e.target.dataset.catType].find((c) => c.id === e.target.dataset.catId);
      if (cat) e.target.value = cat.name;
      e.target.blur();
    }
  });

  // Delete a category; its entries move to "Other" and its budget limit is removed.
  async function deleteCategory(type, id) {
    if (id === OTHER_ID || id === SAVINGS_ID) return;
    const cat = state.categories[type].find((c) => c.id === id);
    if (!cat) return;
    const fallback = otherName(type);
    const entries = state.transactions.filter((t) => t.type === type && t.category === cat.name);
    const hasLimit = type === "expense" && state.budgets[cat.name] > 0;
    const notes = [];
    if (entries.length) notes.push(`${entries.length} ${entries.length === 1 ? "entry" : "entries"} will move to "${fallback}".`);
    if (hasLimit) notes.push(`Its ${fmt(state.budgets[cat.name])} monthly limit will be removed.`);
    const ok = await askConfirm({
      title: "Delete category?",
      message: `"${cat.name}" will be removed from your ${type} categories.` + (notes.length ? " " + notes.join(" ") : ""),
      confirmLabel: "Delete category",
    });
    if (!ok) return;

    state.categories[type] = state.categories[type].filter((c) => c.id !== id);
    for (const t of entries) t.category = fallback;
    if (type === "expense") {
      delete state.budgets[cat.name];
      // Past snapshots drop the limit too, since its spending now sits under "Other".
      for (const snap of Object.values(state.budgetHistory)) delete snap[cat.name];
      snapshotBudgets();
    }
    save();
    renderAll();
    toast(entries.length ? `Deleted "${cat.name}" · ${entries.length} moved to ${fallback}` : `Deleted "${cat.name}"`);
  }

  // Add a category
  $("#view-settings").addEventListener("submit", (e) => {
    const form = e.target.closest(".cat-add");
    if (!form) return;
    e.preventDefault();
    const type = form.dataset.type;
    const input = form.elements.name;
    const name = input.value.trim().replace(/\s+/g, " ");
    const errEl = $(`.cat-col[data-type="${type}"] .form-error`);
    const problem = validateCategoryName(type, name);
    errEl.textContent = problem;
    if (problem) return;
    state.categories[type].push({ id: uid(), name });
    save();
    renderAll();
    input.value = "";
    input.focus();
    toast(`Added "${name}" to ${type} categories`);
  });

  // ---------- Init ----------
  applyAppearance();
  renderAll();
  let initial = "dashboard";
  try { initial = sessionStorage.getItem("fd-view") || "dashboard"; } catch (_) {}
  show(initial);
})();
