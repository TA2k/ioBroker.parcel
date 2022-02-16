"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent");
const { JSDOM } = require("jsdom");

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
        this.mergedJsonObject = {};
        this.images = {};
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

        if (this.config["17trackKey"]) {
            this.sessions["17track"] = this.config["17trackKey"];
            this.setState("info.connection", true, true);
        }
        if (this.config.amzusername && this.config.amzpassword) {
            await this.loginAmz();
        }
        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.subscribeStates("*");

        if (Object.keys(this.sessions).length > 0) {
            await this.updateProvider();
            this.updateInterval = setInterval(async () => {
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

    async loginAmz() {
        const body = await this.requestClient({
            method: "get",
            url: "https://www.amazon.de/ap/signin?openid.return_to=https://www.amazon.de/ap/maplanding&openid.oa2.code_challenge_method=S256&openid.assoc_handle=amzn_mshop_ios_v2_de&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&pageId=amzn_mshop_ios_v2_de&accountStatusPolicy=P1&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select&openid.mode=checkid_setup&openid.ns.oa2=http://www.amazon.com/ap/ext/oauth/2&openid.oa2.client_id=device:32467234687368746238704723437432432&openid.oa2.code_challenge=IeFTKnKcmHEPij50cdHHCq6ZVMbFYJMQQtbrMvKbgz0&openid.ns.pape=http://specs.openid.net/extensions/pape/1.0&openid.oa2.scope=device_auth_access&openid.ns=http://specs.openid.net/auth/2.0&openid.pape.max_auth_age=0&openid.oa2.response_type=code",
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
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
        const form = this.extractHidden(body);
        form.email = this.config.amzusername;
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
                            this.log.error("Login to Amazon failed, please login to Amazon and check your credentials");
                            this.setState("info.connection", false, true);
                        })
                        .catch(async (error) => {
                            if (error.response) {
                                if (error.response.status === 404) {
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
                                this.setState("info.connection", false, true);
                                this.log.error(JSON.stringify(error.response.data));
                            }

                            this.log.error(error);
                        });
                    return;
                }
                if (res.data.indexOf("Amazon Anmelden") !== -1) {
                    this.log.error("Login to Amazon failed, please login to Amazon and check your credentials");
                    return;
                }
                if (res.data.indexOf("Zurücksetzen des Passworts erforderlich") !== -1) {
                    this.log.error("Zurücksetzen des Passworts erforderlich");
                    return;
                }
                this.log.error("Login to Amazon failed, please login to Amazon and check your credentials");
                this.setState("info.connection", false, true);
                return;
            })
            .catch(async (error) => {
                if (error.response) {
                    if (error.response.status === 404) {
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
                    this.setState("info.connection", false, true);
                    this.log.error(JSON.stringify(error.response.data));
                }

                this.log.error(error);
            });
    }
    async loginDPD() {
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
                    this.log.warn("Login to DPD failed");
                    return;
                }
            })
            .catch(async (error) => {
                if (error.response) {
                    if (error.response.status === 302) {
                        this.dpdToken = error.response.headers.location.split("=")[1];
                        this.log.info("Login to DPD successful");
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
    }

    async login17T() {
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
                    this.log.error(res.data.Message);
                    return;
                }
                this.log.info("Login to 17T successful");
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
            this.getAmazonPackages();
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
                    url: "https://my.dpd.de/myParcel.aspx?dpd_token=" + this.dpdToken,
                    header: {
                        accept: "*/*",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        "accept-language": "de-de",
                    },
                },
            ],
        };

        for (const id of Object.keys(this.sessions)) {
            for (const element of statusArrays[id]) {
                this.log.debug(element.url);
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
                        //filter archive message
                        if (element.path === "dhl.briefe" && res.data.grantToken) {
                            await this.activateToken(res.data.grantToken, res.data.accessTokenUrl);
                        }
                        await this.cleanupProvider(id, data);
                        this.mergeProviderJson(id, data);
                        this.json2iob.parse(element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName });
                        this.setState(element.path + ".json", JSON.stringify(data), true);
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
                        }
                        this.log.error(element.url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
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
        if ((id === "dhl" || id === "dpd" || id === "amz") && data && data.sendungen) {
            const states = await this.getStatesAsync(id + ".sendungen*.id");
            const sendungsArray = data.sendungen.map((sendung) => {
                return sendung.id;
            });
            for (const sendungsIdKey in states) {
                const index = Object.keys(states).indexOf(sendungsIdKey);
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
    async mergeProviderJson(id, data) {
        this.log.debug(id + " merge provider json");
        if (id === "dhl" && data.sendungen) {
            const sendungsArray = data.sendungen.map((sendung) => {
                let status = "";

                if (sendung.sendungsdetails && sendung.sendungsdetails.sendungsverlauf && sendung.sendungsdetails.sendungsverlauf.kurzStatus) {
                    status = sendung.sendungsdetails.sendungsverlauf.kurzStatus;
                }
                const sendungsObject = { id: sendung.id, name: sendung.sendungsinfo.sendungsname, status: status, source: "DHL", direction: sendung.sendungsinfo.sendungsrichtung };
                this.mergedJsonObject[sendung.id] = sendungsObject;
                return sendungsObject;
            });
            this.mergedJson = this.mergedJson.concat(sendungsArray);
        }

        if (id === "dpd" && data && data.sendungen) {
            for (const sendung of data.sendungen) {
                sendung.source = "DPD";
                this.mergedJsonObject[sendung.id] = sendung;
            }
            this.mergedJson = this.mergedJson.concat(data.sendungen);
        }
        if (id === "amz" && data && data.sendungen) {
            for (const sendung of data.sendungen) {
                sendung.source = "AMZ";
                this.mergedJsonObject[sendung.id] = sendung;
            }
            this.mergedJson = this.mergedJson.concat(data.sendungen);
        }
        if (id === "17track" && data.accepted) {
            const sendungsArray = data.accepted.map((sendung) => {
                const sendungsObject = { id: sendung.number, name: sendung.number, status: sendung.track.z0 ? sendung.track.z0.z : "", source: "17track" };
                if (!this.mergedJsonObject[sendung.id]) {
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
                        this.mergedJsonObject[sendung.id] = sendungsObject;
                    }
                    return sendungsObject;
                } catch (error) {
                    this.log.error(error);
                }
            });
            this.mergedJson = this.mergedJson.concat(sendungsArray);
        }

        this.setState("allProviderJson", JSON.stringify(this.mergedJson), true);
        this.setState("allProviderObjects", JSON.stringify(this.mergedJsonObject), true);
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
            this.log.debug("No parcelList found");
            return;
        }
        parcelList.querySelectorAll(".btnSelectParcel").forEach((parcel) => {
            const parcelInfo = parcel.firstElementChild;
            result.sendungen.push({
                id: parcelInfo.querySelector(".parcelNo").textContent,
                name: parcelInfo.querySelector(".parcelName").textContent,
                status: parcelInfo.querySelector(".parcelDeliveryStatus").textContent,
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
                    let status = statusHandle ? statusHandle.textContent.replace(/\n */g, "") : "";
                    if (!status) {
                        status = additionalStatus;
                    }
                    if (additionalStatus && status !== additionalStatus) {
                        status = status + " " + additionalStatus;
                    }
                    if (secondaryStatus) {
                        status = status + " " + secondaryStatus;
                    }

                    return {
                        id: document.querySelector(".carrierRelatedInfo-trackingId-text")
                            ? document.querySelector(".carrierRelatedInfo-trackingId-text").textContent.replace("Trackingnummer ", "")
                            : "",
                        name: document.querySelector(".carrierRelatedInfo-mfn-providerTitle") ? document.querySelector(".carrierRelatedInfo-mfn-providerTitle").textContent.replace(/\\n */g, "") : "",
                        status: status,
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
                this.loginDPD();
            }
            if (id === "17tuser") {
                this.login17T();
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
                if (id.indexOf("dhl.briefe") !== -1 && id.indexOf("image_url") !== -1) {
                    let imageBase64 = this.images[state.val];
                    if (!imageBase64) {
                        const image = await this.requestClient({
                            method: "get",
                            url: state.val,
                            responseType: "arraybuffer",
                            jar: this.cookieJar,
                            withCredentials: true,
                        }).catch((error) => {
                            this.log.error(state.val + " " + error);
                        });
                        if (!image) {
                            this.log.debug("No image received for " + state.val);
                            return;
                        }
                        const imageBuffer = Buffer.from(image.data, "binary");
                        imageBase64 = "data:" + image.headers["content-type"] + ";base64, " + imageBuffer.toString("base64");
                        this.images[state.val] = imageBase64;
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
