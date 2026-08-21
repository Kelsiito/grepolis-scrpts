// ==UserScript==
// @name         GrepoData City Indexer + Auto Index
// @namespace    grepodata
// @version      2.2.0
// @author       grepodata.com
// @homepage     https://grepodata.com/indexer
// @description  GrepoData City Indexer com indexacao automatica de relatorios
// @match        https://*.grepolis.com/game/*
// @match        https://grepodata.com/*
// @match        https://www.grepodata.com/*
// @exclude      view-source://*
// @icon         https://grepodata.com/assets/images/grepodata_icon.ico
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    var API_URL = 'https://api.grepodata.com/script';
    var MIN_INDEX_INTERVAL = 5000;
    var cacheVersion = Math.floor(Date.now() / 3600000);
    var checkTimer = null;
    var lastIndexTime = 0;

    loadGrepoData();
    enableAutoIndexer();

    function loadGrepoData() {
        if (!document.querySelector('script[data-grepodata-indexer]')) {
            var script = document.createElement('script');
            script.setAttribute('data-grepodata-indexer', 'true');
            script.src = API_URL + '/indexer.js?v=' + cacheVersion;

            script.addEventListener('load', function () {
                console.info('[GrepoData Auto-Indexer] GrepoData carregado.');
                scheduleIndexCheck();
            });

            script.addEventListener('error', function () {
                console.error('[GrepoData Auto-Indexer] Erro ao carregar o GrepoData.');
            });

            (document.head || document.documentElement).appendChild(script);
        }

        if (!document.querySelector('link[data-grepodata-indexer]')) {
            var style = document.createElement('link');
            style.setAttribute('data-grepodata-indexer', 'true');
            style.rel = 'stylesheet';
            style.href = API_URL + '/indexer.css?v=' + cacheVersion;
            (document.head || document.documentElement).appendChild(style);
        }
    }

    function enableAutoIndexer() {
        var observer = new MutationObserver(scheduleIndexCheck);

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        scheduleIndexCheck();
    }

    function scheduleIndexCheck() {
        window.clearTimeout(checkTimer);
        checkTimer = window.setTimeout(indexOpenReport, 350);
    }

    function indexOpenReport() {
        var reportWindow = document.querySelector('#report_report');

        if (!reportWindow || !isVisible(reportWindow)) {
            return;
        }

        if (!isUsefulCombatReport(reportWindow)) {
            return;
        }

        var elapsed = Date.now() - lastIndexTime;

        if (elapsed < MIN_INDEX_INTERVAL) {
            window.clearTimeout(checkTimer);
            checkTimer = window.setTimeout(
                indexOpenReport,
                MIN_INDEX_INTERVAL - elapsed
            );
            return;
        }

        var indexButton = reportWindow.querySelector(
            '#gd_index_rep_, .gd_btn_index'
        );

        if (!indexButton || !isVisible(indexButton)) {
            return;
        }

        var label = indexButton.querySelector(
            '#gd_index_rep_txt_id, .middle'
        );
        var buttonText = (label ? label.textContent : indexButton.textContent)
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (buttonText.indexOf('index +') !== 0) {
            indexButton.removeAttribute('data-gd-auto-indexed');
            return;
        }

        if (indexButton.getAttribute('data-gd-auto-indexed') === 'true') {
            return;
        }

        indexButton.setAttribute('data-gd-auto-indexed', 'true');
        lastIndexTime = Date.now();
        console.info('[GrepoData Auto-Indexer] A indexar o relatorio aberto.');
        indexButton.click();
    }

    function isUsefulCombatReport(reportWindow) {
        var text = reportWindow.textContent
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        var isEspionage = text.indexOf('espionagem') !== -1 ||
            text.indexOf('espiou') !== -1 ||
            text.indexOf('spy report') !== -1 ||
            text.indexOf('spied') !== -1;

        var hasNoBattlePoints =
            text.indexOf('não recebeu pontos de combate') !== -1 ||
            text.indexOf('nao recebeu pontos de combate') !== -1 ||
            text.indexOf('no battle points') !== -1;

        var isConquest = text.indexOf('conquista') !== -1 ||
            text.indexOf('conquistou') !== -1 ||
            text.indexOf('revolta') !== -1 ||
            text.indexOf('conquest') !== -1 ||
            text.indexOf('revolt') !== -1;

        if (isEspionage) {
            console.info('[GrepoData Auto-Indexer] Espionagem ignorada.');
            return false;
        }

        if (hasNoBattlePoints && !isConquest) {
            console.info(
                '[GrepoData Auto-Indexer] Relatorio sem combate ignorado.'
            );
            return false;
        }

        return true;
    }

    function isVisible(element) {
        if (!element || !element.isConnected) {
            return false;
        }

        var style = window.getComputedStyle(element);

        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 &&
            element.getClientRects().length > 0;
    }
}());
