'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter

//disable canvas because of missing rebuild
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function () {
  if (arguments[0] === 'canvas') {
    return { createCanvas: null, createImageData: null, loadImage: null };
  }
  return originalRequire.apply(this, arguments);
};

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const qs = require('qs');
const crypto = require('crypto');
const Json2iob = require('json2iob');
const getPwd = require('./lib/rsaKey');
const tough = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { sep } = require('path');
const { tmpdir } = require('os');

const dhlDecrypt = require('./lib/dhldecrypt');
class Parcel extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'parcel',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.json2iob = new Json2iob(this);
    this.sessions = {};
    this.mergedJson = [];
    this.inDelivery = [];
    this.mergedJsonObject = {};
    this.images = {};
    this.alreadySentMessages = {};
    this.ignoredPath = [];
    this.firstStart = true;
    this.delivery_status = {
      ERROR: -1,
      UNKNOWN: 5,
      REGISTERED: 10,
      IN_PREPARATION: 20,
      IN_TRANSIT: 30,
      OUT_FOR_DELIVERY: 40,
      DELIVERED: 1,
    };
    this.tmpDir = tmpdir();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }

    this.cookieJar = new tough.CookieJar();
    const cookieState = await this.getStateAsync('auth.cookie');
    if (cookieState && cookieState.val) {
      this.cookieJar = tough.CookieJar.fromJSON(cookieState.val);
    }
    this.requestClient = axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({ cookies: { jar: this.cookieJar } }),
    });

    if (this.config.dhlusername && this.config.dhlpassword) {
      this.log.info('Login to DHL');
      await this.loginDhlNew();
    }

    if (this.config.dpdusername && this.config.dpdpassword) {
      this.log.info('Login to DPD');
      await this.loginDPD();
    }
    if (this.config.t17username && this.config.t17password) {
      this.log.info('Login to T17 User');
      await this.login17T();
    }
    if (this.config.aliUsername && this.config.aliPassword) {
      this.log.info('Login to AliExpres');
      await this.loginAli();
    }

    if (this.config['17trackKey']) {
      this.sessions['17track'] = this.config['17trackKey'];
      this.login17TApi();
      this.setState('info.connection', true, true);
    }
    if (this.config.amzusername && this.config.amzpassword) {
      this.log.info('Login to Amazon');
      await this.loginAmz();
    }

    if (this.config.glsusername && this.config.glspassword) {
      this.log.info('Login to GLS');
      await this.loginGLS();
    }
    if (this.config.upsusername && this.config.upspassword) {
      this.log.info('Login to UPS');
      await this.loginUPS();
    }
    if (this.config.hermesusername && this.config.hermespassword) {
      this.log.info('Login to Hermes');
      await this.loginHermes();
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.subscribeStates('*');

    if (Object.keys(this.sessions).length > 0) {
      await this.updateProvider();
      this.updateInterval = setInterval(async () => {
        this.firstStart = false;
        await this.updateProvider();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, 29 * 60 * 1000);
    } else {
      this.log.warn('No login session found');
    }
  }
  async loginDhlNew() {
    // const validCookies = await this.requestClient({
    //   method: "get",
    //   url: "https://www.dhl.de/int-stammdaten/public/customerMasterData",
    //   headers: {
    //     accept: "application/json",
    //     "content-type": "application/json",
    //     "x-api-key": "a0d5b9049ba8918871e6e20bd5c49974",
    //     "accept-language": "de-de",
    //     "user-agent": "DHLPaket_PROD/1367 CFNetwork/1240.0.4 Darwin/20.6.0",
    //   },
    // })
    //   .then((res) => {
    //     this.log.debug(res.data);
    //     return true;
    //   })
    //   .catch((err) => {
    //     return false;
    //   });
    // if (validCookies) {
    //   this.log.info("Valid dhl cookies found");

    //   this.setState("info.connection", true, true);
    //   return;
    // }

    const [code_verifier, codeChallenge] = this.getCodeChallenge();

    const transactionId = this.randomString(40);
    const initUrl = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url: 'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login/authorize',
      params: {
        redirect_uri: 'dhllogin://de.deutschepost.dhl/login',
        state:
          'eyJycyI6dHJ1ZSwicnYiOmZhbHNlLCJmaWQiOiJhcHAtbG9naW4tbWVoci1mb290ZXIiLCJoaWQiOiJhcHAtbG9naW4tbWVoci1oZWFkZXIiLCJycCI6ZmFsc2V9',
        client_id: '83471082-5c13-4fce-8dcb-19d2a3fca413',
        response_type: 'code',
        scope: 'openid offline_access',
        claims:
          '{"id_token":{"email":null,"post_number":null,"twofa":null,"service_mask":null,"deactivate_account":null,"last_login":null,"customer_type":null,"display_name":null}}',
        nonce: '',
        login_hint: '',
        prompt: 'login',
        ui_locales: 'de-DE',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256"',
      },
      headers: {
        Host: 'login.dhl.de',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'de-de',
        Connection: 'keep-alive',
      },
    })
      .then(async (res) => {
        // this.log.debug(res.data);
        return res.request.path;
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    const initParams = qs.parse(initUrl.split('?')[1]);
    const signin = await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://login-api.dhl.de/widget/traditional_signin.jsonp',
      headers: {
        Host: 'login-api.dhl.de',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://login.dhl.de',
        Connection: 'keep-alive',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        Referer: 'https://login.dhl.de/',
        'Accept-Language': 'de-de',
      },
      data: {
        utf8: '✓',
        capture_screen: 'signIn',
        js_version: 'd445bf4',
        capture_transactionId: transactionId,
        form: 'signInForm',
        flow: 'ciam_flow_001',
        client_id: 'f8s9584t9f9kz5wg9agkp259hc924uq9',
        redirect_uri: 'https://login.dhl.de' + initUrl,
        response_type: 'token',
        flow_version: '20230309140056615616',
        settings_version: '',
        locale: 'de-DE',
        recaptchaVersion: '2',
        emailOrPostNumber: this.config.dhlusername,
        currentPassword: this.config.dhlpassword,
      },
    })
      .then(async (res) => {
        this.log.debug(res.data);
        return true;
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    if (!signin) {
      this.log.error('DHL Signin failed');
      return;
    }
    const preSession = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url: 'https://login-api.dhl.de/widget/get_result.jsonp?transactionId=' + transactionId + '&cache=' + Date.now(),
      headers: {
        Host: 'login-api.dhl.de',
        Connection: 'keep-alive',
        Accept: '*/*',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'de-de',
        Referer: 'https://login.dhl.de/',
      },
    })
      .then(async (res) => {
        this.log.debug(res.data);
        return JSON.parse(res.data.split(')(')[1].split(');')[0]);
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    if (!preSession || !preSession.result) {
      this.log.error('DHL PreSession failed. Please check username password');
      return;
    }
    const accessToken2 = await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/auth-ui/token-url',
      params: {
        __aic_csrf: initParams.__aic_csrf,
        claims:
          '{"id_token":{"customer_type":null,"deactivate_account":null,"display_name":null,"email":null,"last_login":null,"post_number":null,"service_mask":null,"twofa":null}}',
        client_id: '83471082-5c13-4fce-8dcb-19d2a3fca413',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: '',
        nonce: '',
        prompt: 'login',
        redirect_uri: 'dhllogin://de.deutschepost.dhl/login',
        response_type: 'code',
        scope: 'openid',
        state:
          'eyJycyI6dHJ1ZSwicnYiOmZhbHNlLCJmaWQiOiJhcHAtbG9naW4tbWVoci1mb290ZXIiLCJoaWQiOiJhcHAtbG9naW4tbWVoci1oZWFkZXIiLCJycCI6ZmFsc2V9',
        ui_locales: 'de-DE",',
      },
      headers: {
        Host: 'login.dhl.de',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://login.dhl.de',
        Connection: 'keep-alive',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'de-de',
      },
      data: {
        screen: 'signIn',
        authenticated: 'True',
        registering: 'False',
        accessToken: preSession.result.accessToken,
        _csrf_token: this.cookieJar.store.idx['login.dhl.de']['/']._csrf_token.value,
      },
    })
      .then(async (res) => {
        // this.log.debug(res.data);

        return res.data.split("existingToken: '")[1].split("'")[0];
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    const idtoken = await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/auth-ui/token-url',
      maxRedirects: 0,
      params: {
        __aic_csrf: initParams.__aic_csrf,
        claims:
          '{"id_token":{"customer_type":null,"deactivate_account":null,"display_name":null,"email":null,"last_login":null,"post_number":null,"service_mask":null,"twofa":null}}',
        client_id: '83471082-5c13-4fce-8dcb-19d2a3fca413',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: '',
        nonce: '',
        prompt: 'login',
        redirect_uri: 'dhllogin://de.deutschepost.dhl/login',
        response_type: 'code',
        scope: 'openid',
        state:
          'eyJycyI6dHJ1ZSwicnYiOmZhbHNlLCJmaWQiOiJhcHAtbG9naW4tbWVoci1mb290ZXIiLCJoaWQiOiJhcHAtbG9naW4tbWVoci1oZWFkZXIiLCJycCI6ZmFsc2V9',
        ui_locales: 'de-DE',
      },
      headers: {
        Host: 'login.dhl.de',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://login.dhl.de',
        Connection: 'keep-alive',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'de-de',
      },
      data: {
        screen: 'loginSuccess',
        accessToken: accessToken2,
        _csrf_token: this.cookieJar.store.idx['login.dhl.de']['/']._csrf_token.value,
      },
    })
      .then(async (res) => {
        this.log.debug(res.data);
        return res.data;
      })
      .catch((error) => {
        if (error.response && error.response.status === 302) {
          return error.response.headers.location.split('id_token_hint=')[1].split('&')[0];
        }
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    const codeUrl = await this.requestClient({
      method: 'get',
      maxBodyLength: Infinity,
      url:
        'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login/authorize?claims={"id_token":{"customer_type":null,"deactivate_account":null,"display_name":null,"email":null,"last_login":null,"post_number":null,"service_mask":null,"twofa":null}}&client_id=83471082-5c13-4fce-8dcb-19d2a3fca413&code_challenge=' +
        codeChallenge +
        '&code_challenge_method=S256&prompt=none&redirect_uri=dhllogin://de.deutschepost.dhl/login&response_type=code&scope=openid&state=eyJycyI6dHJ1ZSwicnYiOmZhbHNlLCJmaWQiOiJhcHAtbG9naW4tbWVoci1mb290ZXIiLCJoaWQiOiJhcHAtbG9naW4tbWVoci1oZWFkZXIiLCJycCI6ZmFsc2V9&ui_locales=de-DE&id_token_hint=' +
        idtoken,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
      })
      .catch((error) => {
        if (error.message.includes('Unsupported protocol')) {
          return qs.parse(error.request._options.query);
        }
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    await this.requestClient({
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
        code_verifier: code_verifier,
        code: codeUrl.code,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Login to DHL successful');
        this.sessions['dhl'] = res.data;
        await this.cookieJar.setCookie('dhli=' + res.data.id_token + '; path=/; domain=dhl.de', 'https:/dhl.de');
        await this.cookieJar.setCookie('dhli=' + res.data.id_token + '; path=/; domain=www.dhl.de', 'https:/www.dhl.de');
        this.setState('info.connection', true, true);
        this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
        await this.createDHLStates();
        return true;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async loginDHL() {
    const mfaTokenState = await this.getStateAsync('auth.dhlMfaToken');
    await this.requestClient({
      method: 'get',
      url: 'https://www.dhl.de/int-webapp/spa/prod/ver4-SPA-VERFOLGEN.html?adobe_mc=TS%3D1643057331%7CMCORGID%3D3505782352FCE66F0A490D4C%40AdobeOrg',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'accept-language': 'de-de',
      },
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });

    const validCookies = await this.requestClient({
      method: 'post',
      url: 'https://www.dhl.de/int-erkennen/refresh',
      headers: {
        Host: 'www.dhl.de',
        'content-type': 'application/json',
        accept: '*/*',
        'x-requested-with': 'XMLHttpRequest',
        'accept-language': 'de-de',
        origin: 'https://www.dhl.de',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        referer:
          'https://www.dhl.de/int-webapp/spa/prod/ver4-SPA-VERFOLGEN.html?adobe_mc=TS%3D1643039135%7CMCORGID%3D3505782352FCE66F0A490D4C%40AdobeOrg',
      },
      data: JSON.stringify({
        force: false,
        meta: '',
      }),
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.meta) {
          this.log.info('Login to DHL successful');
          this.sessions['dhl'] = res.data;
          this.setState('info.connection', true, true);
          this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
          await this.createDHLStates();
          return true;
        }
        return false;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (validCookies) {
      return;
    }
    const mfaToken = mfaTokenState && mfaTokenState.val;
    if (!mfaToken || !this.config.dhlMfa) {
      this.log.info('Login to DHL');
      await this.requestClient({
        method: 'post',
        url: 'https://www.dhl.de/int-erkennen/login',
        headers: {
          Host: 'www.dhl.de',
          'content-type': 'application/json',
          accept: '*/*',
          'x-requested-with': 'XMLHttpRequest',
          'accept-language': 'de-de',
          origin: 'https://www.dhl.de',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        },

        data: JSON.stringify({
          id: this.config.dhlusername,
          password: this.config.dhlpassword,
          authenticationLevel: 3,
          authenticationMethod: ['pwd'],
          rememberMe: true,
          language: 'de',
          context: 'app',
          meta: '',
        }),
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));

          this.setState('auth.dhlMfaToken', res.data.intermediateMfaToken, true);
          this.log.warn('Please enter ' + res.data.secondFactorChannel + ' code in instance settings and press save');
        })
        .catch((error) => {
          this.log.error(error);
          if (error.response) {
            if (error.response.status === 409) {
              this.log.error('Please enter code in instance settings and press save or wait 30min and let the code expire');

              this.setState('auth.dhlMfaToken', error.response.data.intermediateMfaToken, true);
            }
            this.log.error(JSON.stringify(error.response.data));
          }
        });
    } else {
      this.log.info('Login to DHL with MFA token');
      this.log.debug('MFA: ' + this.config.dhlMfa);
      await this.requestClient({
        method: 'post',
        url: 'https://www.dhl.de/int-erkennen/2fa',
        headers: {
          Host: 'www.dhl.de',
          'content-type': 'application/json',
          accept: '*/*',
          'x-requested-with': 'XMLHttpRequest',
          'accept-language': 'de-de',
          origin: 'https://www.dhl.de',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        },

        data: JSON.stringify({
          value: this.config.dhlMfa,
          remember2fa: true,
          language: 'de',
          context: 'app',
          meta: '',
          intermediateMfaToken: mfaToken,
        }),
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.log.info('Login to DHL successful');
          this.sessions['dhl'] = res.data;
          this.setState('info.connection', true, true);
          this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
          await this.createDHLStates();
        })
        .catch(async (error) => {
          this.log.error(error);
          if (error.response) {
            this.setState('info.connection', false, true);
            this.log.error(JSON.stringify(error.response.data));
            const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
            this.log.error('MFA incorrect');
            this.getForeignObject(adapterConfig, (error, obj) => {
              if (obj && obj.native && obj.native.dhlMfa) {
                obj.native.dhlMfa = '';
                this.setForeignObject(adapterConfig, obj);
              }
            });
            return;
          }
        });
    }
  }
  async loginAli() {
    const loginData = await this.requestClient({
      method: 'get',
      url: 'https://passport.aliexpress.com/mini_login.htm?lang=de_de&appName=aebuyer&appEntrance=default&styleType=auto&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false&cssLink=https://i.alicdn.com/noah-static/4.0.2/common/css/reset-havana.css&cssUrl=https://i.alicdn.com/noah-static/4.0.2/common/css/reset-havana-new-page.css&showMobilePwdLogin=false&defaultCountryCode=DE&ut=&rnd=0.9085151696364684',
      headers: {
        'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'upgrade-insecure-requests': '1',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.20 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
        referer: 'https://login.aliexpress.com/',
        'accept-language': 'de',
      },
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.indexOf('window.viewData = ') !== -1) {
          try {
            const loginData = res.data.split('window.viewData = ')[1].split(';')[0].replace(/\\/g, '');
            return JSON.parse(loginData).loginFormData;
          } catch (error) {
            this.log.error(error);
          }
        } else {
          this.log.error('Failed Step 1 Aliexpress');
        }
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });

    if (!loginData) {
      return;
    }
    if (!this.config.aliMfa) {
      loginData.loginId = this.config.aliUsername;
      loginData.password2 = getPwd(this.config.aliPassword);
      await this.requestClient({
        method: 'post',
        url: 'https://passport.aliexpress.com/newlogin/login.do?appName=aebuyer&fromSite=13&_bx-v=2.0.39',
        headers: {
          'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded',
          'sec-ch-ua-mobile': '?0',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.20 Safari/537.36',
          'sec-ch-ua-platform': '"macOS"',
          origin: 'https://login.aliexpress.com',
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          referer: 'https://login.aliexpress.com/',
          'accept-language': 'de',
        },

        data: qs.stringify(loginData),
      })
        .then(async (res) => {
          if (res.data.url && res.data.url.indexOf('punish') !== -1) {
            this.log.error('Failed because of captcha');
          }
          //  this.log.debug(JSON.stringify(res.data));
        })
        .catch((error) => {
          this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
          }
        });
      await this.requestClient({
        method: 'get',
        url: 'https://www.aliexpress.com/p/order/index.html',
      })
        .then(async (res) => {
          //  this.log.debug(JSON.stringify(res.data));
          res.data.indexOf('Session has expired') !== -1
            ? this.log.error('Session has expired')
            : this.log.info('Login to Aliexpress successful');
        })
        .catch(async (error) => {
          error.response && this.log.error(JSON.stringify(error.response.data));
          this.log.error(error);
        });
    } else {
      this.log.info('Login to AliExpress with MFA token');
      this.log.debug('MFA: ' + this.config.dhlMfa);
      await this.requestClient({
        method: 'post',
        url: 'https://www.dhl.de/int-erkennen/2fa',
        headers: {
          Host: 'www.dhl.de',
          'content-type': 'application/json',
          accept: '*/*',
          'x-requested-with': 'XMLHttpRequest',
          'accept-language': 'de-de',
          origin: 'https://www.dhl.de',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        },

        data: JSON.stringify({
          value: this.config.dhlMfa,
          remember2fa: true,
          language: 'de',
          context: 'app',
          meta: '',
          intermediateMfaToken: mfaToken,
        }),
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.log.info('Login to DHL successful');
          this.sessions['dhl'] = res.data;
          this.setState('info.connection', true, true);
          this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
          await this.createDHLStates();
        })
        .catch(async (error) => {
          this.log.error(error);
          if (error.response) {
            this.setState('info.connection', false, true);
            this.log.error(JSON.stringify(error.response.data));
            const adapterConfig = 'system.adapter.' + this.name + '.' + this.instance;
            this.log.error('MFA incorrect');
            this.getForeignObject(adapterConfig, (error, obj) => {
              if (obj && obj.native && obj.native.dhlMfa) {
                obj.native.dhlMfa = '';
                this.setForeignObject(adapterConfig, obj);
              }
            });
            return;
          }
        });
    }
  }

  async loginAmz() {
    await this.setObjectNotExistsAsync('amazon', {
      type: 'device',
      common: {
        name: 'Amazon Tracking',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('amazon.json', {
      type: 'state',
      common: {
        name: 'Json Sendungen',
        write: false,
        read: true,
        type: 'string',
        role: 'json',
      },
      native: {},
    });
    let body = await this.requestClient({
      method: 'get',
      url: 'https://www.amazon.de/ap/signin?_encoding=UTF8&accountStatusPolicy=P1&openid.assoc_handle=deflex&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fgp%2Fcss%2Forder-history%3Fie%3DUTF8%26ref_%3Dnav_orders_first&pageId=webcs-yourorder&showRmrMe=1',
      headers: {
        accept: '*/*',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'accept-language': 'de-de',
      },
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error('Amazon first login step failed');
        this.log.error(
          'https://www.amazon.de/ap/signin?_encoding=UTF8&accountStatusPolicy=P1&openid.assoc_handle=deflex&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fgp%2Fcss%2Forder-history%3Fie%3DUTF8%26ref_%3Dnav_orders_first&pageId=webcs-yourorder&showRmrMe=1',
        );
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    let form = this.extractHidden(body);
    if (form.email !== this.config.amzusername) {
      form.email = this.config.amzusername;
      body = await this.requestClient({
        method: 'post',
        url: 'https://www.amazon.de/ap/signin',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://www.amazon.de',
          'accept-language': 'de-de',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
          referer: 'https://www.amazon.de/ap/signin',
        },
        data: qs.stringify(form),
        jar: this.cookieJar,
        withCredentials: true,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          return res.data;
        })
        .catch((error) => {
          this.log.error('Failed to post with username load https://www.amazon.de/ap/signin');
          this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
          }
          this.log.info(
            'Delete amazon cookie please restart the adapter to trigger relogin. If this is not working please manualy delete parcel.0.auth.cookie',
          );
          delete this.cookieJar.store.idx['amazon.de'];
        });
      form = this.extractHidden(body);
    }
    form.password = this.config.amzpassword;
    form.rememberMe = 'true';
    await this.requestClient({
      method: 'post',
      url: 'https://www.amazon.de/ap/signin',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://www.amazon.de',
        'accept-language': 'de-de',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        referer: 'https://www.amazon.de/ap/signin',
      },
      data: qs.stringify(form),
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.indexOf('js-yo-main-content') !== -1) {
          this.log.info('Login to Amazon successful');
          this.sessions['amz'] = true;
          this.setState('info.connection', true, true);
          this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);

          return;
        }
        if (res.data.indexOf('auth-mfa-otpcode') !== -1) {
          this.log.info('Found MFA token login');
          const form = this.extractHidden(res.data);
          form.otpCode = this.config.amzotp;
          form.rememberDevice = true;

          await this.requestClient({
            method: 'post',
            url: 'https://www.amazon.de/ap/signin',
            headers: {
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'content-type': 'application/x-www-form-urlencoded',
              origin: 'https://www.amazon.de',
              'accept-language': 'de-de',
              'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
              referer: 'https://www.amazon.de/ap/signin',
            },
            data: qs.stringify(form),
            jar: this.cookieJar,
            withCredentials: true,
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
              if (res.data.indexOf('js-yo-main-content') !== -1) {
                this.log.info('Login to Amazon successful');
                this.sessions['amz'] = true;
                this.setState('info.connection', true, true);
                this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
                await this.setObjectNotExistsAsync('amazon', {
                  type: 'device',
                  common: {
                    name: 'Amazon Tracking',
                  },
                  native: {},
                });
                return;
              }
              this.log.error('MFA: Login to Amazon failed, please login manually to Amazon');
              this.setState('info.connection', false, true);
            })
            .catch(async (error) => {
              this.log.error('MFA: Failed to post https://www.amazon.de/ap/signin');
              if (error.response) {
                this.setState('info.connection', false, true);
                this.log.error(JSON.stringify(error.response.data));
              }

              this.log.error(error);
            });
          return;
        }
        if (res.data.indexOf('Amazon Anmelden') !== -1) {
          this.log.error('Login to Amazon failed, please login to Amazon manually and check the login');
          if (res.data.indexOf('captcha-placeholder') !== -1) {
            this.log.warn(
              'Captcha required. Please login into your account to check the state of the account. If this is not wokring please pause the adapter for 24h.',
            );
          }
          this.log.info(
            'Amazon cookie are removed. Please restart the adapter to trigger a relogin. If this is not working please manually delete parcel.0.auth.cookie',
          );
          delete this.cookieJar.store.idx['amazon.de'];
          this.log.info('Start relogin');
          await this.loginAmz();

          return;
        }
        if (res.data.indexOf('Zurücksetzen des Passworts erforderlich') !== -1) {
          this.log.error('Zurücksetzen des Passworts erforderlich');
          return;
        }
        this.log.error('Unknown Error: Login to Amazon failed, please login to Amazon and check your credentials');
        this.setState('info.connection', false, true);
        return;
      })
      .catch(async (error) => {
        this.log.error('Failed to post with password to https://www.amazon.de/ap/signin');
        if (error.response) {
          this.setState('info.connection', false, true);
          this.log.error(JSON.stringify(error.response.data));
        }

        this.log.error(error);
      });
  }
  async loginDPD(silent) {
    await this.requestClient({
      method: 'get',
      url: 'https://my.dpd.de/logout.aspx',
      jar: this.cookieJar,
      withCredentials: true,
    }).catch(async (error) => {
      error.response && this.log.error(JSON.stringify(error.response.data));
      this.log.error(error);
    });
    await this.requestClient({
      method: 'post',
      url: 'https://www.dpd.com/de/de/mydpd-anmelden-und-registrieren/',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.66 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'accept-language': 'de,en;q=0.9',
      },
      data: qs.stringify({
        dpg_username: this.config.dpdusername,
        dpg_password: this.config.dpdpassword,
      }),
      jar: this.cookieJar,
      withCredentials: true,
      maxRedirects: 0,
    })
      .then(async (res) => {
        if (res.data && res.data.indexOf('Login fehlgeschlagen') !== -1) {
          this.log.error('Login to DPD failed, please check username and password');
          return;
        }
      })
      .catch(async (error) => {
        if (error.response) {
          if (error.response.status === 302) {
            this.dpdToken = error.response.headers.location.split('=')[1];
            !silent && this.log.info('Login to DPD successful');
            this.sessions['dpd'] = true;
            await this.setObjectNotExistsAsync('dpd', {
              type: 'device',
              common: {
                name: 'DPD Tracking',
              },
              native: {},
            });
            await this.setObjectNotExistsAsync('dpd.json', {
              type: 'state',
              common: {
                name: 'Json Sendungen',
                write: false,
                read: true,
                type: 'string',
                role: 'json',
              },
              native: {},
            });
            this.setState('info.connection', true, true);
            this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
            return;
          }

          this.log.error(error);
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    await this.requestClient({
      method: 'get',
      url: 'https://my.dpd.de/myParcel.aspx?dpd_token=' + this.dpdToken,
      jar: this.cookieJar,
      withCredentials: true,
    }).catch(async (error) => {
      error.response && this.log.error(JSON.stringify(error.response.data));
      this.log.error(error);
    });
  }
  async loginGLS(silent) {
    await this.requestClient({
      method: 'post',
      url: 'https://gls-one.de/api/auth',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Selected-Country': 'DE',
        'Accept-Language': 'de-de',
        'X-Selected-Language': 'DE',
        'Content-Type': 'application/json',
        Origin: 'https://www.gls-one.de',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GLS_App.iOS/v1.3.1',
        'X-Client-Id': 'iOS',
        Referer: 'https://www.gls-one.de/de?platform=iOS',
      },
      data: JSON.stringify({
        username: this.config.glsusername,
        password: this.config.glspassword,
      }),
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.sessions['gls'] = res.data;
        if (!res.data.token) {
          this.log.error(res.data);
        }
        this.glstoken = res.data.token;
      })
      .catch(async (error) => {
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(error);
      });
    if (!this.glstoken) {
      return;
    }
    await this.requestClient({
      method: 'get',
      url: 'https://gls-one.de/api/auth/login',
      headers: {
        'X-Selected-Country': 'DE',
        'Accept-Language': 'de-de',
        'X-Selected-Language': 'DE',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'X-Client-Id': 'iOS',
        'X-Auth-Token': this.glstoken,
      },
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        !silent && this.log.info('Login to GLS successful');
        this.glsid = res.data._id;
        await this.setObjectNotExistsAsync('gls', {
          type: 'device',
          common: {
            name: 'GLS Tracking',
          },
          native: {},
        });
        await this.setObjectNotExistsAsync('gls.json', {
          type: 'state',
          common: {
            name: 'Json Sendungen',
            write: false,
            read: true,
            type: 'string',
            role: 'json',
          },
          native: {},
        });
        this.setState('info.connection', true, true);
        this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
      })
      .catch(async (error) => {
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(error);
      });
  }
  async loginHermes() {
    await this.requestClient({
      method: 'post',
      url: 'https://mobile-app-api.a0930.prd.hc.de/api/v12/users/login',
      headers: {
        accept: 'application/json',
        'api-key': 'acefe97f-89fc-4f4e-9543-fc6b90f68928',
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'Hermes - ios - 12.1.1 (2689)',
        'accept-language': 'de-de',
      },
      data: { username: this.config.hermesusername, password: this.config.hermespassword },

      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.accessToken) {
          this.hermesAuthToken = res.data.accessToken;
          this.sessions['hermes'] = res.data;
          this.log.info('Login to Hermes successful');
          await this.setObjectNotExistsAsync('hermes', {
            type: 'device',
            common: {
              name: 'Hermes Tracking',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync('hermes.json', {
            type: 'state',
            common: {
              name: 'Json Sendungen',
              write: false,
              read: true,
              type: 'string',
              role: 'json',
            },
            native: {},
          });
          this.setState('info.connection', true, true);
        } else {
          this.log.error('Login to Hermes failed');
          this.log.error(JSON.stringify(res.data));
        }

        return;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async loginUPS(silent) {
    await this.requestClient({
      method: 'post',
      url: 'https://onlinetools.ups.com/rest/Login',
      headers: {
        Connection: 'keep-alive',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Host: 'onlinetools.ups.com',
      },
      data: JSON.stringify({
        UPSSecurity: {
          UsernameToken: {},
          ServiceAccessToken: {
            AccessLicenseNumber: '3DE112BAD1F163E0',
          },
        },
        LoginSubmitUserIdRequest: {
          UserId: this.config.upsusername,
          Password: this.config.upspassword,
          Locale: 'de_DE',
          ClientID: 'native',
          IsMobile: 'true',
        },
      }),
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (
          res.data.LoginSubmitUserIdResponse &&
          res.data.LoginSubmitUserIdResponse.LoginResponse &&
          res.data.LoginSubmitUserIdResponse.LoginResponse.AuthenticationToken
        ) {
          this.upsAuthToken = res.data.LoginSubmitUserIdResponse.LoginResponse.AuthenticationToken;

          this.sessions['ups'] = res.data;
          !silent && this.log.info('Login to UPS successful');
          await this.setObjectNotExistsAsync('ups', {
            type: 'device',
            common: {
              name: 'UPS Tracking',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync('ups.json', {
            type: 'state',
            common: {
              name: 'Json Sendungen',
              write: false,
              read: true,
              type: 'string',
              role: 'json',
            },
            native: {},
          });
          this.setState('info.connection', true, true);
          this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
        } else {
          this.log.warn('Login to UPS failed');
          this.log.info(JSON.stringify(res.data));
          if (JSON.stringify(res.data).includes('Legal Agreement Required')) {
            this.log.warn('Please login into UPS and accept the Legal Agreement');
          }
        }

        return;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!this.upsAuthToken) {
      return;
    }
    await this.requestClient({
      method: 'post',
      url: 'https://onlinetools.ups.com/rest/MCEnrollment',
      headers: {
        Connection: 'keep-alive',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        UPSSecurity: {
          UsernameToken: {
            AuthenticationToken: this.upsAuthToken,
          },
          ServiceAccessToken: {
            AccessLicenseNumber: '2DBACFA7974B3252',
          },
        },
        GetEnrollmentsRequest: {
          Request: {
            RequestOption: ['00'],
            TransactionReference: {},
          },
          Locale: {
            Language: 'de',
            Country: 'DE',
          },
        },
      }),
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (
          res.data.GetEnrollmentsResponse &&
          res.data.GetEnrollmentsResponse.MYCEnrollmentSummaries &&
          res.data.GetEnrollmentsResponse.MYCEnrollmentSummaries.MYCEnrollmentSummary &&
          res.data.GetEnrollmentsResponse.MYCEnrollmentSummaries.MYCEnrollmentSummary.AddressToken
        ) {
          this.upsAddressToken = res.data.GetEnrollmentsResponse.MYCEnrollmentSummaries.MYCEnrollmentSummary.AddressToken;
        } else {
          this.log.warn('No UPS address found. Please activate UPS My Choice in the UPS App');
          this.log.info(JSON.stringify(res.data));
        }
      })
      .catch(async (error) => {
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(error);
      });
  }
  async login17TApi() {
    await this.setObjectNotExistsAsync('17t', {
      type: 'device',
      common: {
        name: '17Track API Tracking',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('17t.trackinginfo', {
      type: 'channel',
      common: {
        name: '17Track Tracking Info',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('17t.trackinginfo.json', {
      type: 'state',
      common: {
        name: 'Json Sendungen',
        write: false,
        read: true,
        type: 'string',
        role: 'json',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('17t.register', {
      type: 'state',
      common: {
        name: 'Register Tracking ID',
        write: true,
        read: true,
        type: 'mixed',
        role: 'state',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('17t.trackList', {
      type: 'state',
      common: {
        role: 'state',
        name: 'Registered tracking ids',
        type: 'object',
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('17t.deleteTrack', {
      type: 'state',
      common: {
        role: 'state',
        name: 'Unregister a tracking id',
        type: 'mixed',
        read: true,
        write: true,
      },
      native: {},
    });
  }
  async login17T(silent) {
    await this.requestClient({
      method: 'post',
      url: 'https://user.17track.net/userapi/call',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'accept-language': 'de,en;q=0.9',
      },
      data:
        '{"version":"1.0","method":"Signin","param":{"Email":"' +
        this.config.t17username +
        '","Password":"' +
        this.config.t17password +
        '","CaptchaCode":""},"sourcetype":0,"timeZoneOffset":-60}',
      jar: this.cookieJar,
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.Message) {
          this.log.error('Login to 17TUser failed. Login via Google is not working');
          this.log.error('T17User: ' + res.data.Message);
          return;
        }
        !silent && this.log.info('Login to T17 User successful');
        this.sessions['17tuser'] = true;
        await this.setObjectNotExistsAsync('17tuser', {
          type: 'device',
          common: {
            name: '17Track User Tracking',
          },
          native: {},
        });
        await this.setObjectNotExistsAsync('17tuser.trackinginfo.json', {
          type: 'state',
          common: {
            name: 'Json Sendungen',
            write: false,
            read: true,
            type: 'string',
            role: 'json',
          },
          native: {},
        });
        await this.setObjectNotExistsAsync('17tuser.register', {
          type: 'state',
          common: {
            name: 'Register Tracking ID',
            write: true,
            read: true,
            type: 'mixed',
            role: 'state',
          },
          native: {},
        });
        this.setState('info.connection', true, true);
        this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
        return;
      })
      .catch(async (error) => {
        if (error.response) {
          this.log.error(error);
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async updateProvider() {
    let data17Track = {};
    let dataDhl = [];
    this.mergedJson = [];
    this.mergedJsonObject = {};
    this.inDelivery = [];
    if (this.sessions['17track']) {
      try {
        const trackList = await this.getStateAsync('17t.trackList');
        if (trackList && trackList.val) {
          if (!trackList.val.map) {
            trackList.val = JSON.parse(trackList.val);
          }
          data17Track = trackList.val.map((track) => {
            return { number: track };
          });
        }
      } catch (error) {
        this.log.error(error);
      }
    }
    if (this.sessions['dhl']) {
      dataDhl = await this.requestClient({
        method: 'get',
        url: 'https://www.dhl.de/int-verfolgen/data/search?noRedirect=true&language=de&cid=app',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
          'accept-language': 'de-de',
        },
      })

        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (res.data && res.data.sendungen) {
            return res.data.sendungen.map((sendung) => {
              if (sendung.sendungsinfo.sendungsliste !== 'ARCHIVIERT') {
                return sendung.id;
              }
            });
          }
          return [];
        })
        .catch((error) => {
          this.log.error('Failed to get https://www.dhl.de/int-verfolgen/data/search?noRedirect=true&language=de&cid=app');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
          return [];
        });
    }
    if (this.sessions['amz']) {
      await this.getAmazonPackages();
    }
    const statusArrays = {
      dhl: [
        {
          path: 'dhl',
          url: 'https://www.dhl.de/int-verfolgen/data/search?piececode=' + dataDhl + '&noRedirect=true&language=de&cid=app',
          header: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
            'accept-language': 'de-de',
          },
        },
        {
          path: 'dhl.briefe',
          url: 'https://www.dhl.de/int-aviseanzeigen/advices?width=414',
          header: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
            'accept-language': 'de-de',
          },
        },
      ],
      '17track': [
        {
          method: 'post',
          path: '17t.trackinginfo',
          url: 'https://api.17track.net/track/v1/gettrackinfo',
          header: {
            '17token': this.config['17trackKey'],
            'Content-Type': 'application/json',
          },
          data: JSON.stringify(data17Track),
        },
      ],
      '17tuser': [
        {
          method: 'post',
          path: '17tuser.trackinginfo',
          url: 'https://buyer.17track.net/orderapi/call',
          data: '{"version":"1.0","timeZoneOffset":-60,"method":"GetTrackInfoList","param":{"ob":"1","Page":1,"IsArchived":false}}',
          header: { 'content-type': 'application/x-www-form-urlencoded' },
        },
      ],
      amz: [],
      dpd: [
        {
          path: 'dpd',
          url: 'https://my.dpd.de/myParcel.aspx', //?dpd_token=" + this.dpdToken,
          header: {
            accept: '*/*',
            'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.45 Safari/537.36',
            'accept-language': 'de-de',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Expires: '0',
          },
        },
      ],
      gls: [
        {
          path: 'gls',
          url: 'https://gls-one.de/api/v3/customers/' + this.glsid + '/parcels?page=0&sort=createdDate,DESC',
          header: {
            accept: '*/*',
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
            'accept-language': 'de-de',
            'X-Auth-Token': this.glstoken,
          },
        },
      ],
      hermes: [
        {
          path: 'hermes',
          url: 'https://mobile-app-api.a0930.prd.hc.de/api/v12/shipments',
          header: {
            accept: 'application/json',
            'api-key': 'acefe97f-89fc-4f4e-9543-fc6b90f68928',
            'user-agent': 'Hermes - ios - 12.1.1 (2689)',
            'accept-language': 'de-de',
            authorization: 'Bearer ' + this.hermesAuthToken,
          },
        },
      ],
      ups: [
        {
          path: 'ups',
          method: 'post',
          url: 'https://onlinetools.ups.com/mychoice/v1/shipments/details/AddressToken?loc=de_DE',
          header: {
            Connection: 'keep-alive',
            Accept: 'application/json',
            AccessLicenseNumber: '2DBACFA7974B3252',
            AuthenticationToken: this.upsAuthToken,
            addresstoken: this.upsAddressToken,
            transID: uuidv4().substring(0, 25),
            transactionSrc: 'MOBILE',
            'Content-Type': 'application/json',
          },
          data: JSON.stringify({
            parcelCount: '10',
            disableFeature: '',
          }),
        },
      ],
    };

    for (const id of Object.keys(this.sessions)) {
      for (const element of statusArrays[id]) {
        this.log.debug(element.url);
        if (this.ignoredPath.includes(element.path)) {
          this.log.debug('Ignore: ' + element.path);
          continue;
        }
        await this.requestClient({
          method: element.method ? element.method : 'get',
          url: element.url,
          headers: element.header,

          data: element.data,
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            if (id === '17track') {
              data = res.data.data;
            }
            if (id === '17tuser') {
              data = res.data.Json;
            }
            if (id === 'gls') {
              const parcels = res.data._embedded ? res.data._embedded.parcels : res.data.parcels;
              for (const parcel of parcels) {
                parcel.id = parcel._id.toString();
                delete parcel._id;
              }
              data = { sendungen: parcels };
            }
            if (id === 'ups') {
              for (const parcel of res.data.response.shipments) {
                parcel.id = parcel.trackingNumber;
              }
              data = { sendungen: res.data.response.shipments };
            }
            if (id === 'hermes') {
              try {
                if (res.data) {
                  if (typeof res.data === 'string') {
                    res.data = JSON.parse(res.data);
                  }
                  for (const parcel of res.data) {
                    parcel.id = parcel.shipmentId || parcel.externalId;
                  }
                  data = { sendungen: res.data };
                }
              } catch (error) {
                this.log.warn('Hermes response incomplete cannot parse result');
                this.log.debug(res.data);
                data = { sendungen: [] };
              }
            }
            const forceIndex = true;
            const preferedArrayName = null;
            if (id === 'dpd') {
              data = this.convertDomToJson(data);
            }
            //filter archive message
            if (id === 'dhl' && data.sendungen) {
              const trackingList = [];
              data.sendungen = data.sendungen.filter((sendung) => {
                trackingList.push(sendung.id);
                return sendung.sendungsinfo.sendungsliste !== 'ARCHIVIERT';
              });
            }
            //activate briefe token
            if (element.path === 'dhl.briefe' && res.data.grantToken) {
              await this.activateToken(res.data.grantToken, res.data.accessTokenUrl);
              await this.sleep(1000);
            }
            if (data) {
              await this.cleanupProvider(id, data);
              this.mergeProviderJson(id, data);
              this.json2iob.parse(element.path, data, {
                forceIndex: forceIndex,
                preferedArrayName: preferedArrayName,
                dontSaveCreatedObjects: true,
              });
              data && this.setState(element.path + '.json', JSON.stringify(data), true);
            }
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401 && id !== '17track') {
                if (element.path === 'dhl.briefe') {
                  this.log.debug(error);
                  return;
                }

                error.response && this.log.debug(JSON.stringify(error.response.data));

                this.log.info(element.path + ' receive 401 error. Refresh Token in 60 seconds');
                if (!this.refreshTokenTimeout) {
                  this.refreshTokenTimeout = setTimeout(() => {
                    this.refreshTokenTimeout = null;
                    this.refreshToken();
                  }, 1000 * 60);
                }
                return;
              }
              if (element.path === 'dhl.briefe') {
                this.log.info('Briefankündigung is not working. Stopped until restart');
                this.ignoredPath.push(element.path);
              }
            }
            this.log.error(element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
    this.log.debug('Write states');
    this.setState('allProviderJson', JSON.stringify(this.mergedJson), true);
    this.setState('allProviderObjects', JSON.stringify(this.mergedJsonObject), true);
    this.setState('inDelivery', JSON.stringify(this.inDelivery), true);
    this.setState('inDeliveryCount', this.inDelivery.length, true);
  }
  async cleanupProvider(id, data) {
    if (id === 'dhl' && data.hasOwnProperty('grantToken')) {
      await this.delObjectAsync('dhl.briefe', { recursive: true });
      await this.setObjectNotExistsAsync('dhl.briefe.json', {
        type: 'state',
        common: {
          name: 'Json Briefe',
          write: false,
          read: true,
          type: 'string',
          role: 'json',
        },
        native: {},
      });
    }
    if ((id === 'dhl' || id === 'dpd' || id === 'amz' || id === 'gls' || id === 'ups' || id === 'hermes') && data && data.sendungen) {
      const states = await this.getStatesAsync(id + '.sendungen*.id');
      const sendungsArray = data.sendungen.map((sendung) => {
        return sendung.id;
      });
      for (const sendungsIdKey in states) {
        const index = Object.keys(states).indexOf(sendungsIdKey);
        if (states[sendungsIdKey]) {
          const sendungsId = states[sendungsIdKey].val;
          if (sendungsArray[index] !== sendungsId) {
            const idArray = sendungsIdKey.split('.');
            idArray.pop();
            this.log.debug('deleting ' + sendungsIdKey);
            await this.delObjectAsync(idArray.join('.'), { recursive: true });
          }
        }
      }
    }
  }
  async mergeProviderJson(id, data) {
    this.log.debug(id + ' merge provider json');
    if (id === 'dhl' && data.sendungen) {
      const sendungsArray = data.sendungen.map((sendung) => {
        let status = '';

        if (sendung.sendungsdetails && sendung.sendungsdetails.sendungsverlauf && sendung.sendungsdetails.sendungsverlauf.kurzStatus) {
          status = sendung.sendungsdetails.sendungsverlauf.kurzStatus;
        }
        if (sendung.sendungsdetails && sendung.sendungsdetails.liveTrackingVerfuegbar && sendung.sendungsdetails.liveTracking) {
          status = status + ' ' + sendung.sendungsdetails.liveTracking.countdown + ' Stopps';
        }
        if (status === '') {
          return;
        }
        const name = sendung.sendungsinfo.sendungsname || 'Unbekannt';

        const sendungsObject = { id: sendung.id, name: name, status: status, source: 'DHL' };

        sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
        if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
          sendungsObject.inDelivery = true;
          this.inDelivery.push(sendungsObject);
        }
        sendungsObject.direction = sendung.sendungsinfo.sendungsrichtung;
        this.mergedJsonObject[sendung.id] = sendungsObject;
        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === 'gls' && data.sendungen) {
      const sendungsArray = data.sendungen.map((sendung) => {
        const sendungsObject = {
          id: sendung.id,
          name: sendung.label || sendung.parcelNumber,
          status: sendung.status,
          source: 'GLS',
          direction: sendung.type,
        };

        sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
        if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
          sendungsObject.inDelivery = true;
          this.inDelivery.push(sendungsObject);
        }
        this.mergedJsonObject[sendung.id] = sendungsObject;
        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === 'ups' && data.sendungen) {
      const sendungsArray = data.sendungen.map((sendung) => {
        const sendungsObject = {
          id: sendung.id,
          name: sendung.shipFromName,
          status: sendung.locStatus || sendung.status,
          source: 'UPS',
        };

        sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
        if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
          sendungsObject.inDelivery = true;
          this.inDelivery.push(sendungsObject);
        }
        this.mergedJsonObject[sendung.id] = sendungsObject;

        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === 'hermes' && data.sendungen) {
      try {
        const sendungsArray = data.sendungen.map((sendung) => {
          let name = sendung.description;
          if (sendung.sender && sendung.sender.lastname) {
            name = name + ' ' + sendung.sender.lastname;
          }
          const sendungsObject = {
            id: sendung.id,
            name: name,
            status: sendung.status.text.longText || '',
            source: 'Hermes',
          };

          sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
          if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
            sendungsObject.inDelivery = true;
            this.inDelivery.push(sendungsObject);
          }
          this.mergedJsonObject[sendung.id] = sendungsObject;

          return sendungsObject;
        });
        this.mergedJson = this.mergedJson.concat(sendungsArray);
      } catch (error) {
        this.log.info('Hermes response incomplete cannot parse result');
        this.log.info(error);
      }
    }

    if (id === 'dpd' && data && data.sendungen) {
      const sendungsArray = data.sendungen.map((sendung) => {
        const sendungsObject = {
          id: sendung.id,
          name: sendung.name,
          status: sendung.status || '',
          source: 'DPD',
        };

        sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
        if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
          sendungsObject.inDelivery = true;
          this.inDelivery.push(sendungsObject);
        }
        this.mergedJsonObject[sendung.id] = sendungsObject;

        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === 'amz' && data && data.sendungen) {
      const sendungsArray = data.sendungen.map((sendung) => {
        const sendungsObject = { id: sendung.id, name: sendung.name, status: sendung.status, source: 'AMZ' };

        sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
        if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
          sendungsObject.inDelivery = true;
          this.inDelivery.push(sendungsObject);
        }
        this.mergedJsonObject[sendung.id] = sendungsObject;

        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === '17track' && data.accepted) {
      const sendungsArray = data.accepted.map((sendung) => {
        const sendungsObject = {
          id: sendung.number,
          name: sendung.number,
          status: sendung.track.z0 ? sendung.track.z0.z : '',
          source: '17track',
        };
        if (!this.mergedJsonObject[sendung.id]) {
          sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
          if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
            sendungsObject.inDelivery = true;
            this.inDelivery.push(sendungsObject);
          }

          this.mergedJsonObject[sendung.id] = sendungsObject;
        }
        return sendungsObject;
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }
    if (id === '17tuser' && data) {
      const sendungsArray = data.map((sendung) => {
        try {
          if (sendung.FLastEvent) {
            sendung.FLastEvent = JSON.parse(sendung.FLastEvent);
          }
          const sendungsObject = {
            id: sendung.FTrackNo,
            name: sendung.FTrackInfoId,
            status: sendung.FLastEvent ? sendung.FLastEvent.z : '',
            source: '17tuser',
          };
          if (!this.mergedJsonObject[sendung.id]) {
            sendungsObject.delivery_status = this.deliveryStatusCheck(sendung, id, sendungsObject);
            if (sendungsObject.delivery_status === this.delivery_status.OUT_FOR_DELIVERY) {
              sendungsObject.inDelivery = true;
              this.inDelivery.push(sendungsObject);
            }

            this.mergedJsonObject[sendung.id] = sendungsObject;
          }
          return sendungsObject;
        } catch (error) {
          this.log.error(error);
        }
      });
      this.mergedJson = this.mergedJson.concat(sendungsArray);
    }

    if (this.config.sendToActive) {
      const sendungen = this.mergedJsonObject;
      const ids = Object.keys(sendungen);
      for (const id of ids) {
        if (this.alreadySentMessages[id + sendungen[id].source] === sendungen[id].status) {
          continue;
        }

        this.alreadySentMessages[id + sendungen[id].source] = sendungen[id].status;
        if (this.config.noFirstStartSend && this.firstStart) {
          continue;
        }
        const sendInstances = this.config.sendToInstance.replace(/ /g, '').split(',');
        const sendUser = this.config.sendToUser.replace(/ /g, '').split(',');
        for (const sendInstance of sendInstances) {
          const text = '📦 ' + sendungen[id].source + ' ' + sendungen[id].name + '\n' + sendungen[id].status;
          if (sendUser.length > 0) {
            for (const user of sendUser) {
              if (sendInstance.includes('pushover')) {
                await this.sendToAsync(sendInstance, {
                  device: user,
                  message: text,
                  title: 'Paketstatus',
                });
              } else if (sendInstance.includes('signal-cmb')) {
                await this.sendToAsync(sendInstance, 'send', {
                  text: text,
                  phone: user,
                });
              } else {
                await this.sendToAsync(sendInstance, { user: user, text: text });
              }
            }
          } else {
            if (sendInstance.includes('pushover')) {
              await this.sendToAsync(sendInstance, { message: text, title: 'Paketstatus' });
            } else if (sendInstance.includes('signal-cmb')) {
              await this.sendToAsync(sendInstance, 'send', {
                text: text,
              });
            } else {
              await this.sendToAsync(sendInstance, text);
            }
          }
        }
      }
    }
  }
  inDeliveryCheck(sendungsObject) {
    if (!sendungsObject.status) {
      return false;
    }
    if (
      sendungsObject.status.toLocaleLowerCase().includes('in zustellung') ||
      sendungsObject.status.toLocaleLowerCase().includes('zustellung heute') ||
      //sendungsObject.status.toLocaleLowerCase().includes("heute zugestell") ||
      sendungsObject.status.toLocaleLowerCase().includes('wird zugestellt') ||
      sendungsObject.status.toLocaleLowerCase().includes('zustellfahrzeug')
    ) {
      if (this.deliveredCheck(sendungsObject)) {
        return false;
      }
      return true;
    }
    return false;
  }
  deliveredCheck(sendungsObject) {
    if (!sendungsObject.status) {
      return false;
    }
    if (
      sendungsObject.status.toLocaleLowerCase().includes('geliefert heute') ||
      sendungsObject.status.toLocaleLowerCase().includes('geliefert. heute zugestellt') ||
      sendungsObject.status.toLocaleLowerCase().includes('unterschrieben von') ||
      sendungsObject.status.toLocaleLowerCase().includes('hausbewohner übergeben') ||
      sendungsObject.status.toLocaleLowerCase().includes('zustellung erfolgreich') ||
      sendungsObject.status.toLocaleLowerCase().includes('paket zugestellt')
    ) {
      return true;
    }
    return false;
  }
  deliveryStatusCheck(sendung, id, sendungsObject) {
    try {
      if (sendung) {
        if (
          id === 'dhl' &&
          sendung.sendungsdetails &&
          sendung.sendungsdetails.sendungsverlauf &&
          sendung.sendungsdetails.sendungsverlauf.fortschritt
        ) {
          const dhl_status = {
            0: this.delivery_status.REGISTERED,
            1: this.delivery_status.REGISTERED,
            2: this.delivery_status.IN_PREPARATION,
            3: this.delivery_status.IN_TRANSIT,
            4: this.delivery_status.OUT_FOR_DELIVERY,
            5: this.delivery_status.DELIVERED,
          };
          if (dhl_status[sendung.sendungsdetails.sendungsverlauf.fortschritt] !== undefined) {
            return dhl_status[sendung.sendungsdetails.sendungsverlauf.fortschritt];
          }
        }
        if (id === 'hermes' && sendung.status) {
          const hermes_status = {
            AM_PKS_ABGEGEBEN: this.delivery_status.REGISTERED,
            1: this.delivery_status.REGISTERED,
            PAKETSHOP_AN_FAHRER_UEBERGEBEN: this.delivery_status.IN_PREPARATION,
            UNTERWEGS: this.delivery_status.IN_TRANSIT,
            ZUSTELLTOUR: this.delivery_status.OUT_FOR_DELIVERY,
            ZUGESTELLT: this.delivery_status.DELIVERED,
          };
          if (hermes_status[sendung.status.parcelStatus] !== undefined) {
            return hermes_status[sendung.status.parcelStatus];
          }
          // if (hermes_status[sendung.status.parcelStatus] !== undefined) {
          //   return hermes_status[sendung.status.parcelStatus];
          // }
        }
        if (id === 'dpd' && sendung.statusId) {
          const dpd_status = {
            0: this.delivery_status.REGISTERED,
            1: this.delivery_status.IN_PREPARATION,
            2: this.delivery_status.IN_TRANSIT,
            3: this.delivery_status.IN_TRANSIT,
            4: this.delivery_status.OUT_FOR_DELIVERY,
            5: this.delivery_status.OUT_FOR_DELIVERY,
            6: this.delivery_status.DELIVERED,
          };
          if (dpd_status[sendung.statusId] !== undefined) {
            return dpd_status[sendung.statusId];
          }
        }
        if (id === 'gls' && sendung.status) {
          const gls_status = {
            PREADVICE: this.delivery_status.REGISTERED,
            1: this.delivery_status.REGISTERED,
            INWAREHOUSE: this.delivery_status.IN_TRANSIT,
            INTRANSIT: this.delivery_status.IN_TRANSIT,
            INDELIVERY: this.delivery_status.OUT_FOR_DELIVERY,
            DELIVERED: this.delivery_status.DELIVERED,
            DELIVEREDPS: this.delivery_status.DELIVERED,
          };
          if (gls_status[sendung.status] !== undefined) {
            return gls_status[sendung.status];
          }
        }
        if (id === 'amz' && sendung.detailedState && sendung.detailedState.shortStatus) {
          const amz_status = {
            ORDER_PLACED: this.delivery_status.REGISTERED, //ORDERED
            SHIPPING_SOON: this.delivery_status.IN_PREPARATION,
            IN_TRANSIT: this.delivery_status.IN_TRANSIT,
            OUT_FOR_DELIVERY: this.delivery_status.OUT_FOR_DELIVERY,
            DELIVERED: this.delivery_status.DELIVERED,
            PICKED_UP: this.delivery_status.DELIVERED,
          };
          if (amz_status[sendung.detailedState.shortStatus] !== undefined) {
            return amz_status[sendung.detailedState.shortStatus];
          }
        }
      }
      if (sendungsObject) {
        if (this.inDeliveryCheck(sendungsObject)) {
          return this.delivery_status.OUT_FOR_DELIVERY;
        }
        if (this.deliveredCheck(sendungsObject)) {
          return this.delivery_status.DELIVERED;
        }
      }

      return this.delivery_status.UNKNOWN;
    } catch (error) {
      this.log.error(error);
      return this.delivery_status['ERROR'];
    }
  }

  async activateToken(grant_token, url) {
    await this.requestClient({
      method: 'post',
      url: url,
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        grant_token: grant_token,
      }),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  convertDomToJson(body) {
    const dom = new JSDOM(body);
    const result = { sendungen: [] };
    const parcelList = dom.window.document.querySelector('.parcelList');
    if (!parcelList) {
      this.log.debug('No DPD parcelList found');
      return result;
    }
    this.log.debug('Found DPD Parcel List');
    this.log.debug('Found ' + parcelList.querySelectorAll('.btnSelectParcel').length + ' parcels');
    parcelList.querySelectorAll('.btnSelectParcel').forEach((parcel) => {
      const parcelInfo = parcel.firstElementChild;
      this.log.debug(parcelInfo.textContent);
      let statusId = parcelInfo.querySelector('img').src;
      if (statusId) {
        statusId = statusId.replace('images/status_', '').replace('.svg', '');
      }
      result.sendungen.push({
        id: parcelInfo.querySelector('.parcelNo').textContent,
        name: parcelInfo.querySelector('.parcelName').textContent,
        status: parcelInfo.querySelector('.parcelDeliveryStatus').textContent,
        statusId: statusId,
      });
    });
    return result;
  }
  async getAmazonPackages() {
    this.log.debug('Get Amazon Packages');
    const amzResult = { sendungen: [] };

    let orders = await this.getAmazonOrders();
    if (!orders) {
      orders = await this.getAmazonOrders();
    }
    if (!orders) {
      this.log.info('No Amazon orders found');
      return;
    }
    this.log.debug('Found ' + orders.length + ' Amazon Orders');
    if (orders.length === 0) {
      // this.log.debug(res.data);
    }
    for (const order of orders) {
      if (order.url.indexOf('http') === -1) {
        order.url = 'https://www.amazon.de' + order.url;
      }
      this.log.debug(order.url);
      order.url = order.url + '&disableCsd=missing-library';
      const element = await this.requestClient({
        method: 'get',
        url: order.url,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'de-de',
        },
      })
        .then(async (res) => {
          // this.log.debug(JSON.stringify(res.data));
          const dom = new JSDOM(res.data);
          const document = dom.window.document;
          const statusHandle =
            document.querySelector('.pt-status-main-status') ||
            document.querySelector('.milestone-primaryMessage.alpha') ||
            document.querySelector('.milestone-primaryMessage') ||
            null;
          let additionalStatus = document.querySelector('#primaryStatus')
            ? document.querySelector('#primaryStatus').textContent.replace(/\n */g, '')
            : '';
          let secondaryStatus = document.querySelector('#secondaryStatus')
            ? document.querySelector('#secondaryStatus').textContent.replace(/\n */g, '')
            : '';
          if (!secondaryStatus) {
            secondaryStatus = document.querySelector('.pt-promise-details-slot')
              ? document.querySelector('.pt-promise-details-slot').textContent.replace(/\n */g, '')
              : '';
          }
          if (!secondaryStatus) {
            secondaryStatus = document.querySelector('.pt-status-secondary-status')
              ? document.querySelector('.pt-status-secondary-status').textContent.replace(/\n */g, '')
              : '';
          }
          if (!additionalStatus) {
            additionalStatus = document.querySelector('.pt-promise-main-slot')
              ? document.querySelector('.pt-promise-main-slot').textContent.replace(/\n */g, '')
              : '';
          }
          let stopsStatus = '';
          let stateObject = {};
          if (document.querySelector(`script[data-a-state='{"key":"page-state"}']`)) {
            try {
              const jsonState = document.querySelector(`script[data-a-state='{"key":"page-state"}']`).textContent;
              stateObject = JSON.parse(jsonState);
              if (stateObject.mapTracking && stateObject.mapTracking.calloutMessage) {
                stopsStatus = stateObject.mapTracking.calloutMessage;
              }
            } catch (error) {
              this.log.error(error);
            }
          }

          let status = statusHandle ? statusHandle.textContent.replace(/\n */g, '') : '';
          if (!status) {
            status = stateObject.promise?.promiseMessage;
          }
          if (!additionalStatus) {
            additionalStatus = stateObject.promise?.pdwHelpIconMessage;
          }
          if (!status) {
            status = additionalStatus;
          }
          if (additionalStatus && status !== additionalStatus) {
            status = status + '. ' + additionalStatus;
          }

          if (secondaryStatus) {
            status = status + '. ' + secondaryStatus;
          }

          if (stopsStatus) {
            status = status + '. ' + stopsStatus;
          }

          return {
            id: document.querySelector('.pt-delivery-card-trackingId')
              ? document.querySelector('.pt-delivery-card-trackingId').textContent.replace('Trackingnummer ', '')
              : '',
            name: document.querySelector('.carrierRelatedInfo-mfn-providerTitle')
              ? document.querySelector('.carrierRelatedInfo-mfn-providerTitle').textContent.replace(/\\n */g, '')
              : '',
            status: status,
            detailedState: stateObject,
          };
        })
        .catch((error) => {
          this.log.error(error);
          if (error.response) {
            this.log.error(JSON.stringify(error.response.data));
          }
        });

      if (element) {
        const orderId = qs.parse(order.url).orderId;
        element.name = order.desc;
        if (!element.name && orderId) {
          element.name = orderId;
        }
        if (!element.id && orderId) {
          element.id = orderId;
        }
        this.log.debug(JSON.stringify(element));
        amzResult.sendungen.push(element);
      }
    }

    this.json2iob.parse('amazon', amzResult, { forceIndex: true });

    this.mergeProviderJson('amz', amzResult);
    await this.setStateAsync('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
    await this.setStateAsync('amazon.json', JSON.stringify(amzResult), true);
  }
  async getAmazonOrders() {
    return await this.requestClient({
      method: 'get',
      url: 'https://www.amazon.de/gp/css/order-history?ref_=nav_orders_first&disableCsd=missing-library',
      headers: {
        authority: 'www.amazon.de',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'de-de',
        'cache-control': 'max-age=0',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'viewport-width': '1272',
      },
    })
      .then(async (res) => {
        // this.log.debug(JSON.stringify(res.data));
        const dom = new JSDOM(res.data);

        if (res.data.includes('auth-workflow')) {
          this.log.debug('Amazon Login required');
          await this.loginAmz();
          return;
        }
        const document = dom.window.document;
        const elements = [];
        const orders = document.querySelectorAll('.order-card.js-order-card');

        for (const order of orders) {
          const descHandle = order.querySelector(
            '.a-fixed-right-grid-col.a-col-left .a-fixed-left-grid-col.a-col-right div:first-child .a-link-normal',
          );
          const desc = descHandle ? descHandle.textContent.replace(/\n */g, '') : '';
          let url = order.querySelector('.track-package-button a')
            ? order.querySelector('.track-package-button a').getAttribute('href')
            : '';
          if (!url) {
            const allLinks = order.querySelectorAll('.a-button-inner a');
            for (const link of allLinks) {
              if (link.textContent.includes('Lieferung verfolgen')) {
                url = link.getAttribute('href');
              }
            }
          }
          if (!url) {
            url = order.querySelector('.yohtmlc-shipment-level-connections .a-button-inner a')
              ? order.querySelector('.yohtmlc-shipment-level-connections .a-button-inner a').getAttribute('href')
              : '';
          }
          if (url) {
            elements.push({ desc: desc, url: url });
          }
        }
        return elements;
      })
      .catch((error) => {
        this.log.error('Failed to get Amazon Orders');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }

  async refreshToken() {
    if (Object.keys(this.sessions).length === 0) {
      this.log.error('No session found relogin');
      return;
    }
    for (const id of Object.keys(this.sessions)) {
      if (id === 'dhl') {
        await this.requestClient({
          method: 'post',
          url: 'https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login/token',
          headers: {
            Host: 'login.dhl.de',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://login.dhl.de',
            Connection: 'keep-alive',
            'User-Agent': 'DHLPaket_PROD/1367 CFNetwork/1240.0.4 Darwin/20.6.0',
            'Accept-Language': 'de-de',
          },
          data: {
            client_id: '83471082-5c13-4fce-8dcb-19d2a3fca413',
            grant_type: 'refresh_token',
            refresh_token: this.sessions['dhl'].refresh_token,
          },
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            this.sessions['dhl'] = res.data;
            await this.cookieJar.setCookie('dhli=' + res.data.id_token + '; path=/; domain=dhl.de', 'https:/dhl.de');
            await this.cookieJar.setCookie('dhli=' + res.data.id_token + '; path=/; domain=www.dhl.de', 'https:/www.dhl.de');
            this.setState('auth.cookie', JSON.stringify(this.cookieJar.toJSON()), true);
            this.setState('info.connection', true, true);
          })
          .catch((error) => {
            this.log.error('refresh token failed');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
            this.log.error('Start relogin in 1min');
            if (!this.reLoginTimeout) {
              this.reLoginTimeout = setTimeout(() => {
                this.reLoginTimeout = null;
                this.loginDHL();
              }, 1000 * 60 * 1);
            }
          });
      }
      if (id === 'dpd') {
        this.loginDPD(true);
      }
      if (id === '17tuser') {
        this.login17T(true);
      }
      if (id === 'gls') {
        this.loginGLS(true);
      }
      if (id === 'ups') {
        this.loginUPS(true);
      }
      if (id === 'hermes') {
        await this.requestClient({
          method: 'post',
          url: 'https://mobile-app-api.a0930.prd.hc.de/api/v12/users/refreshtoken',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/json',
            'api-key': 'acefe97f-89fc-4f4e-9543-fc6b90f68928',
            'User-Agent': 'Hermes - ios - 12.1.1 (2689)',
            'Accept-Language': 'de-de',
          },
          data: `{"refreshToken":"${this.sessions['hermes'].refreshToken}"}`,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            this.hermesAuthToken = res.data.accessToken;
            this.sessions['hermes'] = res.data;
            this.setState('info.connection', true, true);
          })
          .catch((error) => {
            this.log.error('refresh token failed');
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }
  async createDHLStates() {
    await this.setObjectNotExistsAsync('dhl', {
      type: 'device',
      common: {
        name: 'DHL Tracking',
      },
      native: {},
    });

    await this.setObjectNotExistsAsync('dhl.json', {
      type: 'state',
      common: {
        name: 'Json Sendungen',
        write: false,
        read: true,
        type: 'string',
        role: 'json',
      },
      native: {},
    });
    await this.setObjectNotExistsAsync('dhl.briefe.json', {
      type: 'state',
      common: {
        name: 'Json Briefe',
        write: false,
        read: true,
        type: 'string',
        role: 'json',
      },
      native: {},
    });
  }
  sleep(ms) {
    if (this.adapterStopped) {
      ms = 0;
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  extractHidden(body) {
    const returnObject = {};
    const matches = this.matchAll(/<input (?=[^>]* name=["']([^'"]*)|)(?=[^>]* value=["']([^'"]*)|)/g, body);
    for (const match of matches) {
      returnObject[match[1]] = match[2];
    }
    return returnObject;
  }
  matchAll(re, str) {
    let match;
    const matches = [];
    while ((match = re.exec(str))) {
      // add all matched groups
      matches.push(match);
    }

    return matches;
  }
  randomString(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }
  getCodeChallenge() {
    let hash = '';
    let result = '';
    const chars = '0123456789abcdef';
    result = '';
    for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash('sha256').update(result).digest('base64');
    hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return [result, hash];
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.split('.')[2] === 'refresh') {
          this.updateProvider();
          return;
        }
        if (id.split('.')[2] === '17t') {
          if (!this.config['17trackKey']) {
            this.log.error('Missing 17Track Security Key');
            return;
          }
          const command = id.split('.')[3];
          await this.requestClient({
            method: 'post',
            url: 'https://api.17track.net/track/v1/' + command,
            headers: {
              '17token': this.config['17trackKey'],
              'Content-Type': 'application/json',
            },
            data: JSON.stringify([
              {
                number: state.val,
                auto_detection: true,
              },
            ]),
          })
            .then(async (res) => {
              this.log.debug(JSON.stringify(res.data));
              await this.requestClient({
                method: 'post',
                url: 'https://api.17track.net/track/v1/gettracklist',
                headers: {
                  '17token': this.config['17trackKey'],
                  'Content-Type': 'application/json',
                },
                data: {
                  number: state.val,
                  auto_detection: true,
                },
              })
                .then(async (res) => {
                  this.log.debug(JSON.stringify(res.data));
                  if (res.data && res.data.data && res.data.data.accepted) {
                    const trackArray = [];
                    for (const track of res.data.data.accepted) {
                      trackArray.push(track.number);
                    }
                    this.setState('17t.trackList', JSON.stringify(trackArray), true);
                  }
                })
                .catch((error) => {
                  this.log.error(error);
                  if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                  }
                });
            })
            .catch((error) => {
              this.log.error(error);
              if (error.response) {
                this.log.error(JSON.stringify(error.response.data));
              }
            });
        }
        if (id.split('.')[2] === '17tuser') {
          await this.requestClient({
            method: 'post',
            url: 'https://buyer.17track.net/orderapi/call',
            header: { 'content-type': 'application/x-www-form-urlencoded' },

            data: JSON.stringify({
              version: '1.0',
              timeZoneOffset: -60,
              method: 'AddTrackNo',
              param: { TrackNos: [state.val] },
            }),
          })
            .then(async (res) => {
              this.log.info(JSON.stringify(res.data));
              this.updateProvider();
            })
            .catch((error) => {
              this.log.error(error);
              if (error.response) {
                this.log.error(JSON.stringify(error.response.data));
              }
            });
        }
      } else {
        if (id.indexOf('dhl.briefe') !== -1 && id.indexOf('image_url') !== -1 && id.indexOf('oldAdvices') === -1) {
          let imageBase64 = this.images[state.val];
          if (!imageBase64) {
            // const image = await this.requestClient({
            //   method: 'get',
            //   url: state.val,
            //   responseType: 'arraybuffer',
            // }).catch((error) => {
            //   if (error.response && error.response.status === 401) {
            //     this.log.debug(error);
            //     return;
            //   }
            //   this.log.error(state.val + ' ' + error);
            // });
            const image = await dhlDecrypt(state.val, this.requestClient).catch((error) => {
              if (error.response && error.response.status === 401) {
                this.log.debug(error);
                return;
              }
              this.log.error(state.val + ' ' + error);
            });
            if (!image) {
              this.log.debug('No image received for ' + state.val);
              return;
            }
            const imageBuffer = Buffer.from(image, 'binary');
            imageBase64 = 'data:image/png;base64, ' + imageBuffer.toString('base64');
            this.images[state.val] = imageBase64;
            const pathArray = id.split('.');
            pathArray.pop();
            pathArray.push('image');
            await this.extendObjectAsync(pathArray.join('.'), {
              type: 'state',
              common: {
                name: 'Image Base64 Decrypted from URL',
                write: false,
                read: true,
                type: 'string',
                role: 'state',
              },
              native: {},
            });

            this.setState(pathArray.join('.'), imageBase64, true);
            if (this.config.sendToActive) {
              if (this.config.noFirstStartSend && this.firstStart) {
                return;
              }
              const uuid = uuidv4();
              fs.writeFileSync(`${this.tmpDir}${sep}${uuid}.jpg`, imageBuffer.toString('base64'), 'base64');
              const sendInstances = this.config.sendToInstance.replace(/ /g, '').split(',');
              const sendUser = this.config.sendToUser.replace(/ /g, '').split(',');

              for (const sendInstance of sendInstances) {
                if (sendUser.length > 0) {
                  for (const user of sendUser) {
                    if (sendInstance.includes('pushover')) {
                      await this.sendToAsync(sendInstance, {
                        device: user,
                        file: `${this.tmpDir}${sep}${uuid}.jpg`,
                        title: '✉️Briefankündigung',
                      });
                    } else if (sendInstance.includes('signal-cmb')) {
                      await this.sendToAsync(sendInstance, 'send', {
                        text: '✉️Briefankündigung',
                        phone: user,
                      });
                    } else {
                      await this.sendToAsync(sendInstance, {
                        user: user,
                        text: '✉️Briefankündigung',
                      });
                      await this.sendToAsync(sendInstance, {
                        user: user,
                        text: `${this.tmpDir}${sep}${uuid}.jpg`,
                      });
                    }
                  }
                } else {
                  if (sendInstance.includes('pushover')) {
                    await this.sendToAsync(sendInstance, {
                      file: `${this.tmpDir}${sep}${uuid}.jpg`,
                      title: '✉️Briefankündigung',
                    });
                  } else if (sendInstance.includes('signal-cmb')) {
                    await this.sendToAsync(sendInstance, 'send', {
                      text: '✉️Briefankündigung',
                    });
                  } else {
                    await this.sendToAsync(sendInstance, '✉️Briefankündigung');
                    await this.sendToAsync(sendInstance, `${this.tmpDir}${sep}${uuid}.jpg`);
                  }
                }
              }
              try {
                fs.unlinkSync(`${this.tmpDir}${sep}${uuid}.jpg`);
              } catch (error) {
                this.log.error(error);
              }
            }
          }
        }
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Parcel(options);
} else {
  // otherwise start the instance directly
  new Parcel();
}
