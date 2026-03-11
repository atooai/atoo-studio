/**
 * Injected scripts for Shadow Overlay interception.
 * These scripts run inside the headless Chrome page via
 * Page.addScriptToEvaluateOnNewDocument and intercept native
 * controls that don't render in CDP screencast frames.
 *
 * Communication back to the server uses Runtime.addBinding.
 */

export function getInjectedScript(): string {
  return `(function() {
  'use strict';

  // === UTILITY: Build a unique CSS selector path for an element ===
  function getSelectorPath(el) {
    var parts = [];
    while (el && el !== document.body && el !== document.documentElement) {
      var selector = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) {
          return c.tagName === el.tagName;
        });
        if (siblings.length > 1) {
          selector += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
        }
      }
      parts.unshift(selector);
      el = parent;
    }
    return parts.join(' > ');
  }

  function getRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // === SELECT INTERCEPTION ===
  document.addEventListener('mousedown', function(e) {
    var el = e.target;
    // Walk up to find a <select> (handles clicking on the arrow, etc.)
    while (el && el.tagName !== 'SELECT') el = el.parentElement;
    if (!el) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var options = [];
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
        ? opt.parentElement.label : null;
      options.push({
        value: opt.value,
        text: opt.textContent || opt.innerText,
        selected: opt.selected,
        disabled: opt.disabled,
        group: group,
      });
    }

    try {
      window.__atoo_selectOpened(JSON.stringify({
        rect: getRect(el),
        options: options,
        selectedIndex: el.selectedIndex,
        multiple: el.multiple,
        selectorPath: getSelectorPath(el),
      }));
    } catch (err) { /* binding not available */ }
  }, true);

  // === INPUT PICKER INTERCEPTION ===
  var PICKER_TYPES = ['date', 'time', 'datetime-local', 'month', 'week', 'color'];

  document.addEventListener('mousedown', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'INPUT') el = el.parentElement;
    if (!el || PICKER_TYPES.indexOf(el.type) === -1) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    try {
      window.__atoo_pickerOpened(JSON.stringify({
        type: el.type,
        value: el.value,
        min: el.min || null,
        max: el.max || null,
        step: el.step || null,
        rect: getRect(el),
        selectorPath: getSelectorPath(el),
      }));
    } catch (err) { /* binding not available */ }
  }, true);

  // === TOOLTIP INTERCEPTION ===
  var tooltipTimer = null;
  var currentTooltipEl = null;

  document.addEventListener('mouseover', function(e) {
    var el = e.target;
    while (el && !el.getAttribute('title')) el = el.parentElement;
    if (!el || !el.getAttribute('title')) return;

    var title = el.getAttribute('title');
    // Remove native title to prevent browser tooltip
    el.removeAttribute('title');
    el.dataset.atooTitle = title;
    currentTooltipEl = el;

    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(function() {
      try {
        window.__atoo_tooltipShow(JSON.stringify({
          text: title,
          rect: getRect(el),
        }));
      } catch (err) { /* binding not available */ }
    }, 500);
  }, true);

  document.addEventListener('mouseout', function(e) {
    clearTimeout(tooltipTimer);
    // Restore title attribute
    if (currentTooltipEl && currentTooltipEl.dataset.atooTitle) {
      currentTooltipEl.setAttribute('title', currentTooltipEl.dataset.atooTitle);
      delete currentTooltipEl.dataset.atooTitle;
      currentTooltipEl = null;
    }
    try {
      window.__atoo_tooltipHide('{}');
    } catch (err) { /* binding not available */ }
  }, true);

  // === CONTEXT MENU INTERCEPTION ===
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var sel = window.getSelection();
    var selectedText = sel ? sel.toString() : '';
    var link = null;
    var el = e.target;
    while (el) {
      if (el.tagName === 'A' && el.href) { link = el; break; }
      el = el.parentElement;
    }
    var img = e.target.closest ? e.target.closest('img') : null;

    try {
      window.__atoo_contextMenu(JSON.stringify({
        x: e.clientX,
        y: e.clientY,
        selectedText: selectedText,
        linkHref: link ? link.href : null,
        linkText: link ? (link.textContent || '').trim() : null,
        imgSrc: img ? img.src : null,
      }));
    } catch (err) { /* binding not available */ }
  }, true);

})();`;
}
