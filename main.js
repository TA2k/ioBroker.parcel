"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter

//disable canvas because of missing rebuild
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function () {
    if (arguments[0] === "canvas") {
        return { createCanvas: null, createImageData: null, loadImage: null };
    }
    return originalRequire.apply(this, arguments);
};

const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const getPwd = require("./lib/rsaKey");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { sep } = require("path");
const { tmpdir } = require("os");

class Parcel extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "parcel",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.json2iob = new Json2iob(this);
        this.sessions = {};
        this.mergedJson = [];
        this.inDelivery = [];
        this.mergedJsonObject = {};
        this.images = {};
        this.alreadySentMessages = {};
        this.ignoredPath = [];
        this.firstStart = true;
        this.delivery_status = { ERROR: -1, UNKNOWN: 5, REGISTERED: 10, IN_PREPARATION: 20, IN_TRANSIT: 30, OUT_FOR_DELIVERY: 40, DELIVERED: 1 };
        this.tmpDir = tmpdir();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }

        this.cookieJar = new tough.CookieJar();
        const cookieState = await this.getStateAsync("auth.cookie");
        if (cookieState && cookieState.val) {
            this.cookieJar = tough.CookieJar.fromJSON(cookieState.val);
        }
        this.requestClient = axios.create({
            jar: this.cookieJar,
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                jar: this.cookieJar,
            }),
        });

        if (this.config.dhlusername && this.config.dhlpassword) {
            this.log.info("Login to DHL");
            await this.loginDHL();
        }
        if (this.config.dpdusername && this.config.dpdpassword) {
            this.log.info("Login to DPD");
            await this.loginDPD();
        }
        if (this.config.t17username && this.config.t17password) {
            this.log.info("Login to T17 User");
            await this.login17T();
        }
        if (this.config.aliUsername && this.config.aliPassword) {
            this.log.info("Login to AliExpres");
            await this.loginAli();
        }

        if (this.config["17trackKey"]) {
            this.sessions["17track"] = this.config["17trackKey"];
            this.login17TApi();
            this.setState("info.connection", true, true);
        }
        if (this.config.amzusername && this.config.amzpassword) {
            this.log.info("Login to Amazon");
            await this.loginAmz();
        }

        if (this.config.glsusername && this.config.glspassword) {
            this.log.info("Login to GLS");
            await this.loginGLS();
        }
        if (this.config.upsusername && this.config.upspassword) {
            this.log.info("Login to UPS");
            await this.loginUPS();
        }
        if (this.config.hermesusername && this.config.hermespassword) {
            this.log.info("Login to Hermes");
            await this.loginHermes();
        }

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.subscribeStates("*");

        if (Object.keys(this.sessions).length > 0) {
            await this.updateProvider();
            this.updateInterval = setInterval(async () => {
                this.firstStart = false;
                await this.updateProvider();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, 3500 * 1000);
        } else {
            this.log.warn("No login session found");
        }
    }
    async loginDHL() {
        const mfaTokenState = await this.getStateAsync("auth.dhlMfaToken");
        await this.requestClient({
            method: "get",
            url: "https://www.dhl.de/int-webapp/spa/prod/ver4-SPA-VERFOLGEN.html?adobe_mc=TS%3D1643057331%7CMCORGID%3D3505782352FCE66F0A490D4C%40AdobeOrg",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                "accept-language": "de-de",
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
            method: "post",
            url: "https://www.dhl.de/int-erkennen/refresh",
            headers: {
                Host: "www.dhl.de",
                "content-type": "application/json",
                accept: "*/*",
                "x-requested-with": "XMLHttpRequest",
                "accept-language": "de-de",
                origin: "https://www.dhl.de",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                referer: "https://www.dhl.de/int-webapp/spa/prod/ver4-SPA-VERFOLGEN.html?adobe_mc=TS%3D1643039135%7CMCORGID%3D3505782352FCE66F0A490D4C%40AdobeOrg",
            },
            data: JSON.stringify({
                force: false,
                meta: "",
            }),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data && res.data.meta) {
                    this.log.info("Login to DHL successful");
                    this.sessions["dhl"] = res.data;
                    this.setState("info.connection", true, true);
                    this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
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
            this.log.info("Login to DHL");
            await this.requestClient({
                method: "post",
                url: "https://www.dhl.de/int-erkennen/login",
                headers: {
                    Host: "www.dhl.de",
                    "content-type": "application/json",
                    accept: "*/*",
                    "x-requested-with": "XMLHttpRequest",
                    "accept-language": "de-de",
                    origin: "https://www.dhl.de",
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                },
                jar: this.cookieJar,
                withCredentials: true,
                data: JSON.stringify({
                    id: this.config.dhlusername,
                    password: this.config.dhlpassword,
                    authenticationLevel: 3,
                    authenticationMethod: ["pwd"],
                    rememberMe: true,
                    language: "de",
                    context: "app",
                    meta: "",
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));

                    this.setState("auth.dhlMfaToken", res.data.intermediateMfaToken, true);
                    this.log.warn("Please enter " + res.data.secondFactorChannel + " code in instance settings and press save");
                })
                .catch((error) => {
                    this.log.error(error);
                    if (error.response) {
                        if (error.response.status === 409) {
                            this.log.error("Please enter code in instance settings and press save or wait 30min and let the code expire");

                            this.setState("auth.dhlMfaToken", error.response.data.intermediateMfaToken, true);
                        }
                        this.log.error(JSON.stringify(error.response.data));
                    }
                });
        } else {
            this.log.info("Login to DHL with MFA token");
            this.log.debug("MFA: " + this.config.dhlMfa);
            await this.requestClient({
                method: "post",
                url: "https://www.dhl.de/int-erkennen/2fa",
                headers: {
                    Host: "www.dhl.de",
                    "content-type": "application/json",
                    accept: "*/*",
                    "x-requested-with": "XMLHttpRequest",
                    "accept-language": "de-de",
                    origin: "https://www.dhl.de",
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                },
                jar: this.cookieJar,
                withCredentials: true,
                data: JSON.stringify({
                    value: this.config.dhlMfa,
                    remember2fa: true,
                    language: "de",
                    context: "app",
                    meta: "",
                    intermediateMfaToken: mfaToken,
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    this.log.info("Login to DHL successful");
                    this.sessions["dhl"] = res.data;
                    this.setState("info.connection", true, true);
                    this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                    await this.createDHLStates();
                })
                .catch(async (error) => {
                    this.log.error(error);
                    if (error.response) {
                        this.setState("info.connection", false, true);
                        this.log.error(JSON.stringify(error.response.data));
                        const adapterConfig = "system.adapter." + this.name + "." + this.instance;
                        this.log.error("MFA incorrect");
                        this.getForeignObject(adapterConfig, (error, obj) => {
                            if (obj && obj.native && obj.native.dhlMfa) {
                                obj.native.dhlMfa = "";
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
            method: "get",
            url: "https://passport.aliexpress.com/mini_login.htm?lang=de_de&appName=aebuyer&appEntrance=default&styleType=auto&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false&cssLink=https://i.alicdn.com/noah-static/4.0.2/common/css/reset-havana.css&cssUrl=https://i.alicdn.com/noah-static/4.0.2/common/css/reset-havana-new-page.css&showMobilePwdLogin=false&defaultCountryCode=DE&ut=&rnd=0.9085151696364684",
            headers: {
                "sec-ch-ua": '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
                "upgrade-insecure-requests": "1",
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.20 Safari/537.36",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                "sec-fetch-site": "same-site",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "iframe",
                referer: "https://login.aliexpress.com/",
                "accept-language": "de",
            },
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.indexOf("window.viewData = ") !== -1) {
                    try {
                        const loginData = res.data.split("window.viewData = ")[1].split(";")[0].replace(/\\/g, "");
                        return JSON.parse(loginData).loginFormData;
                    } catch (error) {
                        this.log.error(error);
                    }
                } else {
                    this.log.error("Failed Step 1 Aliexpress");
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
                method: "post",
                url: "https://passport.aliexpress.com/newlogin/login.do?appName=aebuyer&fromSite=13&_bx-v=2.0.39",
                headers: {
                    "sec-ch-ua": '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
                    accept: "application/json, text/plain, */*",
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-ch-ua-mobile": "?0",
                    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.20 Safari/537.36",
                    "sec-ch-ua-platform": '"macOS"',
                    origin: "https://login.aliexpress.com",
                    "sec-fetch-site": "same-site",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-dest": "empty",
                    referer: "https://login.aliexpress.com/",
                    "accept-language": "de",
                },
                jar: this.cookieJar,
                withCredentials: true,
                data: qs.stringify(loginData),
            })
                .then(async (res) => {
                    if (res.data.url && res.data.url.indexOf("punish") !== -1) {
                        this.log.error("Failed because of captcha");
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
                method: "get",
                url: "https://www.aliexpress.com/p/order/index.html",
                jar: this.cookieJar,
                withCredentials: true,
            })
                .then(async (res) => {
                    //  this.log.debug(JSON.stringify(res.data));
                    res.data.indexOf("Session has expired") !== -1 ? this.log.error("Session has expired") : this.log.info("Login to Aliexpress successful");
                })
                .catch(async (error) => {
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    this.log.error(error);
                });
        } else {
            this.log.info("Login to AliExpress with MFA token");
            this.log.debug("MFA: " + this.config.dhlMfa);
            await this.requestClient({
                method: "post",
                url: "https://www.dhl.de/int-erkennen/2fa",
                headers: {
                    Host: "www.dhl.de",
                    "content-type": "application/json",
                    accept: "*/*",
                    "x-requested-with": "XMLHttpRequest",
                    "accept-language": "de-de",
                    origin: "https://www.dhl.de",
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                },
                jar: this.cookieJar,
                withCredentials: true,
                data: JSON.stringify({
                    value: this.config.dhlMfa,
                    remember2fa: true,
                    language: "de",
                    context: "app",
                    meta: "",
                    intermediateMfaToken: mfaToken,
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    this.log.info("Login to DHL successful");
                    this.sessions["dhl"] = res.data;
                    this.setState("info.connection", true, true);
                    this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                    await this.createDHLStates();
                })
                .catch(async (error) => {
                    this.log.error(error);
                    if (error.response) {
                        this.setState("info.connection", false, true);
                        this.log.error(JSON.stringify(error.response.data));
                        const adapterConfig = "system.adapter." + this.name + "." + this.instance;
                        this.log.error("MFA incorrect");
                        this.getForeignObject(adapterConfig, (error, obj) => {
                            if (obj && obj.native && obj.native.dhlMfa) {
                                obj.native.dhlMfa = "";
                                this.setForeignObject(adapterConfig, obj);
                            }
                        });
                        return;
                    }
                });
        }
    }

    async loginAmz() {
        let body = await this.requestClient({
            method: "get",
            url: "https://www.amazon.de/ap/signin?_encoding=UTF8&accountStatusPolicy=P1&openid.assoc_handle=deflex&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fgp%2Fcss%2Forder-history%3Fie%3DUTF8%26ref_%3Dnav_orders_first&pageId=webcs-yourorder&showRmrMe=1",
            headers: {
                accept: "*/*",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                "accept-language": "de-de",
            },
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                this.log.error("Amazon login failed");
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        let form = this.extractHidden(body);
        form.email = this.config.amzusername;
        body = await this.requestClient({
            method: "post",
            url: "https://www.amazon.de/ap/signin",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "content-type": "application/x-www-form-urlencoded",
                origin: "https://www.amazon.de",
                "accept-language": "de-de",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                referer: "https://www.amazon.de/ap/signin",
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
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        form = this.extractHidden(body);
        form.password = this.config.amzpassword;
        await this.requestClient({
            method: "post",
            url: "https://www.amazon.de/ap/signin",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "content-type": "application/x-www-form-urlencoded",
                origin: "https://www.amazon.de",
                "accept-language": "de-de",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                referer: "https://www.amazon.de/ap/signin",
            },
            data: qs.stringify(form),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.indexOf("Meine Bestellungen") !== -1) {
                    this.log.info("Login to Amazon successful");
                    this.sessions["amz"] = true;
                    this.setState("info.connection", true, true);
                    this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                    await this.setObjectNotExistsAsync("amazon", {
                        type: "device",
                        common: {
                            name: "Amazon Tracking",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync("amazon.json", {
                        type: "state",
                        common: {
                            name: "Json Sendungen",
                            write: false,
                            read: true,
                            type: "string",
                            role: "json",
                        },
                        native: {},
                    });
                    return;
                }
                if (res.data.indexOf("auth-mfa-otpcode") !== -1) {
                    this.log.info("Found MFA token login");
                    const form = this.extractHidden(res.data);
                    form.otpCode = this.config.amzotp;
                    form.rememberDevice = true;

                    await this.requestClient({
                        method: "post",
                        url: "https://www.amazon.de/ap/signin",
                        headers: {
                            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "content-type": "application/x-www-form-urlencoded",
                            origin: "https://www.amazon.de",
                            "accept-language": "de-de",
                            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                            referer: "https://www.amazon.de/ap/signin",
                        },
                        data: qs.stringify(form),
                        jar: this.cookieJar,
                        withCredentials: true,
                    })
                        .then(async (res) => {
                            this.log.debug(JSON.stringify(res.data));
                            if (res.data.indexOf("Meine Bestellungen") !== -1) {
                                this.log.info("Login to Amazon successful");
                                this.sessions["amz"] = true;
                                this.setState("info.connection", true, true);
                                this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                                await this.setObjectNotExistsAsync("amazon", {
                                    type: "device",
                                    common: {
                                        name: "Amazon Tracking",
                                    },
                                    native: {},
                                });
                                return;
                            }
                            this.log.error("MFA: Login to Amazon failed, please login manually to Amazon");
                            this.setState("info.connection", false, true);
                        })
                        .catch(async (error) => {
                            if (error.response) {
                                this.setState("info.connection", false, true);
                                this.log.error(JSON.stringify(error.response.data));
                            }

                            this.log.error(error);
                        });
                    return;
                }
                if (res.data.indexOf("Amazon Anmelden") !== -1) {
                    this.log.error("Login to Amazon failed, please login to Amazon manually and check the login");

                    return;
                }
                if (res.data.indexOf("Zurücksetzen des Passworts erforderlich") !== -1) {
                    this.log.error("Zurücksetzen des Passworts erforderlich");
                    return;
                }
                this.log.error("Unknown Error: Login to Amazon failed, please login to Amazon and check your credentials");
                this.setState("info.connection", false, true);
                return;
            })
            .catch(async (error) => {
                if (error.response) {
                    this.setState("info.connection", false, true);
                    this.log.error(JSON.stringify(error.response.data));
                }

                this.log.error(error);
            });
    }
    async loginDPD(silent) {
        await this.requestClient({
            method: "get",
            url: "https://my.dpd.de/logout.aspx",
            jar: this.cookieJar,
            withCredentials: true,
        }).catch(async (error) => {
            error.response && this.log.error(JSON.stringify(error.response.data));
            this.log.error(error);
        });
        await this.requestClient({
            method: "post",
            url: "https://www.dpd.com/de/de/mydpd-anmelden-und-registrieren/",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.66 Safari/537.36",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                "accept-language": "de,en;q=0.9",
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
                if (res.data && res.data.indexOf("Login fehlgeschlagen") !== -1) {
                    this.log.error("Login to DPD failed, please check username and password");
                    return;
                }
            })
            .catch(async (error) => {
                if (error.response) {
                    if (error.response.status === 302) {
                        this.dpdToken = error.response.headers.location.split("=")[1];
                        !silent && this.log.info("Login to DPD successful");
                        this.sessions["dpd"] = true;
                        await this.setObjectNotExistsAsync("dpd", {
                            type: "device",
                            common: {
                                name: "DPD Tracking",
                            },
                            native: {},
                        });
                        await this.setObjectNotExistsAsync("dpd.json", {
                            type: "state",
                            common: {
                                name: "Json Sendungen",
                                write: false,
                                read: true,
                                type: "string",
                                role: "json",
                            },
                            native: {},
                        });
                        this.setState("info.connection", true, true);
                        this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                        return;
                    }

                    this.log.error(error);
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        await this.requestClient({
            method: "get",
            url: "https://my.dpd.de/myParcel.aspx?dpd_token=" + this.dpdToken,
            jar: this.cookieJar,
            withCredentials: true,
        }).catch(async (error) => {
            error.response && this.log.error(JSON.stringify(error.response.data));
            this.log.error(error);
        });
    }
    async loginGLS(silent) {
        await this.requestClient({
            method: "post",
            url: "https://gls-one.de/api/auth",
            headers: {
                Accept: "application/json, text/plain, */*",
                "X-Selected-Country": "DE",
                "Accept-Language": "de-de",
                "X-Selected-Language": "DE",
                "Content-Type": "application/json",
                Origin: "https://gls-one.de",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                "X-Client-Id": "iOS",
                Referer: "https://gls-one.de/de?platform=iOS",
            },
            data: JSON.stringify({
                username: this.config.glsusername,
                password: this.config.glspassword,
            }),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.sessions["gls"] = res.data;
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
            method: "get",
            url: "https://gls-one.de/api/auth/login",
            headers: {
                "X-Selected-Country": "DE",
                "Accept-Language": "de-de",
                "X-Selected-Language": "DE",
                Accept: "application/json, text/plain, */*",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                "X-Client-Id": "iOS",
                "X-Auth-Token": this.glstoken,
            },
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                !silent && this.log.info("Login to GLS successful");
                this.glsid = res.data._id;
                await this.setObjectNotExistsAsync("gls", {
                    type: "device",
                    common: {
                        name: "GLS Tracking",
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync("gls.json", {
                    type: "state",
                    common: {
                        name: "Json Sendungen",
                        write: false,
                        read: true,
                        type: "string",
                        role: "json",
                    },
                    native: {},
                });
                this.setState("info.connection", true, true);
                this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
            })
            .catch(async (error) => {
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error(error);
            });
    }
    async loginHermes() {
        await this.requestClient({
            method: "post",
            url: "https://mobile-api.myhermes.de/mobile-api-web/v2/users/login",
            headers: {
                Host: "mobile-api.myhermes.de",
                accept: "application/json",
                "content-type": "application/json; charset=utf-8",
                "user-agent": "Hermes/33 CFNetwork/1240.0.4 Darwin/20.6.0",
                "accept-language": "de-de",
            },
            data: `{"username":"${this.config.hermesusername}","password":"${this.config.hermespassword}"}`,

            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.accessToken) {
                    this.hermesAuthToken = res.data.accessToken;
                    this.sessions["hermes"] = res.data;
                    this.log.info("Login to Hermes successful");
                    await this.setObjectNotExistsAsync("hermes", {
                        type: "device",
                        common: {
                            name: "Hermes Tracking",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync("hermes.json", {
                        type: "state",
                        common: {
                            name: "Json Sendungen",
                            write: false,
                            read: true,
                            type: "string",
                            role: "json",
                        },
                        native: {},
                    });
                    this.setState("info.connection", true, true);
                } else {
                    this.log.error("Login to Hermes failed");
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
            method: "post",
            url: "https://onlinetools.ups.com/rest/Login",
            headers: {
                Connection: "keep-alive",
                Accept: "application/json",
                "Content-Type": "application/json",
                Host: "onlinetools.ups.com",
            },
            data: JSON.stringify({
                UPSSecurity: {
                    UsernameToken: {},
                    ServiceAccessToken: {
                        AccessLicenseNumber: "BDB176074C16EB9D",
                    },
                },
                LoginSubmitUserIdRequest: {
                    UserId: this.config.upsusername,
                    Password: this.config.upspassword,
                    Locale: "de_DE",
                    ClientID: "native",
                    IsMobile: "true",
                },
            }),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.LoginSubmitUserIdResponse && res.data.LoginSubmitUserIdResponse.LoginResponse && res.data.LoginSubmitUserIdResponse.LoginResponse.AuthenticationToken) {
                    this.upsAuthToken = res.data.LoginSubmitUserIdResponse.LoginResponse.AuthenticationToken;

                    this.sessions["ups"] = res.data;
                    !silent && this.log.info("Login to UPS successful");
                    await this.setObjectNotExistsAsync("ups", {
                        type: "device",
                        common: {
                            name: "UPS Tracking",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync("ups.json", {
                        type: "state",
                        common: {
                            name: "Json Sendungen",
                            write: false,
                            read: true,
                            type: "string",
                            role: "json",
                        },
                        native: {},
                    });
                    this.setState("info.connection", true, true);
                    this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                } else {
                    this.log.warn("Login to UPS failed");
                    this.log.info(JSON.stringify(res.data));
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
            method: "post",
            url: "https://onlinetools.ups.com/rest/MCEnrollment",
            headers: {
                Connection: "keep-alive",
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                UPSSecurity: {
                    UsernameToken: {
                        AuthenticationToken: this.upsAuthToken,
                    },
                    ServiceAccessToken: {
                        AccessLicenseNumber: "BDB176074C16EB9D",
                    },
                },
                GetEnrollmentsRequest: {
                    Request: {
                        RequestOption: ["00"],
                        TransactionReference: {},
                    },
                    Locale: {
                        Language: "de",
                        Country: "DE",
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
                    this.log.warn("No UPS address found. Please activate UPS My Choice in the UPS App");
                    this.log.info(JSON.stringify(res.data));
                }
            })
            .catch(async (error) => {
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error(error);
            });
    }
    async login17TApi() {
        await this.setObjectNotExistsAsync("17t", {
            type: "device",
            common: {
                name: "17Track API Tracking",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("17t.trackinginfo", {
            type: "channel",
            common: {
                name: "17Track Tracking Info",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("17t.trackinginfo.json", {
            type: "state",
            common: {
                name: "Json Sendungen",
                write: false,
                read: true,
                type: "string",
                role: "json",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("17t.register", {
            type: "state",
            common: {
                name: "Register Tracking ID",
                write: true,
                read: true,
                type: "mixed",
                role: "state",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("17t.trackList", {
            type: "state",
            common: {
                role: "state",
                name: "Registered tracking ids",
                type: "object",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("17t.deleteTrack", {
            type: "state",
            common: {
                role: "state",
                name: "Unregister a tracking id",
                type: "mixed",
                read: true,
                write: true,
            },
            native: {},
        });
    }
    async login17T(silent) {
        await this.requestClient({
            method: "post",
            url: "https://user.17track.net/userapi/call",
            headers: {
                accept: "*/*",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-requested-with": "XMLHttpRequest",
                "accept-language": "de,en;q=0.9",
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
                    this.log.error("Login to 17TUser failed. Login via Google is not working");
                    this.log.error("T17User: " + res.data.Message);
                    return;
                }
                !silent && this.log.info("Login to T17 User successful");
                this.sessions["17tuser"] = true;
                await this.setObjectNotExistsAsync("17tuser", {
                    type: "device",
                    common: {
                        name: "17Track User Tracking",
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync("17tuser.trackinginfo.json", {
                    type: "state",
                    common: {
                        name: "Json Sendungen",
                        write: false,
                        read: true,
                        type: "string",
                        role: "json",
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync("17tuser.register", {
                    type: "state",
                    common: {
                        name: "Register Tracking ID",
                        write: true,
                        read: true,
                        type: "mixed",
                        role: "state",
                    },
                    native: {},
                });
                this.setState("info.connection", true, true);
                this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
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
        if (this.sessions["17track"]) {
            try {
                const trackList = await this.getStateAsync("17t.trackList");
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
        if (this.sessions["dhl"]) {
            dataDhl = await this.requestClient({
                method: "get",
                url: "https://www.dhl.de/int-verfolgen/data/search?noRedirect=true&language=de&cid=app",
                jar: this.cookieJar,
                withCredentials: true,
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (res.data && res.data.sendungen) {
                        return res.data.sendungen.map((sendung) => {
                            if (sendung.sendungsinfo.sendungsliste !== "ARCHIVIERT") {
                                return sendung.id;
                            }
                        });
                    }
                    return [];
                })
                .catch((error) => {
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    return [];
                });
        }
        if (this.sessions["amz"]) {
            await this.getAmazonPackages();
        }
        const statusArrays = {
            dhl: [
                {
                    path: "dhl",
                    url: "https://www.dhl.de/int-verfolgen/data/search?piececode=" + dataDhl + "&noRedirect=true&language=de&cid=app",
                    header: {
                        accept: "application/json",
                        "content-type": "application/json",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        "accept-language": "de-de",
                    },
                },
                {
                    path: "dhl.briefe",
                    url: "https://www.dhl.de/int-aviseanzeigen/advices?width=414",
                    header: {
                        accept: "application/json",
                        "content-type": "application/json",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        "accept-language": "de-de",
                    },
                },
            ],
            "17track": [
                {
                    method: "post",
                    path: "17t.trackinginfo",
                    url: "https://api.17track.net/track/v1/gettrackinfo",
                    header: {
                        "17token": this.config["17trackKey"],
                        "Content-Type": "application/json",
                    },
                    data: JSON.stringify(data17Track),
                },
            ],
            "17tuser": [
                {
                    method: "post",
                    path: "17tuser.trackinginfo",
                    url: "https://buyer.17track.net/orderapi/call",
                    data: '{"version":"1.0","timeZoneOffset":-60,"method":"GetTrackInfoList","param":{"ob":"1","Page":1,"IsArchived":false}}',
                    header: { "content-type": "application/x-www-form-urlencoded" },
                },
            ],
            amz: [],
            dpd: [
                {
                    path: "dpd",
                    url: "https://my.dpd.de/myParcel.aspx", //?dpd_token=" + this.dpdToken,
                    header: {
                        accept: "*/*",
                        "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.45 Safari/537.36",
                        "accept-language": "de-de",
                        "Cache-Control": "no-cache",
                        Pragma: "no-cache",
                        Expires: "0",
                    },
                },
            ],
            gls: [
                {
                    path: "gls",
                    url: "https://gls-one.de/api/v3/customers/" + this.glsid + "/parcels?page=0&sort=createdDate,DESC",
                    header: {
                        accept: "*/*",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        "accept-language": "de-de",
                        "X-Auth-Token": this.glstoken,
                    },
                },
            ],
            hermes: [
                {
                    path: "hermes",
                    url: "https://mobile-api.myhermes.de/mobile-api-web/v2/shipments",
                    header: {
                        accept: "application/json",
                        "user-agent": "Hermes/33 CFNetwork/1240.0.4 Darwin/20.6.0",
                        "accept-language": "de-de",
                        authorization: "Bearer " + this.hermesAuthToken,
                    },
                },
            ],
            ups: [
                {
                    path: "ups",
                    method: "post",
                    url: "https://onlinetools.ups.com/mychoice/v1/shipments/details/AddressToken?loc=de_DE",
                    header: {
                        Connection: "keep-alive",
                        Accept: "application/json",
                        AccessLicenseNumber: "BDB176074C16EB9D",
                        AuthenticationToken: this.upsAuthToken,
                        addresstoken: this.upsAddressToken,
                        transID: uuidv4().substring(0, 25),
                        transactionSrc: "MOBILE",
                        "Content-Type": "application/json",
                    },
                    data: JSON.stringify({
                        parcelCount: "10",
                        disableFeature: "",
                    }),
                },
            ],
        };

        for (const id of Object.keys(this.sessions)) {
            for (const element of statusArrays[id]) {
                this.log.debug(element.url);
                if (this.ignoredPath.includes(element.path)) {
                    this.log.debug("Ignore: " + element.path);
                    continue;
                }
                await this.requestClient({
                    method: element.method ? element.method : "get",
                    url: element.url,
                    headers: element.header,
                    jar: this.cookieJar,
                    withCredentials: true,
                    data: element.data,
                })
                    .then(async (res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        let data = res.data;
                        if (id === "17track") {
                            data = res.data.data;
                        }
                        if (id === "17tuser") {
                            data = res.data.Json;
                        }
                        if (id === "gls") {
                            for (const parcel of res.data._embedded.parcels) {
                                parcel.id = parcel._id.toString();
                                delete parcel._id;
                            }
                            data = { sendungen: res.data._embedded.parcels };
                        }
                        if (id === "ups") {
                            for (const parcel of res.data.response.shipments) {
                                parcel.id = parcel.trackingNumber;
                            }
                            data = { sendungen: res.data.response.shipments };
                        }
                        if (id === "hermes") {
                            try {
                                if (res.data) {
                                    if (typeof res.data === "string") {
                                        res.data = JSON.parse(res.data);
                                    }
                                    for (const parcel of res.data) {
                                        parcel.id = parcel.shipmentId;
                                    }
                                    data = { sendungen: res.data };
                                }
                            } catch (error) {
                                this.log.warn("Hermes response incomplete cannot parse result");
                                this.log.debug(res.data);
                                data = { sendungen: [] };
                            }
                        }
                        const forceIndex = true;
                        const preferedArrayName = null;
                        if (id === "dpd") {
                            data = this.convertDomToJson(data);
                        }
                        //filter archive message
                        if (id === "dhl" && data.sendungen) {
                            const trackingList = [];
                            data.sendungen = data.sendungen.filter((sendung) => {
                                trackingList.push(sendung.id);
                                return sendung.sendungsinfo.sendungsliste !== "ARCHIVIERT";
                            });
                        }
                        //activate briefe token
                        if (element.path === "dhl.briefe" && res.data.grantToken) {
                            await this.activateToken(res.data.grantToken, res.data.accessTokenUrl);
                            await this.sleep(1000);
                        }
                        if (data) {
                            await this.cleanupProvider(id, data);
                            this.mergeProviderJson(id, data);
                            this.json2iob.parse(element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName });
                            data && this.setState(element.path + ".json", JSON.stringify(data), true);
                        }
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401 && id !== "17track") {
                                if (element.path === "dhl.briefe") {
                                    this.log.debug(error);
                                    return;
                                }

                                error.response && this.log.debug(JSON.stringify(error.response.data));

                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                if (!this.refreshTokenTimeout) {
                                    this.refreshTokenTimeout = setTimeout(() => {
                                        this.refreshTokenTimeout = null;
                                        this.refreshToken();
                                    }, 1000 * 60);
                                }
                                return;
                            }
                            if (element.path === "dhl.briefe") {
                                this.log.info("Briefankündigung is not working. Stopped until restart");
                                this.ignoredPath.push(element.path);
                            }
                        }
                        this.log.error(element.url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
        this.log.debug("Write states");
        this.setState("allProviderJson", JSON.stringify(this.mergedJson), true);
        this.setState("allProviderObjects", JSON.stringify(this.mergedJsonObject), true);
        this.setState("inDelivery", JSON.stringify(this.inDelivery), true);
        this.setState("inDeliveryCount", this.inDelivery.length, true);
    }
    async cleanupProvider(id, data) {
        if (id === "dhl" && data.hasOwnProperty("grantToken")) {
            await this.delObjectAsync("dhl.briefe", { recursive: true });
            await this.setObjectNotExistsAsync("dhl.briefe.json", {
                type: "state",
                common: {
                    name: "Json Briefe",
                    write: false,
                    read: true,
                    type: "string",
                    role: "json",
                },
                native: {},
            });
        }
        if ((id === "dhl" || id === "dpd" || id === "amz" || id === "gls" || id === "ups" || id === "hermes") && data && data.sendungen) {
            const states = await this.getStatesAsync(id + ".sendungen*.id");
            const sendungsArray = data.sendungen.map((sendung) => {
                return sendung.id;
            });
            for (const sendungsIdKey in states) {
                const index = Object.keys(states).indexOf(sendungsIdKey);
                if (states[sendungsIdKey]) {
                    const sendungsId = states[sendungsIdKey].val;
                    if (sendungsArray[index] !== sendungsId) {
                        const idArray = sendungsIdKey.split(".");
                        idArray.pop();
                        this.log.debug("deleting " + sendungsIdKey);
                        await this.delObjectAsync(idArray.join("."), { recursive: true });
                    }
                }
            }
        }
    }
    async mergeProviderJson(id, data) {
        this.log.debug(id + " merge provider json");
        if (id === "dhl" && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                let status = "";

                if (sendung.sendungsdetails && sendung.sendungsdetails.sendungsverlauf && sendung.sendungsdetails.sendungsverlauf.kurzStatus) {
                    status = sendung.sendungsdetails.sendungsverlauf.kurzStatus;
                }
                if (sendung.sendungsdetails && sendung.sendungsdetails.liveTrackingVerfuegbar && sendung.sendungsdetails.liveTracking) {
                    status = status + " " + sendung.sendungsdetails.liveTracking.countdown + " Stopps";
                }
                const name = sendung.sendungsinfo.sendungsname;

                const sendungsObject = { id: sendung.id, name: name, status: status, source: "DHL" };

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
        if (id === "gls" && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                const sendungsObject = { id: sendung.id, name: sendung.label || sendung.parcelNumber, status: sendung.status, source: "GLS", direction: sendung.type };

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
        if (id === "ups" && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                const sendungsObject = { id: sendung.id, name: sendung.shipFromName, status: sendung.locStatus || sendung.status, source: "UPS" };

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
        if (id === "hermes" && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                let name = sendung.description;
                if (sendung.sender && sendung.sender.lastname) {
                    name = name + " " + sendung.sender.lastname;
                }
                const sendungsObject = { id: sendung.id, name: name, status: sendung.lastStatusMessage || "", source: "Hermes" };

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

        if (id === "dpd" && data && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                const sendungsObject = { id: sendung.id, name: sendung.name, status: sendung.status || "", source: "DPD" };

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
        if (id === "amz" && data && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                const sendungsObject = { id: sendung.id, name: sendung.name, status: sendung.status, source: "AMZ" };

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
        if (id === "17track" && data.accepted) {
            const sendungsArray = data.accepted.map((sendung) => {
                const sendungsObject = { id: sendung.number, name: sendung.number, status: sendung.track.z0 ? sendung.track.z0.z : "", source: "17track" };
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
        if (id === "17tuser" && data) {
            const sendungsArray = data.map((sendung) => {
                try {
                    if (sendung.FLastEvent) {
                        sendung.FLastEvent = JSON.parse(sendung.FLastEvent);
                    }
                    const sendungsObject = { id: sendung.FTrackNo, name: sendung.FTrackInfoId, status: sendung.FLastEvent ? sendung.FLastEvent.z : "", source: "17tuser" };
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
                const sendInstances = this.config.sendToInstance.replace(/ /g, "").split(",");
                const sendUser = this.config.sendToUser.replace(/ /g, "").split(",");
                for (const sendInstance of sendInstances) {
                    const text = "📦 " + sendungen[id].source + " " + sendungen[id].name + "\n" + sendungen[id].status;
                    if (sendUser.length > 0) {
                        for (const user of sendUser) {
                            if (sendInstance.includes("pushover")) {
                                await this.sendToAsync(sendInstance, { user: user, message: text, title: "Paketstatus" });
                            } else {
                                await this.sendToAsync(sendInstance, { user: user, text: text });
                            }
                        }
                    } else {
                        if (sendInstance.includes("pushover")) {
                            await this.sendToAsync(sendInstance, { message: text, title: "Paketstatus" });
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
            sendungsObject.status.toLocaleLowerCase().includes("in zustellung") ||
            sendungsObject.status.toLocaleLowerCase().includes("zustellung heute") ||
            //sendungsObject.status.toLocaleLowerCase().includes("heute zugestell") ||
            sendungsObject.status.toLocaleLowerCase().includes("wird zugestellt") ||
            sendungsObject.status.toLocaleLowerCase().includes("zustellfahrzeug")
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
            sendungsObject.status.toLocaleLowerCase().includes("geliefert heute") ||
            sendungsObject.status.toLocaleLowerCase().includes("geliefert. heute zugestellt") ||
            sendungsObject.status.toLocaleLowerCase().includes("unterschrieben von") ||
            sendungsObject.status.toLocaleLowerCase().includes("hausbewohner übergeben") ||
            sendungsObject.status.toLocaleLowerCase().includes("zustellung erfolgreich") ||
            sendungsObject.status.toLocaleLowerCase().includes("paket zugestellt")
        ) {
            return true;
        }
        return false;
    }
    deliveryStatusCheck(sendung, id, sendungsObject) {
        try {
            if (sendung) {
                if (id === "dhl" && sendung.sendungsdetails && sendung.sendungsdetails.sendungsverlauf && sendung.sendungsdetails.sendungsverlauf.fortschritt) {
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
                if (id === "hermes" && sendung.lastStatusId) {
                    const hermes_status = {
                        0: this.delivery_status.REGISTERED,
                        1: this.delivery_status.REGISTERED,
                        2: this.delivery_status.IN_PREPARATION,
                        3: this.delivery_status.IN_TRANSIT,
                        4: this.delivery_status.OUT_FOR_DELIVERY,
                        5: this.delivery_status.DELIVERED,
                    };
                    if (hermes_status[sendung.lastStatusId] !== undefined) {
                        return hermes_status[sendung.lastStatusId];
                    }
                }
                if (id === "dpd" && sendung.statusId) {
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
                if (id === "gls" && sendung.status) {
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
                if (id === "amz" && sendung.detailedState && sendung.detailedState.shortStatus) {
                    const amz_status = {
                        ORDER_PLACED: this.delivery_status.REGISTERED, //ORDERED
                        SHIPPING_SOON: this.delivery_status.IN_PREPARATION,
                        IN_TRANSIT: this.delivery_status.IN_TRANSIT,
                        OUT_FOR_DELIVERY: this.delivery_status.OUT_FOR_DELIVERY,
                        DELIVERED: this.delivery_status.DELIVERED,
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
            return this.delivery_status["ERROR"];
        }
    }

    async activateToken(grant_token, url) {
        await this.requestClient({
            method: "post",
            url: url,
            headers: {
                Accept: "*/*",
                "Content-Type": "application/json",
            },
            data: JSON.stringify({
                grant_token: grant_token,
            }),
            jar: this.cookieJar,
            withCredentials: true,
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
        const parcelList = dom.window.document.querySelector(".parcelList");
        if (!parcelList) {
            this.log.debug("No DPD parcelList found");
            return result;
        }
        this.log.debug("Found DPD Parcel List");
        this.log.debug("Found " + parcelList.querySelectorAll(".btnSelectParcel").length + " parcels");
        parcelList.querySelectorAll(".btnSelectParcel").forEach((parcel) => {
            const parcelInfo = parcel.firstElementChild;
            this.log.debug(parcelInfo.textContent);
            let statusId = parcelInfo.querySelector("img").src;
            if (statusId) {
                statusId = statusId.replace("images/status_", "").replace(".svg", "");
            }
            result.sendungen.push({
                id: parcelInfo.querySelector(".parcelNo").textContent,
                name: parcelInfo.querySelector(".parcelName").textContent,
                status: parcelInfo.querySelector(".parcelDeliveryStatus").textContent,
                statusId: statusId,
            });
        });
        return result;
    }
    async getAmazonPackages() {
        this.log.debug("Get Amazon Packages");
        const amzResult = { sendungen: [] };

        const orders = await this.requestClient({
            method: "get",
            url: "https://www.amazon.de/gp/css/order-history?ref_=nav_orders_first&disableCsd=missing-library",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                "accept-language": "de-de",
            },
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then(async (res) => {
                //this.log.debug(JSON.stringify(res.data));

                const dom = new JSDOM(res.data);
                const document = dom.window.document;
                const elements = [];
                const orders = document.querySelectorAll(".a-box.shipment");

                for (const order of orders) {
                    const descHandle = order.querySelector(".a-fixed-right-grid-col.a-col-left .a-row div:first-child .a-fixed-left-grid-col.a-col-right div:first-child .a-link-normal");
                    const desc = descHandle ? descHandle.textContent.replace(/\n */g, "") : "";
                    const url = order.querySelector(".track-package-button a") ? order.querySelector(".track-package-button a").getAttribute("href") : "";
                    if (url) {
                        elements.push({ desc: desc, url: url });
                    }
                }
                return elements;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        if (!orders) {
            this.log.warn("No Amazon orders found");
            return;
        }
        this.log.debug("Found " + orders.length + " Amazon Orders");
        for (const order of orders) {
            if (order.url.indexOf("http") === -1) {
                order.url = "https://www.amazon.de" + order.url;
            }
            this.log.debug(order.url);
            order.url = order.url + "&disableCsd=missing-library";
            const element = await this.requestClient({
                method: "get",
                url: order.url,
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "accept-language": "de-de",
                },
                jar: this.cookieJar,
                withCredentials: true,
            })
                .then(async (res) => {
                    // this.log.debug(JSON.stringify(res.data));
                    const dom = new JSDOM(res.data);
                    const document = dom.window.document;
                    const statusHandle = document.querySelector(".milestone-primaryMessage.alpha") || document.querySelector(".milestone-primaryMessage") || null;
                    const additionalStatus = document.querySelector("#primaryStatus") ? document.querySelector("#primaryStatus").textContent.replace(/\n */g, "") : "";
                    const secondaryStatus = document.querySelector("#secondaryStatus") ? document.querySelector("#secondaryStatus").textContent.replace(/\n */g, "") : "";
                    let stopsStatus = "";
                    let stateObject = {};
                    if (document.querySelector(`script[data-a-state='{"key":"page-state"}']`)) {
                        try {
                            const jsonState = document.querySelector(`script[data-a-state='{"key":"page-state"}']`).textContent;
                            stateObject = JSON.parse(jsonState);
                            if (stateObject.mapTracking && stateObject.mapTracking.calloutMessage) {
                                stopsStatus = stateObject.mapTracking.calloutMessage;
                            }
                        } catch (error) {
                            this.log.error(errror);
                        }
                    }

                    let status = statusHandle ? statusHandle.textContent.replace(/\n */g, "") : "";
                    if (!status) {
                        status = additionalStatus;
                    }
                    if (additionalStatus && status !== additionalStatus) {
                        status = status + ". " + additionalStatus;
                    }

                    if (secondaryStatus) {
                        status = status + ". " + secondaryStatus;
                    }

                    if (stopsStatus) {
                        status = status + ". " + stopsStatus;
                    }

                    return {
                        id: document.querySelector(".carrierRelatedInfo-trackingId-text")
                            ? document.querySelector(".carrierRelatedInfo-trackingId-text").textContent.replace("Trackingnummer ", "")
                            : "",
                        name: document.querySelector(".carrierRelatedInfo-mfn-providerTitle") ? document.querySelector(".carrierRelatedInfo-mfn-providerTitle").textContent.replace(/\\n */g, "") : "",
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

        this.json2iob.parse("amazon", amzResult, { forceIndex: true });

        this.mergeProviderJson("amz", amzResult);
        await this.setStateAsync("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
        await this.setStateAsync("amazon.json", JSON.stringify(amzResult), true);
    }
    async refreshToken() {
        if (Object.keys(this.sessions).length === 0) {
            this.log.error("No session found relogin");
            return;
        }
        for (const id of Object.keys(this.sessions)) {
            if (id === "dhl") {
                await this.requestClient({
                    method: "post",
                    url: "https://www.dhl.de/int-erkennen/refresh",
                    jar: this.cookieJar,
                    withCredentials: true,
                    headers: {
                        "content-type": "application/json",
                        accept: "*/*",
                        "x-requested-with": "XMLHttpRequest",
                        "accept-language": "de-de",
                        origin: "https://www.dhl.de",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        referer: "https://www.dhl.de/",
                    },
                    data: JSON.stringify({
                        force: false,
                        meta: this.sessions["dhl"].meta,
                    }),
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        this.sessions["dhl"] = res.data;
                        this.setState("auth.cookie", JSON.stringify(this.cookieJar.toJSON()), true);
                        this.setState("info.connection", true, true);
                    })
                    .catch((error) => {
                        this.log.error("refresh token failed");
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                        this.log.error("Start relogin in 1min");
                        if (!this.reLoginTimeout) {
                            this.reLoginTimeout = setTimeout(() => {
                                this.reLoginTimeout = null;
                                this.loginDHL();
                            }, 1000 * 60 * 1);
                        }
                    });
            }
            if (id === "dpd") {
                this.loginDPD(true);
            }
            if (id === "17tuser") {
                this.login17T(true);
            }
            if (id === "gls") {
                this.loginGLS(true);
            }
            if (id === "ups") {
                this.loginUPS(true);
            }
            if (id === "hermes") {
                await this.requestClient({
                    method: "post",
                    url: "https://mobile-api.myhermes.de/mobile-api-web/v2/users/refreshtoken",
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        Accept: "application/json",
                        "User-Agent": "Hermes/33 CFNetwork/1240.0.4 Darwin/20.6.0",
                        "Accept-Language": "de-de",
                    },
                    data: `{"refreshToken":"${this.sessions["hermes"].refreshToken}"}`,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        this.hermesAuthToken = res.data.accessToken;
                        this.sessions["hermes"] = res.data;
                        this.setState("info.connection", true, true);
                    })
                    .catch((error) => {
                        this.log.error("refresh token failed");
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
    }
    async createDHLStates() {
        await this.setObjectNotExistsAsync("dhl", {
            type: "device",
            common: {
                name: "DHL Tracking",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("dhl.json", {
            type: "state",
            common: {
                name: "Json Sendungen",
                write: false,
                read: true,
                type: "string",
                role: "json",
            },
            native: {},
        });

        await this.setObjectNotExistsAsync("dhl.json", {
            type: "state",
            common: {
                name: "Json Sendungen",
                write: false,
                read: true,
                type: "string",
                role: "json",
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("dhl.briefe.json", {
            type: "state",
            common: {
                name: "Json Briefe",
                write: false,
                read: true,
                type: "string",
                role: "json",
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
    // getCodeChallenge() {
    //     let hash = "";
    //     let result = "";
    //     const chars = "0123456789abcdef";
    //     result = "";
    //     for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    //     hash = crypto.createHash("sha256").update(result).digest("base64");
    //     hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    //     return [result, hash];
    // }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
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
                if (id.split(".")[2] === "refresh") {
                    this.updateProvider();
                    return;
                }
                if (id.split(".")[2] === "17t") {
                    if (!this.config["17trackKey"]) {
                        this.log.error("Missing 17Track Security Key");
                        return;
                    }
                    const command = id.split(".")[3];
                    await this.requestClient({
                        method: "post",
                        url: "https://api.17track.net/track/v1/" + command,
                        headers: {
                            "17token": this.config["17trackKey"],
                            "Content-Type": "application/json",
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
                                method: "post",
                                url: "https://api.17track.net/track/v1/gettracklist",
                                headers: {
                                    "17token": this.config["17trackKey"],
                                    "Content-Type": "application/json",
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
                                        this.setState("17t.trackList", JSON.stringify(trackArray), true);
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
                if (id.split(".")[2] === "17tuser") {
                    await this.requestClient({
                        method: "post",
                        url: "https://buyer.17track.net/orderapi/call",
                        header: { "content-type": "application/x-www-form-urlencoded" },

                        data: JSON.stringify({ version: "1.0", timeZoneOffset: -60, method: "AddTrackNo", param: { TrackNos: [state.val] } }),
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
                if (id.indexOf("dhl.briefe") !== -1 && id.indexOf("image_url") !== -1 && id.indexOf("oldAdvices") === -1) {
                    let imageBase64 = this.images[state.val];
                    if (!imageBase64) {
                        const image = await this.requestClient({
                            method: "get",
                            url: state.val,
                            responseType: "arraybuffer",
                            jar: this.cookieJar,
                            withCredentials: true,
                        }).catch((error) => {
                            if (error.response && error.response.status === 401) {
                                this.log.debug(error);
                                return;
                            }
                            this.log.error(state.val + " " + error);
                        });
                        if (!image) {
                            this.log.debug("No image received for " + state.val);
                            return;
                        }
                        const imageBuffer = Buffer.from(image.data, "binary");
                        imageBase64 = "data:" + image.headers["content-type"] + ";base64, " + imageBuffer.toString("base64");
                        this.images[state.val] = imageBase64;
                        if (this.config.sendToActive) {
                            if (this.config.noFirstStartSend && this.firstStart) {
                                return;
                            }
                            const uuid = uuidv4();
                            fs.writeFileSync(`${this.tmpDir}${sep}${uuid}.jpg`, imageBuffer.toString("base64"), "base64");
                            const sendInstances = this.config.sendToInstance.replace(/ /g, "").split(",");
                            const sendUser = this.config.sendToUser.replace(/ /g, "").split(",");

                            for (const sendInstance of sendInstances) {
                                if (sendInstance.includes("pushover")) {
                                    await this.sendToAsync(sendInstance, { file: `${this.tmpDir}${sep}${uuid}.jpg`, title: "✉️Briefankündigung" });
                                } else {
                                    if (sendUser.length > 0) {
                                        for (const user of sendUser) {
                                            await this.sendToAsync(sendInstance, { user: user, text: "✉️Briefankündigung" });
                                            await this.sendToAsync(sendInstance, { user: user, text: `${this.tmpDir}${sep}${uuid}.jpg` });
                                        }
                                    } else {
                                        await this.sendToAsync(sendInstance, "✉️Briefankündigung");
                                        await this.sendToAsync(sendInstance, `${this.tmpDir}${sep}${uuid}.jpg`);
                                    }
                                }
                                fs.unlinkSync(`${this.tmpDir}${sep}${uuid}.jpg`);
                            }
                        }
                    }
                    const pathArray = id.split(".");
                    pathArray.pop();
                    pathArray.push("image");
                    await this.setObjectNotExistsAsync(pathArray.join("."), {
                        type: "state",
                        common: {
                            name: "Image",
                            write: false,
                            read: true,
                            type: "string",
                            role: "state",
                        },
                        native: {},
                    });

                    this.setState(pathArray.join("."), imageBase64, true);
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
