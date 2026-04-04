'use strict';

const qs = require('qs');

// Fixed PKCE pair matching the login URL in admin settings
const CODE_VERIFIER = 'zmVs5AKfGvv45a9aUvuOid9a_erOirp7XL1sn9kWT_o';

/**
 * DHL Login via dhllogin:// code (manual browser flow).
 * User opens the DHL login URL in browser, logs in, copies the dhllogin:// redirect URL.
 *
 * @param {object} options
 * @param {function} options.requestClient - axios-like request function
 * @param {string} options.dhlCode - dhllogin://de.deutschepost.dhl/login?code=...
 * @param {object} [options.log] - logger with .info/.debug/.error/.warn
 * @returns {Promise<object|null>} session data (with id_token, refresh_token, etc.) or null on failure
 */
async function loginDhlNew({ requestClient, dhlCode, log }) {
  if (!log) {
    log = { info: console.log, debug: console.log, error: console.error, warn: console.warn };
  }

  if (!dhlCode || !dhlCode.startsWith('dhllogin://')) {
    log.error('No valid dhllogin:// code provided. Please use the login button in adapter settings.');
    return null;
  }

  const codeUrl = qs.parse(dhlCode.split('?')[1]);
  if (!codeUrl.code) {
    log.error('No code found in dhllogin:// URL');
    return null;
  }

  const sessionData = await requestClient({
    method: 'post',
    url: 'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login/token',
    headers: {
      Host: 'login.dhl.de',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://login.dhl.de',
      Connection: 'keep-alive',
      Authorization: 'Basic ODM0NzEwODItNWMxMy00ZmNlLThkY2ItMTlkMmEzZmNhNDEzOg==',
      'User-Agent': 'DHLPaket_PROD/1367 CFNetwork/1240.0.4 Darwin/20.6.0',
      'Accept-Language': 'de-de',
    },
    data: {
      redirect_uri: 'dhllogin://de.deutschepost.dhl/login',
      grant_type: 'authorization_code',
      code_verifier: CODE_VERIFIER,
      code: codeUrl.code,
    },
  })
    .then(async (res) => {
      log.debug(JSON.stringify(res.data));
      log.info('Login to DHL successful');
      return res.data;
    })
    .catch((error) => {
      log.error(error);
      if (error.response) {
        log.error(JSON.stringify(error.response.data));
      }
      return null;
    });

  return sessionData;
}

module.exports = { loginDhlNew };
