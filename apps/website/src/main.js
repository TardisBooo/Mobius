const statuses = ["PI → GROK → CODEX", "SOURCE / VERIFIED", "NEXT / MEASURE P95"];
const status = document.querySelector(".hero-status");
if (status && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let index = 0;
  window.setInterval(() => { index = (index + 1) % statuses.length; status.textContent = statuses[index]; }, 2200);
}

const languageButton = document.querySelector(".lang-switch");
const translatable = [...document.querySelectorAll("[data-en][data-zh]")];
const setLanguage = (language) => {
  const zh = language === "zh";
  document.documentElement.lang = zh ? "zh-CN" : "en";
  translatable.forEach((node) => { node.textContent = node.dataset[language] ?? node.textContent; });
  if (languageButton) {
    languageButton.setAttribute("aria-pressed", String(zh));
    languageButton.setAttribute("aria-label", zh ? "Switch to English" : "切换到简体中文");
    const label = languageButton.querySelector(".lang-label");
    if (label) label.textContent = zh ? "English" : "简体中文";
  }
  document.title = zh ? "MÖBIUS | 切换 Agent，工作不断线" : "MÖBIUS | Switch agents. Keep the work.";
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute("content", zh
    ? "莫比乌斯是面向 Codex、Claude Code、Pi、Grok 与 OMP 的本地优先 Windows 工作台。按引用交接会话，用项目图谱追踪历史，以 FTS/BM25 搜索，并在真实 PowerShell 旁记录文档。"
    : "Möbius is a local-first Windows workspace for Codex, Claude Code, Pi, Grok, and OMP. Hand off sessions by reference, follow a project graph, search with FTS/BM25, and keep notes beside real PowerShell.");
  localStorage.setItem("mobius.website.language", language);
};

languageButton?.addEventListener("click", () => setLanguage(document.documentElement.lang === "en" ? "zh" : "en"));
const requestedLanguage = new URLSearchParams(location.search).get("lang");
setLanguage(requestedLanguage === "zh" || (requestedLanguage !== "en" && localStorage.getItem("mobius.website.language") === "zh") ? "zh" : "en");

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
  const revealTargets = [...document.querySelectorAll(".feature-row, .product-shot, .video-shell, .pixel-canvas")];
  revealTargets.forEach((target) => target.classList.add("reveal"));
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("visible");
    observer.unobserve(entry.target);
  }), { threshold: 0.12 });
  revealTargets.forEach((target) => observer.observe(target));
}
