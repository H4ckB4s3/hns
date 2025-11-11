// ==UserScript==
// @name         Instant Banner Remover (HNS)
// @namespace    https://example.com/
// @version      1.2
// @description  Instantly remove HNS banner and red bar ads before they render
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const SELECTORS = [
    'a[href="https://www.hns.to"]',
    'div[style*="background-color: rgb(241, 0, 19);"]',
    'div[style="margin: 0; padding: 0; height: 75px"]'
  ];

  // 🚫 Block visual flash instantly with CSS
  const style = document.createElement('style');
  style.textContent = `
    ${SELECTORS.join(', ')} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
  `;
  document.documentElement.appendChild(style);

  // ⚡ Remove matching nodes quickly
  function removeNodesFast(root = document) {
    root.querySelectorAll(SELECTORS.join(',')).forEach((el) => {
      if (el.matches('div[style*="background-color: rgb(241, 0, 19);"]')) {
        el.parentElement?.remove();
      } else {
        el.remove();
      }
    });
  }

  // 🧹 Clean up once DOM is ready
  const cleanup = () => removeNodesFast(document);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cleanup, { once: true });
  } else {
    cleanup();
  }

  // 👁 Observe for dynamically added elements
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) removeNodesFast(node);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 💤 Run one more pass when idle (to catch late banners)
  if ('requestIdleCallback' in window) {
    requestIdleCallback(cleanup);
  } else {
    setTimeout(cleanup, 100);
  }
})();
