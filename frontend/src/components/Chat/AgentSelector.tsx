// @ts-nocheck
import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";

// ─── Provider definitions ─────────────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    models: [
      { id: "opus-4.6", name: "Opus 4.6", ctx: "1M", reasoning: ["low", "medium", "high", "max"] },
      { id: "sonnet-4.6", name: "Sonnet 4.6", ctx: "200K", reasoning: ["low", "medium", "high"] },
      { id: "haiku-4.5", name: "Haiku 4.5", ctx: "200K", reasoning: null },
    ],
    label: "Claude",
    reasoningName: "Effort",
  },
  codex: {
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", ctx: "1M", reasoning: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", ctx: "400K", reasoning: ["low", "medium", "high"] },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", ctx: "400K", reasoning: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.3-codex-spark", name: "Codex Spark", ctx: "128K", reasoning: ["low", "medium", "high"] },
    ],
    label: "Codex",
    reasoningName: "Reasoning",
  },
  gemini: {
    models: [
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", ctx: "1M", reasoning: ["minimal", "low", "medium", "high"] },
      { id: "gemini-3-flash", name: "Gemini 3 Flash", ctx: "200K", reasoning: ["minimal", "low", "medium", "high"] },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", ctx: "1M", reasoning: null },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", ctx: "1M", reasoning: null },
    ],
    label: "Gemini",
    reasoningName: "Thinking",
  },
};

// ─── SVG Icons ────────────────────────────────────────────────────────────────
const ClaudeLogo = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="#D97757">
    <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
  </svg>
);

const CodexLogo = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#10a37f">
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
);

const GeminiLogo = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8.016A8.522 8.522 0 008.016 16h-.032A8.521 8.521 0 000 8.016v-.032A8.521 8.521 0 007.984 0h.032A8.522 8.522 0 0016 7.984v.032z" fill="url(#asg)" />
    <defs>
      <radialGradient id="asg" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(16.1326 5.4553 -43.70045 129.2322 1.588 6.503)">
        <stop offset=".067" stopColor="#9168C0" /><stop offset=".343" stopColor="#5684D1" /><stop offset=".672" stopColor="#1BA1E3" />
      </radialGradient>
    </defs>
  </svg>
);

const LOGOS = { claude: ClaudeLogo, codex: CodexLogo, gemini: GeminiLogo };

const ChevronIcon = () => (
  <svg style={{ width: 12, height: 12, flexShrink: 0, transition: "transform 0.2s" }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
);

const CheckIcon = () => (
  <svg style={{ width: 13, height: 13, marginLeft: "auto", flexShrink: 0 }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
);

const XIcon = () => (
  <svg style={{ width: 12, height: 12 }} viewBox="0 0 16 16" fill="none" stroke="#c0392b" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="5" x2="11" y2="11" /><line x1="11" y1="5" x2="5" y2="11" /></svg>
);

const PlusIcon = () => (
  <svg style={{ width: 14, height: 14 }} viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
);

// ─── Styles (injected once) ───────────────────────────────────────────────────
const STYLE_ID = "agent-selector-styles";
function injectStyles(dark) {
  let el = document.getElementById(STYLE_ID);
  if (!el) { el = document.createElement("style"); el.id = STYLE_ID; document.head.appendChild(el); }
  el.textContent = buildCSS(dark);
}

function buildCSS(dark) {
  const bg = dark ? "#2a2a2a" : "#fff";
  const border = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  const borderHover = dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";
  const labelOff = dark ? "#666" : "#aaa";
  const labelOn = dark ? "#ccc" : "#1a1a1a";
  const chevColor = dark ? "#555" : "#aaa";
  const chevBorder = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.07)";
  const dotBg = dark ? "#555" : "#ccc";
  const tipBg = dark ? "#555" : "#1a1a1a";
  const ddBg = dark ? "#2a2a2a" : "#fff";
  const ddBorder = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
  const ddShadow = dark ? "0 8px 32px rgba(0,0,0,0.4)" : "0 8px 32px rgba(0,0,0,0.1)";
  const optHover = dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)";
  const optName = dark ? "#e8e8e8" : "#1a1a1a";
  const checkC = dark ? "#e8e8e8" : "#1a1a1a";
  const addBg = dark ? "#2a2a2a" : "#fff";
  const addBorder = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
  const addBorderHover = dark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)";
  const addStroke = dark ? "#888" : "#999";
  const toastBg = dark ? "#444" : "#1a1a1a";
  const removeBg = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const removeStroke = dark ? "#e74c3c" : "#c0392b";

  const providerColors = {
    claude: { bg: "rgba(217,119,87,0.07)", bgDark: "rgba(217,119,87,0.1)", border: "rgba(217,119,87,0.4)", borderDark: "rgba(217,119,87,0.3)", label: "#b4552e", labelDark: "#e8a888", chevBorder: "rgba(217,119,87,0.2)", chev: "#D97757", dot: "#D97757" },
    codex: { bg: "rgba(16,163,127,0.06)", bgDark: "rgba(16,163,127,0.1)", border: "rgba(16,163,127,0.35)", borderDark: "rgba(16,163,127,0.3)", label: "#0d7a5f", labelDark: "#6dd4b4", chevBorder: "rgba(16,163,127,0.2)", chev: "#10a37f", dot: "#10a37f" },
    gemini: { bg: "rgba(66,133,244,0.06)", bgDark: "rgba(86,132,209,0.1)", border: "rgba(86,132,209,0.4)", borderDark: "rgba(86,132,209,0.3)", label: "#3b6bbf", labelDark: "#9ab8e8", chevBorder: "rgba(86,132,209,0.2)", chev: "#5684D1", dot: "#5684D1" },
  };

  let provCSS = "";
  for (const [k, v] of Object.entries(providerColors)) {
    const b = dark ? v.bgDark : v.bg;
    const br = dark ? v.borderDark : v.border;
    const lb = dark ? v.labelDark : v.label;
    provCSS += `
.as-pill[data-provider="${k}"].as-enabled { background: ${b}; border-color: ${br}; }
.as-pill[data-provider="${k}"].as-enabled .as-label { color: ${lb}; }
.as-pill[data-provider="${k}"].as-enabled .as-chevron-btn { border-left-color: ${v.chevBorder}; color: ${v.chev}; }
.as-pill[data-provider="${k}"] .as-rdot.as-active { background: ${v.dot}; }`;
  }

  return `
.as-container { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.as-wrap { position: relative; display: inline-block; animation: asPillIn 0.2s ease both; }
.as-wrap.as-removing { animation: asPillOut 0.15s ease both; }
@keyframes asPillIn { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes asPillOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.85); } }

.as-pill { display: inline-flex; align-items: center; background: ${bg}; border: 1.5px solid ${border}; border-radius: 999px; transition: border-color 0.2s, background 0.25s; user-select: none; }
.as-pill:hover { border-color: ${borderHover}; }

.as-toggle { position: relative; display: flex; align-items: center; gap: 7px; padding: 5px 6px 5px 9px; cursor: pointer; border: none; background: transparent; border-radius: 999px 0 0 999px; transition: background 0.1s; outline: none; -webkit-tap-highlight-color: transparent; }
.as-toggle:hover { background: ${dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)"}; }

.as-logo { width: 16px; height: 16px; flex-shrink: 0; transition: opacity 0.2s; opacity: 0.4; }
.as-pill.as-enabled .as-logo { opacity: 1; }

.as-label { font-size: 12.5px; font-weight: 600; color: ${labelOff}; white-space: nowrap; line-height: 1; transition: color 0.2s; }
.as-pill.as-enabled .as-label { color: ${labelOn}; }

.as-remove { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: ${removeBg}; border-radius: 999px 0 0 999px; opacity: 0; transition: opacity 0.15s; cursor: pointer; }
.as-remove svg { stroke: ${removeStroke}; }
.as-pill.as-removable .as-toggle:hover .as-remove { opacity: 1; }

.as-dots { display: flex; align-items: center; gap: 3px; padding: 4px 6px 4px 4px; cursor: pointer; border: none; background: transparent; outline: none; position: relative; -webkit-tap-highlight-color: transparent; }
.as-dots:hover .as-rdot { opacity: 0.5; }
.as-dots:hover .as-rdot.as-active { opacity: 1; }

.as-rdot { width: 5px; height: 5px; border-radius: 50%; background: ${dotBg}; opacity: 0.35; transition: background 0.15s, opacity 0.15s, transform 0.15s; }
.as-rdot.as-active { opacity: 1; transform: scale(1.1); }

.as-tip { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%) translateY(4px); background: ${tipBg}; color: #fff; font-size: 11px; font-weight: 500; white-space: nowrap; padding: 5px 10px; border-radius: 7px; opacity: 0; pointer-events: none; transition: opacity 0.15s, transform 0.15s; z-index: 300; box-shadow: 0 4px 12px rgba(0,0,0,0.15); line-height: 1; }
.as-tip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: ${tipBg}; }
.as-dots:hover .as-tip { opacity: 1; transform: translateX(-50%) translateY(0); }

.as-chevron-btn { display: flex; align-items: center; justify-content: center; padding: 5px 9px 5px 6px; cursor: pointer; border: none; background: transparent; border-left: 1px solid ${chevBorder}; border-radius: 0 999px 999px 0; transition: background 0.1s, border-color 0.15s; outline: none; color: ${chevColor}; -webkit-tap-highlight-color: transparent; }
.as-chevron-btn:hover { background: ${optHover}; }
.as-chevron-btn.as-open svg { transform: rotate(180deg); }

.as-dd { position: absolute; top: calc(100% + 6px); left: 0; min-width: 240px; background: ${ddBg}; border: 1px solid ${ddBorder}; border-radius: 12px; padding: 4px; opacity: 0; pointer-events: none; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s; z-index: 100; box-shadow: ${ddShadow}; }
.as-dd.as-open { opacity: 1; pointer-events: auto; transform: translateY(0); }
.as-dd.as-flip { top: auto; bottom: calc(100% + 6px); transform: translateY(4px); }
.as-dd.as-flip.as-open { transform: translateY(0); }

.as-opt { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: pointer; transition: background 0.1s; }
.as-opt:hover { background: ${optHover}; }
.as-opt.as-active { background: ${optHover}; }
.as-opt-text { display: flex; flex-direction: column; gap: 1px; }
.as-opt-name { font-size: 12.5px; font-weight: 600; color: ${optName}; }
.as-opt-meta { font-size: 10.5px; color: #888; }
.as-check { opacity: 0; }
.as-opt.as-active .as-check { opacity: 1; }

.as-add-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: ${addBg}; border: 1.5px dashed ${addBorder}; border-radius: 50%; cursor: pointer; transition: border-color 0.15s, background 0.15s, transform 0.1s; outline: none; flex-shrink: 0; -webkit-tap-highlight-color: transparent; }
.as-add-btn:hover { border-color: ${addBorderHover}; }
.as-add-btn:active { transform: scale(0.95); }
.as-add-btn svg { stroke: ${addStroke}; }

.as-add-dd { position: absolute; top: calc(100% + 6px); right: 0; min-width: 180px; background: ${ddBg}; border: 1px solid ${ddBorder}; border-radius: 12px; padding: 4px; opacity: 0; pointer-events: none; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s; z-index: 100; box-shadow: ${ddShadow}; }
.as-add-dd.as-open { opacity: 1; pointer-events: auto; transform: translateY(0); }
.as-add-dd.as-flip { top: auto; bottom: calc(100% + 6px); transform: translateY(4px); }
.as-add-dd.as-flip.as-open { transform: translateY(0); }

.as-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(8px); background: ${toastBg}; color: #fff; font-size: 12.5px; font-weight: 500; padding: 7px 16px; border-radius: 999px; opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none; z-index: 200; white-space: nowrap; }
.as-toast.as-show { opacity: 1; transform: translateX(-50%) translateY(0); }
${provCSS}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ReasoningDots({ provider, modelId, index, onClick }) {
  const p = PROVIDERS[provider];
  const m = p.models.find((x) => x.id === modelId);
  const levels = m?.reasoning;
  if (!levels) return null;
  const safeIdx = Math.min(index, levels.length - 1);

  return (
    <button className="as-dots" onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <span className="as-tip">{p.reasoningName}: {levels[safeIdx]}</span>
      {levels.map((_, i) => (
        <span key={i} className={`as-rdot${i <= safeIdx ? " as-active" : ""}`} />
      ))}
    </button>
  );
}

function Dropdown({ provider, selectedId, onSelect, open, flip = false }) {
  const p = PROVIDERS[provider];
  return (
    <div className={`as-dd${open ? " as-open" : ""}${flip ? " as-flip" : ""}`} role="listbox">
      {p.models.map((m) => {
        const Logo = LOGOS[provider];
        return (
          <div key={m.id} className={`as-opt${m.id === selectedId ? " as-active" : ""}`}
            onClick={() => onSelect(m.id)}>
            <Logo className="as-logo" style={{ opacity: 1, width: 15, height: 15 }} />
            <div className="as-opt-text">
              <span className="as-opt-name">{m.name}</span>
              <span className="as-opt-meta">{m.ctx} context{m.reasoning ? ` · ${p.reasoningName.toLowerCase()}` : ""}</span>
            </div>
            <span className="as-check"><CheckIcon /></span>
          </div>
        );
      })}
    </div>
  );
}

function Pill({ pillData, onUpdate, onRemove, closeSignal }) {
  const { id, provider, removable, enabled, selectedModel, reasoningIndex } = pillData;
  const [ddOpen, setDdOpen] = useState(false);
  const [ddFlip, setDdFlip] = useState(false);
  const lpRef = useRef(null);
  const didLPRef = useRef(false);
  const wrapRef = useRef(null);
  const p = PROVIDERS[provider];
  const Logo = LOGOS[provider];

  useEffect(() => { setDdOpen(false); }, [closeSignal]);

  // Check if dropdown should flip upward when opening
  const openDropdown = useCallback(() => {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      // Approximate dropdown height: ~4 models * 40px + padding
      setDdFlip(spaceBelow < 200);
    }
    setDdOpen(true);
  }, []);

  const handleToggle = (e) => {
    e.stopPropagation();
    if (didLPRef.current) { didLPRef.current = false; return; }
    if (!removable) {
      onUpdate(id, { enabled: !enabled });
    }
  };

  const handlePointerDown = () => {
    didLPRef.current = false;
    lpRef.current = setTimeout(() => { didLPRef.current = true; openDropdown(); }, 400);
  };
  const handlePointerUp = (e) => { clearTimeout(lpRef.current); if (didLPRef.current) { e.preventDefault(); e.stopPropagation(); } };
  const handlePointerLeave = () => clearTimeout(lpRef.current);

  const handleModelSelect = (modelId) => {
    onUpdate(id, { selectedModel: modelId, enabled: true, reasoningIndex: 0 });
    setDdOpen(false);
  };

  const handleDotClick = () => {
    const m = p.models.find((x) => x.id === selectedModel);
    if (!m?.reasoning) return;
    const next = (reasoningIndex + 1) % m.reasoning.length;
    onUpdate(id, { reasoningIndex: next });
  };

  const cur = p.models.find((m) => m.id === selectedModel) || p.models[0];

  return (
    <div className="as-wrap" ref={wrapRef}>
      <div className={`as-pill${enabled ? " as-enabled" : ""}${removable ? " as-removable" : ""}`} data-provider={provider}>
        <button className="as-toggle"
          onClick={handleToggle}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}>
          <Logo className="as-logo" />
          <span className="as-label">{cur.name} ({cur.ctx})</span>
          {removable && (
            <div className="as-remove" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onRemove(id); }}>
              <XIcon />
            </div>
          )}
        </button>
        <ReasoningDots provider={provider} modelId={selectedModel} index={reasoningIndex} onClick={handleDotClick} />
        <button className={`as-chevron-btn${ddOpen ? " as-open" : ""}`}
          onClick={(e) => { e.stopPropagation(); ddOpen ? setDdOpen(false) : openDropdown(); }}>
          <ChevronIcon />
        </button>
      </div>
      <Dropdown provider={provider} selectedId={selectedModel} onSelect={handleModelSelect} open={ddOpen} flip={ddFlip} />
    </div>
  );
}

function AddButton({ onAdd, closeSignal }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const btnRef = useRef(null);
  useEffect(() => { setOpen(false); }, [closeSignal]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setFlip(window.innerHeight - rect.bottom < 180);
    }
    setOpen(!open);
  };

  return (
    <div className="as-wrap" style={{ position: "relative" }} ref={btnRef}>
      <button className="as-add-btn" onClick={toggle}>
        <PlusIcon />
      </button>
      <div className={`as-add-dd${open ? " as-open" : ""}${flip ? " as-flip" : ""}`}>
        {Object.keys(PROVIDERS).map((pKey) => {
          const p = PROVIDERS[pKey];
          const Logo = LOGOS[pKey];
          return (
            <div key={pKey} className="as-opt" onClick={() => { onAdd(pKey); setOpen(false); }}>
              <Logo className="as-logo" style={{ opacity: 1, width: 15, height: 15 }} />
              <div className="as-opt-text">
                <span className="as-opt-name">Add {p.label}</span>
                <span className="as-opt-meta">{p.models.length} models</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message }) {
  return <div className={`as-toast${message ? " as-show" : ""}`}>{message}</div>;
}

// ─── Main Component ───────────────────────────────────────────────────────────
let _nextId = 0;
const makeId = () => `as-${_nextId++}`;

const AgentSelector = forwardRef(function AgentSelector({ dark = false, initialConfig, onChange }, ref) {
  const [pills, setPills] = useState(() => {
    if (initialConfig) return initialConfig.map((c) => ({ ...c, id: c.id || makeId() }));
    return [
      { id: makeId(), provider: "claude", removable: false, enabled: false, selectedModel: "opus-4.6", reasoningIndex: 0 },
      { id: makeId(), provider: "codex", removable: false, enabled: false, selectedModel: "gpt-5.4", reasoningIndex: 0 },
      { id: makeId(), provider: "gemini", removable: false, enabled: false, selectedModel: "gemini-3.1-pro", reasoningIndex: 0 },
    ];
  });
  const [toastMsg, setToastMsg] = useState("");
  const [closeSignal, setCloseSignal] = useState(0);
  const toastRef = useRef(null);

  useEffect(() => { injectStyles(dark); }, [dark]);

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToastMsg(""), 1500);
  }, []);

  const fireChange = useCallback((newPills) => {
    if (onChange) onChange(getConfigFromPills(newPills));
  }, [onChange]);

  const handleUpdate = useCallback((id, patch) => {
    setPills((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
      fireChange(next);

      // Toast
      const pill = next.find((p) => p.id === id);
      if (pill) {
        const prov = PROVIDERS[pill.provider];
        if ("enabled" in patch) showToast(`${prov.label} ${patch.enabled ? "enabled" : "disabled"}`);
        else if ("selectedModel" in patch) showToast(`${prov.label}: ${prov.models.find((m) => m.id === patch.selectedModel)?.name}`);
        else if ("reasoningIndex" in patch) {
          const m = prov.models.find((x) => x.id === pill.selectedModel);
          if (m?.reasoning) showToast(`${prov.reasoningName}: ${m.reasoning[patch.reasoningIndex]}`);
        }
      }
      return next;
    });
  }, [fireChange, showToast]);

  const handleRemove = useCallback((id) => {
    setPills((prev) => {
      const pill = prev.find((p) => p.id === id);
      if (pill) showToast(`${PROVIDERS[pill.provider].label} removed`);
      const next = prev.filter((p) => p.id !== id);
      fireChange(next);
      return next;
    });
  }, [fireChange, showToast]);

  const handleAdd = useCallback((provider) => {
    setPills((prev) => {
      const p = PROVIDERS[provider];
      const newPill = { id: makeId(), provider, removable: true, enabled: true, selectedModel: p.models[0].id, reasoningIndex: 0 };
      const next = [...prev, newPill];
      fireChange(next);
      showToast(`${p.label} added`);
      return next;
    });
  }, [fireChange, showToast]);

  // Close all dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest(".as-wrap")) setCloseSignal((s) => s + 1);
    };
    const keyHandler = (e) => { if (e.key === "Escape") setCloseSignal((s) => s + 1); };
    document.addEventListener("click", handler);
    document.addEventListener("keydown", keyHandler);
    return () => { document.removeEventListener("click", handler); document.removeEventListener("keydown", keyHandler); };
  }, []);

  // ─── Imperative API ──────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    getConfig: () => getConfigFromPills(pills),

    setConfig: (config) => {
      const mapped = config.map((c) => ({ ...c, id: c.id || makeId() }));
      setPills(mapped);
      fireChange(mapped);
    },

    addPill: (provider, opts = {}) => {
      const p = PROVIDERS[provider];
      if (!p) return;
      const newPill = {
        id: makeId(), provider, removable: true, enabled: true,
        selectedModel: opts.model || p.models[0].id,
        reasoningIndex: opts.reasoningIndex ?? 0,
      };
      setPills((prev) => { const next = [...prev, newPill]; fireChange(next); return next; });
    },

    removePill: (id) => handleRemove(id),

    updatePill: (id, patch) => handleUpdate(id, patch),

    enableAll: () => {
      setPills((prev) => { const next = prev.map((p) => ({ ...p, enabled: true })); fireChange(next); return next; });
    },

    disableAll: () => {
      setPills((prev) => { const next = prev.map((p) => (p.removable ? p : { ...p, enabled: false })); fireChange(next); return next; });
    },
  }), [pills, fireChange, handleRemove, handleUpdate]);

  return (
    <div className="as-container">
      {pills.map((pill) => (
        <Pill key={pill.id} pillData={pill} onUpdate={handleUpdate} onRemove={handleRemove} closeSignal={closeSignal} />
      ))}
      <AddButton onAdd={handleAdd} closeSignal={closeSignal} />
      <Toast message={toastMsg} />
    </div>
  );
});

export default AgentSelector;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getConfigFromPills(pills) {
  return pills.map((pill) => {
    const p = PROVIDERS[pill.provider];
    const m = p.models.find((x) => x.id === pill.selectedModel) || p.models[0];
    const levels = m.reasoning;
    const safeIdx = levels ? Math.min(pill.reasoningIndex, levels.length - 1) : null;
    return {
      id: pill.id,
      provider: pill.provider,
      providerLabel: p.label,
      removable: pill.removable,
      enabled: pill.enabled,
      model: {
        id: m.id,
        name: m.name,
        contextWindow: m.ctx,
        reasoning: levels ? { level: levels[safeIdx], index: safeIdx, available: [...levels] } : null,
      },
    };
  });
}

// Re-export for consumer convenience
export { PROVIDERS, getConfigFromPills };
