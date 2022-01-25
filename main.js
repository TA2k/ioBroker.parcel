"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const Json2iob = require("./lib/json2iob");
const tough = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent");

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
        this.requestClient = axios.create({
            jar: this.cookieJar,
            withCredentials: true,
            httpsAgent: new HttpsCookieAgent({
                jar: this.cookieJar,
            }),
        });

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.subscribeStates("*");

        if (this.config.dhlusername && this.config.dhlpassword) {
            this.log.info("Login to DHL");
            await this.loginDHL();
        }

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
                    await this.setObjectNotExistsAsync("dhl", {
                        type: "device",
                        common: {
                            name: "DHL Tracking",
                        },
                        native: {},
                    });
                    this.setState("auth.mfaToken", res.data.intermediateMfaToken, true);
                    this.log.warn("Please enter SMS/Mail code in instance settings and press save");
                })
                .catch((error) => {
                    this.log.error(error);
                    if (error.response) {
                        if (error.response.status === 409) {
                            this.log.error("Too many MFA requests, please try in 10min again");
                        }
                        this.log.error(JSON.stringify(error.response.data));
                    }
                });
        } else {
            this.log.info("Login to DHL with MFA token");
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
                    context: "web",
                    meta: "",
                    intermediateMfaToken: mfaToken,
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    this.sessions["dhl"] = res.data;
                    this.setState("info.connection", true, true);
                    await this.setObjectNotExistsAsync("dhl", {
                        type: "device",
                        common: {
                            name: "DHL Tracking",
                        },
                        native: {},
                    });
                })
                .catch(async (error) => {
                    this.log.error(error);
                    if (error.response) {
                        this.log.error(JSON.stringify(error.response.data));
                        await this.setStateAsync("auth.mfaToken", "", true);
                        this.log.error("Wrong code please restart adapter and try again");
                    }
                });
        }
    }

    async updateProvider() {
        const statusArrays = {
            dhl: [
                {
                    path: ".dhl",
                    url: "https://www.dhl.de/int-verfolgen/data/search?merge=false&noRedirect=true&language=de&cid=app",
                    header: {
                        accept: "application/json",
                        "content-type": "application/json",
                        "verfolgen-csrf-token": "363d8052-1cb4-43c8-840c-e15e65ebba55",
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                        referer: "https://www.dhl.de/int-webapp/spa/prod/ver4-SPA-VERFOLGEN.html?adobe_mc=TS%3D1643039135%7CMCORGID%3D3505782352FCE66F0A490D4C%40AdobeOrg",
                        "accept-language": "de-de",
                    },
                },
            ],
        };

        for (const id of Object.keys(this.sessions)) {
            for (const element of statusArrays[id]) {
                await this.requestClient({
                    method: "get",
                    url: element.url,
                    headers: element.header,
                    jar: this.cookieJar,
                    withCredentials: true,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        const data = res.data;

                        const forceIndex = null;
                        const preferedArrayName = null;

                        this.json2iob.parse(element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName });
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                if (!this.refreshTokenTimeout) {
                                    this.refreshTokenTimeout = setTimeout(() => {
                                        this.refreshTokenTimeout = null;
                                        this.refreshToken(id);
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
    async refreshToken(id) {
        if (this.sessions[id]) {
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
                        Host: "www.dhl.de",
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
                        this.sessions["id"] = res.data;
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
        }
    }

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
                if (id.split(".")[2] !== "refresh") {
                    this.updateProvider();
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
