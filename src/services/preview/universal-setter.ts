/**
 * Universal Setter — sets form element values bypassing framework guards.
 *
 * Uses the native prototype descriptor trick to bypass React/Vue/Angular
 * controlled component state, then fires proper input + change events.
 */

export function buildUniversalSetterExpression(selectorPath: string, value: string): string {
  const escapedSelector = JSON.stringify(selectorPath);
  const escapedValue = JSON.stringify(value);
  return `(function() {
    var el = document.querySelector(${escapedSelector});
    if (!el) return false;

    var tag = el.tagName;
    var proto;
    if (tag === 'SELECT') {
      proto = HTMLSelectElement.prototype;
    } else if (tag === 'TEXTAREA') {
      proto = HTMLTextAreaElement.prototype;
    } else {
      proto = HTMLInputElement.prototype;
    }

    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, ${escapedValue});
    } else {
      el.value = ${escapedValue};
    }

    // For <select>, also set selectedIndex
    if (tag === 'SELECT') {
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === ${escapedValue}) {
          el.selectedIndex = i;
          break;
        }
      }
    }

    // Fire events that frameworks listen to
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}
