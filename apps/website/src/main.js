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
