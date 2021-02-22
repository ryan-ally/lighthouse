'use strict';

const puppeteer = require('puppeteer');

/**
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

const sniff = `
new Promise(resolve => {
  (${addSniffer.toString()})(
    UI.panels.lighthouse.__proto__,
    '_buildReportUI',
    (lhr, artifacts) => resolve(JSON.stringify(lhr))
  );
});
`;
const openPanel = `UI.ViewManager.instance().showView('lighthouse')`;
const startLH = `UI.panels.lighthouse.contentElement.querySelector('button').click()`;

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    devtools: true,
  });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  const targets = await browser.targets();
  const dtTarget = targets.filter(t => t.url().includes('devtools'))[1];
  if (dtTarget) {
    const session = await dtTarget.createCDPSession();
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    session.once('Page.loadEventFired', async () => {
      setTimeout(async () => {
        await session.send('Runtime.evaluate', {expression: openPanel});
      }, 1000);
      setTimeout(async () => {
        await session.send('Runtime.evaluate', {expression: startLH});
        const remotePromise = await session.send('Runtime.evaluate', {expression: sniff});
        const remoteLhr = await session.send('Runtime.awaitPromise', {
          // @ts-expect-error
          promiseObjectId: remotePromise.result.objectId,
        }).catch(err => err);
        // eslint-disable-next-line no-console
        console.log(remoteLhr.result.value);
        await page.close();
        await browser.close();
      }, 1500);
      await session.send('Runtime.disable');
      await session.send('Page.disable');
    });
  }
}
run();
