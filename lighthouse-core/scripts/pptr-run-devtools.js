'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');

/** @typedef {{result?: {value?: string, objectId?: number}, exceptionDetails?: object}} ProtocolResponse */

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
    (lhr, artifacts) => resolve(JSON.stringify(lhr))
  );
});
`;

const startLighthouse = `
(() => {
  UI.ViewManager.instance().showView('lighthouse');
  UI.panels.lighthouse.contentElement.querySelector('button').click();
})()
`;

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    devtools: true,
  });
  const page = await browser.newPage();

  // Cut off JS for initial page load.
  // This step is unnecessary for every page I tried except https://cnn.com.
  await page.setJavaScriptEnabled(false);

  await page.goto(process.argv[2]);
  const targets = await browser.targets();
  const inspectorTarget = targets.filter(t => t.url().includes('devtools'))[1];
  if (inspectorTarget) {
    // Enable JS for actual LH test.
    await page.setJavaScriptEnabled(true);

    const session = await inspectorTarget.createCDPSession();
    await session.send('Runtime.enable');

    /** @type {ProtocolResponse|undefined} */
    let startLHResponse;
    while (!startLHResponse || startLHResponse.exceptionDetails) {
      startLHResponse = await session.send('Runtime.evaluate', {expression: startLighthouse})
        .catch(err => err);
      if (startLHResponse && !startLHResponse.exceptionDetails) break;
    }

    /** @type {ProtocolResponse} */
    const snifferAddedResponse = await session.send('Runtime.evaluate', {expression: sniffLhr})
      .catch(err => err);
    if (!snifferAddedResponse.result || !snifferAddedResponse.result.objectId) {
      throw new Error('Problem creating LHR sniffer.');
    }

    /** @type {ProtocolResponse} */
    const remoteLhrResponse = await session.send('Runtime.awaitPromise', {
      promiseObjectId: snifferAddedResponse.result.objectId,
    }).catch(err => err);
    if (!remoteLhrResponse.result || !remoteLhrResponse.result.value) {
      throw new Error('Problem sniffing LHR.');
    }

    fs.writeFileSync('latest-run/lhr.json', remoteLhrResponse.result.value);

    await session.send('Runtime.disable');

    await page.close();
    await browser.close();
  }
}
run();
