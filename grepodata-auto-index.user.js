// ==UserScript==
// @name         GrepoData City Indexer + Auto Index
// @namespace    grepodata
// @version      2.3.0
// @author       grepodata.com
// @homepage     https://grepodata.com/indexer
// @updateURL    https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/codex/add-grepodata-spam/grepodata-auto-index.user.js
// @downloadURL  https://raw.githubusercontent.com/Kelsiito/grepolis-scrpts/codex/add-grepodata-spam/grepodata-auto-index.user.js
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
    var MIN_INDEX_INTERVAL = 750;
    var NO_POINTS_TTL = 6 * 60 * 60 * 1000;
    var STORAGE_KEY = 'gd_auto_index_dedupe_v1:' + window.location.hostname;
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
        checkTimer = window.setTimeout(indexOpenReport, 100);
    }

    function indexOpenReport() {
        var reportWindow = document.querySelector('#report_report');

        if (!reportWindow || !isVisible(reportWindow)) {
            return;
        }

        var reportDecision = classifyReport(reportWindow);

        if (!reportDecision.shouldIndex) {
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
        rememberReport(reportDecision);
        console.info('[GrepoData Auto-Indexer] A indexar o relatorio aberto.');
        indexButton.click();
    }

    function classifyReport(reportWindow) {
        var text = reportWindow.textContent
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        var targetKey = getTargetKey(reportWindow, text);
        var state = loadDedupeState();
        var now = Date.now();

        var isEspionage = text.indexOf('espionagem') !== -1 ||
            text.indexOf('espiou') !== -1 ||
            text.indexOf('espiar') !== -1 ||
            text.indexOf('spy report') !== -1 ||
            text.indexOf('spied') !== -1;

        var failedEspionage = text.indexOf('espionagem falhou') !== -1 ||
            text.indexOf('espionagem não foi bem-sucedida') !== -1 ||
            text.indexOf('espionagem nao foi bem-sucedida') !== -1 ||
            text.indexOf('spy failed') !== -1 ||
            text.indexOf('was not successful') !== -1;

        var hasNoBattlePoints =
            text.indexOf('não recebeu pontos de combate') !== -1 ||
            text.indexOf('nao recebeu pontos de combate') !== -1 ||
            text.indexOf('no battle points') !== -1;

        if (isEspionage) {
            if (failedEspionage) {
                console.info('[GrepoData Auto-Indexer] Espionagem falhada ignorada.');
                return { shouldIndex: false };
            }

            if (state.espionage[targetKey]) {
                console.info('[GrepoData Auto-Indexer] Espionagem repetida ignorada.');
                return { shouldIndex: false };
            }

            return {
                shouldIndex: true,
                bucket: 'espionage',
                targetKey: targetKey,
                timestamp: now
            };
        }

        if (hasNoBattlePoints) {
            var previous = state.noPoints[targetKey] || 0;

            if (now - previous < NO_POINTS_TTL) {
                console.info('[GrepoData Auto-Indexer] Report sem pontos repetido ignorado.');
                return { shouldIndex: false };
            }

            return {
                shouldIndex: true,
                bucket: 'noPoints',
                targetKey: targetKey,
                timestamp: now
            };
        }

        return { shouldIndex: true };
    }

    function getTargetKey(reportWindow, normalizedText) {
        var townElements = reportWindow.querySelectorAll(
            '[data-townid], [data-town_id], a[href*="town_id"]'
        );

        for (var index = townElements.length - 1; index >= 0; index -= 1) {
            var element = townElements[index];
            var townId = element.getAttribute('data-townid') ||
                element.getAttribute('data-town_id');
            var href = element.getAttribute('href') || '';
            var hrefMatch = href.match(/[?&]town_id=(\d+)/);

            if (townId || hrefMatch) {
                return 'town:' + (townId || hrefMatch[1]);
            }
        }

        var header = reportWindow.querySelector('#report_report_header');
        var headerText = header ? header.textContent : normalizedText.slice(0, 250);

        return 'title:' + normalizeKey(headerText);
    }

    function normalizeKey(value) {
        return String(value)
            .toLowerCase()
            .replace(/\d{1,2}[/.:-]\d{1,2}[/.:-]\d{2,4}/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 250);
    }

    function loadDedupeState() {
        var emptyState = { espionage: {}, noPoints: {} };

        try {
            var parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY));

            if (!parsed || typeof parsed !== 'object') {
                return emptyState;
            }

            parsed.espionage = parsed.espionage || {};
            parsed.noPoints = parsed.noPoints || {};
            return parsed;
        } catch (error) {
            return emptyState;
        }
    }

    function rememberReport(decision) {
        if (!decision.bucket || !decision.targetKey) {
            return;
        }

        var state = loadDedupeState();
        state[decision.bucket][decision.targetKey] = decision.timestamp;

        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.warn('[GrepoData Auto-Indexer] Memoria de duplicados indisponivel.');
        }
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
