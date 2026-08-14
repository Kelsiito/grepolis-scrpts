// ==UserScript==
// @name         Grepolis — Actualização automática de comandos
// @namespace    https://grepolis.com/
// @version      1.3.1
// @description  Actualiza Comandos após enviar, receber ou cancelar comandos.
// @match        https://*.grepolis.com/game/*
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-command-autorefresh.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/main/grepolis-command-autorefresh.user.js
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function commandOverviewAutoRefresh() {
  'use strict';

  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const SUBSCRIBER_ID = 'command_overview_auto_refresh';
  const REFRESH_DELAY_MS = 10;
  const REQUEST_URL = Symbol('commandOverviewRequestUrl');
  let subscribed = false;
  let refreshTimer = 0;

  function refreshCommandsOverview() {
    const overview = page.CommandsOverview;

    // Não abre janelas nem altera o envio. Actualiza apenas Comandos já aberto.
    if (!document.querySelector('#command_overview')) return;
    if (typeof overview?.doRefresh !== 'function') return;

    overview.doRefresh();
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshCommandsOverview, REFRESH_DELAY_MS);
  }

  function isCommandMutationRequest(url, body = '') {
    const request = `${String(url || '')}&${String(body || '')}`;
    return /(?:^|[?&/])(?:action=)?(?:send_units|cancel_command)(?:[?&#/=]|$)/i.test(request);
  }

  function observeXmlHttpRequests() {
    const prototype = page.XMLHttpRequest?.prototype;
    if (!prototype || prototype.__commandOverviewAutoRefresh) return;

    const originalOpen = prototype.open;
    const originalSend = prototype.send;

    prototype.open = function open(method, url, ...args) {
      this[REQUEST_URL] = url;
      return originalOpen.call(this, method, url, ...args);
    };

    prototype.send = function send(body) {
      if (isCommandMutationRequest(this[REQUEST_URL], body)) {
        this.addEventListener('load', () => {
          if (this.status >= 200 && this.status < 300) scheduleRefresh();
        }, { once: true });
      }
      return originalSend.call(this, body);
    };

    Object.defineProperty(prototype, '__commandOverviewAutoRefresh', {
      value: true
    });
  }

  function observeFetchRequests() {
    if (typeof page.fetch !== 'function' || page.fetch.__commandOverviewAutoRefresh) return;

    const originalFetch = page.fetch;
    const wrappedFetch = async function fetch(input, init) {
      const response = await originalFetch.call(this, input, init);
      const url = typeof input === 'string' ? input : input?.url;
      if (response.ok && isCommandMutationRequest(url, init?.body)) scheduleRefresh();
      return response;
    };

    Object.defineProperty(wrappedFetch, '__commandOverviewAutoRefresh', {
      value: true
    });
    page.fetch = wrappedFetch;
  }

  function subscribeToGameEvents() {
    if (subscribed) return true;

    const observer = page.$?.Observer;
    const sendEvent = page.GameEvents?.command?.send_unit;
    const incomingAttackEvent = page.GameEvents?.attack?.incoming;
    if (typeof observer !== 'function' || !sendEvent || !incomingAttackEvent) return false;

    observer(sendEvent).subscribe(SUBSCRIBER_ID, (_event, command) => {
      if (['attack', 'support'].includes(command?.sending_type)) scheduleRefresh();
    });
    observer(incomingAttackEvent).subscribe(SUBSCRIBER_ID, scheduleRefresh);
    subscribed = true;
    return true;
  }

  observeXmlHttpRequests();
  observeFetchRequests();

  if (!subscribeToGameEvents()) {
    const waitForGame = window.setInterval(() => {
      if (!subscribeToGameEvents()) return;
      window.clearInterval(waitForGame);
    }, 500);
  }
}());
