/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * USAGE:
 * URL list file: yarn run-devtools < path/to/urls.txt
 * Single URL: yarn run-devtools "https://example.com"
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline');
const glob = require('glob');

/** @typedef {{result?: {value?: string, objectId?: number}, exceptionDetails?: object}} RuntimeEvaluateResponse */

const OUTPUT_DIR = 'latest-run/devtools-lhrs';

const urlArg = process.argv[2];

/**
 * https://source.chromium.org/chromium/chromium/src/+/master:third_party/devtools-frontend/src/front_end/test_runner/TestRunner.js;l=170;drc=f59e6de269f4f50bca824f8ca678d5906c7d3dc8
 * @param {Record<string, function>} receiver
 * @param {string} methodName
 * @param {function} override
 */
function addSniffer(receiver, methodName, override) {
  const original = receiver[methodName];
  if (typeof original !== 'function') {
    throw new Error('Cannot find method to override: ' + methodName);
  }

  receiver[methodName] = function() {
    let result;
    try {
      // eslint-disable-next-line prefer-rest-params
      result = original.apply(this, arguments);
    } finally {
      receiver[methodName] = original;
    }
    // In case of exception the override won't be called.
    try {
      // eslint-disable-next-line prefer-rest-params
      Array.prototype.push.call(arguments, result);
      // eslint-disable-next-line prefer-rest-params
      override.apply(this, arguments);
    } catch (e) {
      throw new Error('Exception in overriden method \'' + methodName + '\': ' + e);
    }
    return result;
  };
}

const sniffLhr = `
new Promise(resolve => {
  (${addSniffer.toString()})(
    UI.panels.lighthouse.__proto__,
    '_buildReportUI',
    (lhr, artifacts) => resolve(lhr)
  );
});
`;

const startLighthouse = `
(() => {
  UI.ViewManager.instance().showView('lighthouse');
  const button = UI.panels.lighthouse.contentElement.querySelector('button');
  if (button.disabled) throw new Error('Start button disabled');
  button.click();
})()
`;

/**
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @return {Promise<string>}
 */
async function testPage(browser, url) {
  const page = await browser.newPage();

  const targets = await browser.targets();
  const inspectorTarget = targets.filter(t => t.url().includes('devtools'))[1];
  if (!inspectorTarget) throw new Error('No inspector found.');

  const session = await inspectorTarget.createCDPSession();
  await session.send('Runtime.enable');

  // Navigate to page and wait for initial HTML to be parsed before trying to start LH.
  await new Promise(async resolve => {
    const pageSession = await page.target().createCDPSession();
    await pageSession.send('Page.enable');
    pageSession.once('Page.domContentEventFired', resolve);
    page.goto(url).catch(err => err);
  });

  /** @type {RuntimeEvaluateResponse|undefined} */
  let startLHResponse;
  while (!startLHResponse || startLHResponse.exceptionDetails) {
    startLHResponse = await session.send('Runtime.evaluate', {expression: startLighthouse})
      .catch(err => err);
  }

  /** @type {RuntimeEvaluateResponse} */
  const remoteLhrResponse = await session.send('Runtime.evaluate', {
    expression: sniffLhr,
    awaitPromise: true,
    returnByValue: true,
  }).catch(err => err);

  if (!remoteLhrResponse.result || !remoteLhrResponse.result.value) {
    throw new Error('Problem sniffing LHR.');
  }

  await page.close();

  return JSON.stringify(remoteLhrResponse.result.value);
}

/**
 * @return {Promise<string[]>}
 */
async function readUrlList() {
  if (urlArg) return [urlArg];

  /** @type {string[]} */
  const urlList = [];
  const rl = readline.createInterface(process.stdin, process.stdout);
  rl.on('line', line => {
    if (line.startsWith('#')) return;
    urlList.push(line);
  });

  return new Promise(resolve => rl.on('close', () => resolve(urlList)));
}

async function run() {
  // Create output directory.
  if (fs.existsSync(OUTPUT_DIR)) {
    const files = new glob.GlobSync(`${OUTPUT_DIR}/*`).found;
    for (const file of files) {
      fs.unlinkSync(file);
    }
  } else {
    fs.mkdirSync(OUTPUT_DIR, {recursive: true});
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    devtools: true,
  });

  const urlList = await readUrlList();
  for (let i = 0; i < urlList.length; ++i) {
    const lhr = await testPage(browser, urlList[i]);
    fs.writeFileSync(`${OUTPUT_DIR}/lhr-${i}.json`, lhr);
  }

  await browser.close();
}
run();
