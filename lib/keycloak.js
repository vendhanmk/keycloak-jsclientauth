// @ts-check
/**
 * @import {KeycloakAccountOptions, KeycloakInitOptions, KeycloakLoginOptions, KeycloakLogoutOptions, KeycloakProfile, KeycloakRegisterOptions} from "./keycloak.d.ts"
 */
/*
 * Copyright 2016 Red Hat, Inc. and/or its affiliates
 * and other contributors as indicated by the @author tags.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const CONTENT_TYPE_JSON = 'application/json';

function Keycloak (config) {
    if (!(this instanceof Keycloak)) {
        throw new Error("The 'Keycloak' constructor must be invoked with 'new'.")
    }

    if (typeof config !== 'string' && !isObject(config)) {
        throw new Error("The 'Keycloak' constructor must be provided with a configuration object, or a URL to a JSON configuration file.");
    }

    if (isObject(config)) {
        const requiredProperties = 'oidcProvider' in config
            ? ['clientId']
            : ['url', 'realm', 'clientId','secret'];

        for (const property of requiredProperties) {
            if (!config[property]) {
                throw new Error(`The configuration object is missing the required '${property}' property.`);
            }
        }
    }

    var kc = this;
    var adapter;
    var refreshQueue = [];
    var callbackStorage;

    var loginIframe = {
        enable: true,
        callbackList: [],
        interval: 5
    };

    kc.didInitialize = false;

    var useNonce = true;
    var logInfo = createLogger(console.info);
    var logWarn = createLogger(console.warn);

    if (!globalThis.isSecureContext) {
        logWarn(
            "[KEYCLOAK] Keycloak JS must be used in a 'secure context' to function properly as it relies on browser APIs that are otherwise not available.\n" +
            "Continuing to run your application insecurely will lead to unexpected behavior and breakage.\n\n" +
            "For more information see: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts"
        );
    }

    /**
     * @param {KeycloakInitOptions} initOptions 
     * @returns {Promise<boolean>}
     */
    kc.init = async function (initOptions = {}) {
        if (kc.didInitialize) {
            throw new Error("A 'Keycloak' instance can only be initialized once.");
        }

        kc.didInitialize = true;

        kc.authenticated = false;

        callbackStorage = createCallbackStorage();
        var adapters = ['default', 'cordova', 'cordova-native'];

        if (adapters.indexOf(initOptions.adapter) > -1) {
            adapter = loadAdapter(initOptions.adapter);
        } else if (typeof initOptions.adapter === "object") {
            adapter = initOptions.adapter;
        } else {
            if (window.Cordova || window.cordova) {
                adapter = loadAdapter('cordova');
            } else {
                adapter = loadAdapter();
            }
        }

        if (typeof initOptions.useNonce !== 'undefined') {
            useNonce = initOptions.useNonce;
        }

        if (typeof initOptions.checkLoginIframe !== 'undefined') {
            loginIframe.enable = initOptions.checkLoginIframe;
        }

        if (initOptions.checkLoginIframeInterval) {
            loginIframe.interval = initOptions.checkLoginIframeInterval;
        }

        if (initOptions.onLoad === 'login-required') {
            kc.loginRequired = true;
        }

        if (initOptions.responseMode) {
            if (initOptions.responseMode === 'query' || initOptions.responseMode === 'fragment') {
                kc.responseMode = initOptions.responseMode;
            } else {
                throw 'Invalid value for responseMode';
            }
        }

        if (initOptions.flow) {
            switch (initOptions.flow) {
                case 'standard':
                    kc.responseType = 'code';
                    break;
                case 'implicit':
                    kc.responseType = 'id_token token';
                    break;
                case 'hybrid':
                    kc.responseType = 'code id_token token';
                    break;
                default:
                    throw 'Invalid value for flow';
            }
            kc.flow = initOptions.flow;
        }

        if (initOptions.timeSkew != null) {
            kc.timeSkew = initOptions.timeSkew;
        }

        if(initOptions.redirectUri) {
            kc.redirectUri = initOptions.redirectUri;
        }

        if (initOptions.silentCheckSsoRedirectUri) {
            kc.silentCheckSsoRedirectUri = initOptions.silentCheckSsoRedirectUri;
        }

        if (typeof initOptions.silentCheckSsoFallback === 'boolean') {
            kc.silentCheckSsoFallback = initOptions.silentCheckSsoFallback;
        } else {
            kc.silentCheckSsoFallback = true;
        }

        if (typeof initOptions.pkceMethod !== "undefined") {
            if (initOptions.pkceMethod !== "S256" && initOptions.pkceMethod !== false) {
                throw new TypeError(`Invalid value for pkceMethod', expected 'S256' or false but got ${initOptions.pkceMethod}.`);
            }

            kc.pkceMethod = initOptions.pkceMethod;
        } else {
            kc.pkceMethod = "S256";
        }

        if (typeof initOptions.enableLogging === 'boolean') {
            kc.enableLogging = initOptions.enableLogging;
        } else {
            kc.enableLogging = false;
        }

        if (initOptions.logoutMethod === 'POST') {
            kc.logoutMethod = 'POST';
        } else {
            kc.logoutMethod = 'GET';
        }

        if (typeof initOptions.scope === 'string') {
            kc.scope = initOptions.scope;
        }

        if (typeof initOptions.messageReceiveTimeout === 'number' && initOptions.messageReceiveTimeout > 0) {
            kc.messageReceiveTimeout = initOptions.messageReceiveTimeout;
        } else {
            kc.messageReceiveTimeout = 10000;
        }

        if (!kc.responseMode) {
            kc.responseMode = 'fragment';
        }
        if (!kc.responseType) {
            kc.responseType = 'code';
            kc.flow = 'standard';
        }

        async function onLoad() {
            async function doLogin(prompt) {
                const options = {};

                if (!prompt) {
                    options.prompt = 'none';
                }

                if (initOptions.locale) {
                    options.locale = initOptions.locale;
                }

                await kc.login(options);
            }

             async function checkSsoSilently() {
                const iframe = document.createElement("iframe");
                const src = await kc.createLoginUrl({ prompt: 'none', redirectUri: kc.silentCheckSsoRedirectUri });
                iframe.setAttribute("src", src);
                iframe.setAttribute("sandbox", "allow-storage-access-by-user-activation allow-scripts allow-same-origin");
                iframe.setAttribute("title", "keycloak-silent-check-sso");
                iframe.style.display = "none";
                document.body.appendChild(iframe);


                return await new Promise((resolve, reject) => {
                    async function messageCallback(event) {
                        if (event.origin !== window.location.origin || iframe.contentWindow !== event.source) {
                            return;
                        }

                        const oauth = parseCallback(event.data);

                        try {
                            await processCallback(oauth);
                            resolve()
                        } catch (error) {
                            reject(error);
                        }

                        document.body.removeChild(iframe);
                        window.removeEventListener("message", messageCallback);
                    };

                    window.addEventListener("message", messageCallback);
                });
            };

            switch (initOptions.onLoad) {
                case 'check-sso':
                    if (loginIframe.enable) {
                        await setupCheckLoginIframe();
                        const unchanged = await checkLoginIframe();

                        if (!unchanged) {
                            kc.silentCheckSsoRedirectUri ? await checkSsoSilently() : await doLogin(false);
                        }
                    } else {
                        kc.silentCheckSsoRedirectUri ? await checkSsoSilently() : await doLogin(false);
                    }
                    break;
                case 'login-required':
                    await doLogin(true);
                    break;
                default:
                    throw 'Invalid value for onLoad';
            }
        }

        async function processInit() {
            const callback = parseCallback(window.location.href);

            if (callback) {
                window.history.replaceState(window.history.state, null, callback.newUrl);
            }

            if (callback && callback.valid) {
                await setupCheckLoginIframe();
                await processCallback(callback);
                return;
            }

            if (initOptions.token && initOptions.refreshToken) {
                setToken(initOptions.token, initOptions.refreshToken, initOptions.idToken);

                if (loginIframe.enable) {
                    await setupCheckLoginIframe();
                    const unchanged = await checkLoginIframe();

                    if (unchanged) {
                        kc.onAuthSuccess && kc.onAuthSuccess();
                        scheduleCheckIframe();
                    }
                } else {
                    try {
                        await kc.updateToken(-1);
                        kc.onAuthSuccess && kc.onAuthSuccess();
                    } catch (error) {
                        kc.onAuthError && kc.onAuthError();
                        if (initOptions.onLoad) {
                            await onLoad();
                        } else {
                            throw error;
                        }
                    }
                }
            } else if (initOptions.onLoad) {
                await onLoad();
            }
        }

        await loadConfig();
        await check3pCookiesSupported()
        await processInit();
        kc.onReady && kc.onReady(kc.authenticated);
        return kc.authenticated;
    }

    kc.login = function (options) {
        return adapter.login(options);
    }

    function generateRandomData(len) {
        if (typeof crypto === "undefined" || typeof crypto.getRandomValues === "undefined") {
            throw new Error("Web Crypto API is not available.");
        }

        return crypto.getRandomValues(new Uint8Array(len));
    }

    function generateCodeVerifier(len) {
        return generateRandomString(len, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    }

    function generateRandomString(len, alphabet){
        var randomData = generateRandomData(len);
        var chars = new Array(len);
        for (var i = 0; i < len; i++) {
            chars[i] = alphabet.charCodeAt(randomData[i] % alphabet.length);
        }
        return String.fromCharCode.apply(null, chars);
    }

    async function generatePkceChallenge(pkceMethod, codeVerifier) {
        if (pkceMethod !== "S256") {
            throw new TypeError(`Invalid value for 'pkceMethod', expected 'S256' but got '${pkceMethod}'.`);
        }

        // hash codeVerifier, then encode as url-safe base64 without padding
        const hashBytes = new Uint8Array(await sha256Digest(codeVerifier));
        const encodedHash = bytesToBase64(hashBytes)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');

        return encodedHash;
    }

    function buildClaimsParameter(requestedAcr){
        var claims = {
            id_token: {
                acr: requestedAcr
            }
        }
        return JSON.stringify(claims);
    }

    /**
     * @param {KeycloakLoginOptions} [options]
     * @returns {Promise<string>}
     */
    kc.createLoginUrl = async function(options) {
        const state = createUUID();
        const nonce = createUUID();
        const redirectUri = adapter.redirectUri(options);
        const callbackState = {
            state,
            nonce,
            redirectUri: encodeURIComponent(redirectUri),
            loginOptions: options
        };

        if (options?.prompt) {
            callbackState.prompt = options.prompt;
        }

        const url = options?.action === 'register'
            ? kc.endpoints.register()
            : kc.endpoints.authorize();

        let scope = options?.scope || kc.scope;
        const scopeValues = scope ? scope.split(' ') : [];

        // Ensure the 'openid' scope is always included.
        if (!scopeValues.includes('openid')) {
            scopeValues.unshift('openid');
        }

        scope = scopeValues.join(' ');

        const params = new URLSearchParams([
            ['client_id', kc.clientId],
            ['redirect_uri', redirectUri],
            ['state', state],
            ['response_mode', kc.responseMode],
            ['response_type', kc.responseType],
            ['scope', scope]
        ]);

        if (useNonce) {
            params.append('nonce', nonce);
        }

        if (options?.prompt) {
            params.append('prompt', options.prompt);
        }

        if (typeof options?.maxAge === 'number') {
            params.append('max_age', options.maxAge.toString());
        }

        if (options?.loginHint) {
            params.append('login_hint', options.loginHint);
        }

        if (options?.idpHint) {
            params.append('kc_idp_hint', options.idpHint);
        }

        if (options?.action && options.action !== 'register') {
            params.append('kc_action', options.action);
        }

        if (options?.locale) {
            params.append('ui_locales', options.locale);
        }

        if (options?.acr) {
            params.append('claims', buildClaimsParameter(options.acr));
        }

        if (options?.acrValues) {
            params.append('acr_values', options.acrValues);
        }

        if (kc.pkceMethod) {
            try {
                const codeVerifier = generateCodeVerifier(96);
                const pkceChallenge = await generatePkceChallenge(kc.pkceMethod, codeVerifier);

                callbackState.pkceCodeVerifier = codeVerifier;

                params.append('code_challenge', pkceChallenge);
                params.append('code_challenge_method', kc.pkceMethod);
            } catch (error) {
                throw new Error("Failed to generate PKCE challenge.", { cause: error });
            }
        }

        callbackStorage.add(callbackState);

        return `${url}?${params.toString()}`;
    }

    kc.logout = function(options) {
        return adapter.logout(options);
    }

    /**
     * @param {KeycloakLogoutOptions} [options]
     * @returns {string}
     */
    kc.createLogoutUrl = function(options) {
        const logoutMethod = options?.logoutMethod ?? kc.logoutMethod;
        const url = kc.endpoints.logout();

        if (logoutMethod === 'POST') {
            return url;
        }

        const params = new URLSearchParams([
            ['client_id', kc.clientId],
            ['post_logout_redirect_uri', adapter.redirectUri(options)]
        ]);

        if (kc.idToken) {
            params.append('id_token_hint', kc.idToken);
        }

        return `${url}?${params.toString()}`;
    }

    kc.register = function (options) {
        return adapter.register(options);
    }

    /**
     * @param {KeycloakRegisterOptions} [options]
     * @returns {Promise<string>}
     */
    kc.createRegisterUrl = async function(options) {
        return await kc.createLoginUrl({ ...options, action: 'register' });
    }

    /**
     * @param {KeycloakAccountOptions} [options]
     * @returns {string}
     */
    kc.createAccountUrl = function(options) {
        const url = getRealmUrl();

        if (!url) {
            throw new Error('Unable to create account URL, make sure the adapter is not configured using a generic OIDC provider.');
        }

        const params = new URLSearchParams([
            ['referrer', kc.clientId],
            ['referrer_uri', adapter.redirectUri(options)]
        ]);

        return `${url}/account?${params.toString()}`;
    }

    kc.accountManagement = function() {
        return adapter.accountManagement();
    }

    kc.hasRealmRole = function (role) {
        var access = kc.realmAccess;
        return !!access && access.roles.indexOf(role) >= 0;
    }

    kc.hasResourceRole = function(role, resource) {
        if (!kc.resourceAccess) {
            return false;
        }

        var access = kc.resourceAccess[resource || kc.clientId];
        return !!access && access.roles.indexOf(role) >= 0;
    }

    /**
     * @returns {Promise<KeycloakProfile>}
     */
    kc.loadUserProfile = async function() {
        const realmUrl = getRealmUrl();

        if (!realmUrl) {
            throw new Error('Unable to load user profile, make sure the adapter is not configured using a generic OIDC provider.');
        }

        const url = `${realmUrl}/account`;
        const profile = await fetchJSON(url, {
            headers: [buildAuthorizationHeader(kc.token)],
        })

        return (kc.profile = profile);
    }

    /**
     * @returns {Promise<{}>}
     */
    kc.loadUserInfo = async function() {
        const url = kc.endpoints.userinfo();
        const userInfo = await fetchJSON(url, {
            headers: [buildAuthorizationHeader(kc.token)],
        })

        return (kc.userInfo = userInfo);
    }

    kc.isTokenExpired = function(minValidity) {
        if (!kc.tokenParsed || (!kc.refreshToken && kc.flow !== 'implicit' )) {
            throw 'Not authenticated';
        }

        if (kc.timeSkew == null) {
            logInfo('[KEYCLOAK] Unable to determine if token is expired as timeskew is not set');
            return true;
        }

        var expiresIn = kc.tokenParsed['exp'] - Math.ceil(new Date().getTime() / 1000) + kc.timeSkew;
        if (minValidity) {
            if (isNaN(minValidity)) {
                throw 'Invalid minValidity';
            }
            expiresIn -= minValidity;
        }
        return expiresIn < 0;
    }

    kc.updateToken = async function(minValidity) {
        if (!kc.refreshToken) {
            throw new Error('Unable to update token, no refresh token available.');
        }

        minValidity = minValidity || 5;

        if (loginIframe.enable) {
            await checkLoginIframe();
        }
        
        let refreshToken = false;

        if (minValidity === -1) {
            refreshToken = true;
            logInfo('[KEYCLOAK] Refreshing token: forced refresh');
        } else if (!kc.tokenParsed || kc.isTokenExpired(minValidity)) {
            refreshToken = true;
            logInfo('[KEYCLOAK] Refreshing token: token expired');
        }

        if (!refreshToken) {
            return false;
        }

        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });

        refreshQueue.push({ resolve, reject });

        if (refreshQueue.length === 1) {
            const url = kc.endpoints.token();
            let timeLocal = new Date().getTime();

            try {
                const response = await fetchRefreshToken(url, kc.refreshToken, kc.clientId);
                logInfo('[KEYCLOAK] Token refreshed');

                timeLocal = (timeLocal + new Date().getTime()) / 2;

                setToken(response['access_token'], response['refresh_token'], response['id_token'], timeLocal);

                kc.onAuthRefreshSuccess && kc.onAuthRefreshSuccess();
                for (let p = refreshQueue.pop(); p != null; p = refreshQueue.pop()) {
                    p.resolve(true);
                }
            } catch (error) {
                logWarn('[KEYCLOAK] Failed to refresh token');

                if (error instanceof NetworkError && error.response.status === 400) {
                    kc.clearToken();
                }

                kc.onAuthRefreshError && kc.onAuthRefreshError();
                for (let p = refreshQueue.pop(); p != null; p = refreshQueue.pop()) {
                    p.reject(error);
                }
            }
        }

        return await promise;
    }

    kc.clearToken = function() {
        if (kc.token) {
            setToken(null, null, null);
            kc.onAuthLogout && kc.onAuthLogout();
            if (kc.loginRequired) {
                kc.login();
            }
        }
    }

    /**
     * @returns {string | undefined}
     */
    function getRealmUrl() {
        if (typeof kc.authServerUrl === 'undefined') {
            return;
        }

        return `${stripTrailingSlash(kc.authServerUrl)}/realms/${encodeURIComponent(kc.realm)}`;
    }

    async function processCallback(oauth) {
        const { code, error, prompt } = oauth;
        let timeLocal = new Date().getTime();

        if (oauth['kc_action_status']) {
            kc.onActionUpdate && kc.onActionUpdate(oauth['kc_action_status'], oauth['kc_action']);
        }

        if (error) {
            if (prompt !== 'none') {
                if (oauth.error_description && oauth.error_description === "authentication_expired") {
                    await kc.login(oauth.loginOptions);
                } else {
                    const errorData = { error, error_description: oauth.error_description };
                    kc.onAuthError && kc.onAuthError(errorData);
                    throw errorData;
                }
            }
            return;
        } else if ((kc.flow !== 'standard') && (oauth.access_token || oauth.id_token)) {
            authSuccess(oauth.access_token, null, oauth.id_token);
            kc.onAuthSuccess && kc.onAuthSuccess();
        }

        if ((kc.flow !== 'implicit') && code) {
            try {
                const response = await fetchAccessToken(kc.endpoints.token(), code, kc.clientId,config.secret, decodeURIComponent(oauth.redirectUri), oauth.pkceCodeVerifier)
                authSuccess(response['access_token'], response['refresh_token'], response['id_token']);

                if (kc.flow === 'standard') {
                    kc.onAuthSuccess && kc.onAuthSuccess();
                }

                scheduleCheckIframe();
            } catch (error) {
                kc.onAuthError && kc.onAuthError();
                throw error;
            }
        }

        function authSuccess(accessToken, refreshToken, idToken) {
            timeLocal = (timeLocal + new Date().getTime()) / 2;

            setToken(accessToken, refreshToken, idToken, timeLocal);

            if (useNonce && (kc.idTokenParsed && kc.idTokenParsed.nonce !== oauth.storedNonce)) {
                logInfo('[KEYCLOAK] Invalid nonce, clearing token');
                kc.clearToken();
                throw new Error('Invalid nonce.');
            }
        }

    }

    /**
     * @returns {Promise<void>}
     */
    async function loadConfig() {
        if (typeof config === 'string') {
            const jsonConfig = await fetchJsonConfig(config);
            kc.authServerUrl = jsonConfig['auth-server-url'];
            kc.realm = jsonConfig.realm;
            kc.clientId = jsonConfig.resource;
            setupEndpoints();
        } else {
            kc.clientId = config.clientId;

            if (config.oidcProvider) {
                await loadOidcConfig(config.oidcProvider)
            } else {
                kc.authServerUrl = config.url;
                kc.realm = config.realm;
                setupEndpoints();
            }
        }
    }

    /**
     * @param {string | OpenIdProviderMetadata} oidcProvider 
     * @returns {Promise<void>}
     */
    async function loadOidcConfig(oidcProvider) {
        if (typeof oidcProvider === 'string') {
            const url = `${stripTrailingSlash(oidcProvider)}/.well-known/openid-configuration`;
            const openIdConfig = await fetchOpenIdConfig(url)
            setupOidcEndpoints(openIdConfig);
        } else {
            setupOidcEndpoints(oidcProvider);
        }
    }

    /**
     * @returns {void}
     */
    function setupEndpoints() {
        kc.endpoints = {
            authorize() {
                return getRealmUrl() + '/protocol/openid-connect/auth';
            },
            token() {
                return getRealmUrl() + '/protocol/openid-connect/token';
            },
            logout() {
                return getRealmUrl() + '/protocol/openid-connect/logout';
            },
            checkSessionIframe() {
                return getRealmUrl() + '/protocol/openid-connect/login-status-iframe.html';
            },
            thirdPartyCookiesIframe() {
                return getRealmUrl() + '/protocol/openid-connect/3p-cookies/step1.html';
            },
            register() {
                return getRealmUrl() + '/protocol/openid-connect/registrations';
            },
            userinfo() {
                return getRealmUrl() + '/protocol/openid-connect/userinfo';
            }
        };
    }

    /**
     * @param {OpenIdProviderMetadata} config
     * @returns {void}
     */
    function setupOidcEndpoints(config) {
        kc.endpoints = {
            authorize() {
                return config.authorization_endpoint;
            },
            token() {
                return config.token_endpoint;
            },
            logout() {
                if (!config.end_session_endpoint) {
                    throw "Not supported by the OIDC server";
                }
                return config.end_session_endpoint;
            },
            checkSessionIframe() {
                if (!config.check_session_iframe) {
                    throw "Not supported by the OIDC server";
                }
                return config.check_session_iframe;
            },
            register() {
                throw 'Redirection to "Register user" page not supported in standard OIDC mode';
            },
            userinfo() {
                if (!config.userinfo_endpoint) {
                    throw "Not supported by the OIDC server";
                }
                return config.userinfo_endpoint;
            }
        }
    }

    function setToken(token, refreshToken, idToken, timeLocal) {
        if (kc.tokenTimeoutHandle) {
            clearTimeout(kc.tokenTimeoutHandle);
            kc.tokenTimeoutHandle = null;
        }

        if (refreshToken) {
            kc.refreshToken = refreshToken;
            kc.refreshTokenParsed = decodeToken(refreshToken);
        } else {
            delete kc.refreshToken;
            delete kc.refreshTokenParsed;
        }

        if (idToken) {
            kc.idToken = idToken;
            kc.idTokenParsed = decodeToken(idToken);
        } else {
            delete kc.idToken;
            delete kc.idTokenParsed;
        }

        if (token) {
            kc.token = token;
            kc.tokenParsed = decodeToken(token);
            kc.sessionId = kc.tokenParsed.sid;
            kc.authenticated = true;
            kc.subject = kc.tokenParsed.sub;
            kc.realmAccess = kc.tokenParsed.realm_access;
            kc.resourceAccess = kc.tokenParsed.resource_access;

            if (timeLocal) {
                kc.timeSkew = Math.floor(timeLocal / 1000) - kc.tokenParsed.iat;
            }

            if (kc.timeSkew != null) {
                logInfo('[KEYCLOAK] Estimated time difference between browser and server is ' + kc.timeSkew + ' seconds');

                if (kc.onTokenExpired) {
                    var expiresIn = (kc.tokenParsed['exp'] - (new Date().getTime() / 1000) + kc.timeSkew) * 1000;
                    logInfo('[KEYCLOAK] Token expires in ' + Math.round(expiresIn / 1000) + ' s');
                    if (expiresIn <= 0) {
                        kc.onTokenExpired();
                    } else {
                        kc.tokenTimeoutHandle = setTimeout(kc.onTokenExpired, expiresIn);
                    }
                }
            }
        } else {
            delete kc.token;
            delete kc.tokenParsed;
            delete kc.subject;
            delete kc.realmAccess;
            delete kc.resourceAccess;

            kc.authenticated = false;
        }
    }

    function createUUID() {
        if (typeof crypto === "undefined" || typeof crypto.randomUUID === "undefined") {
            throw new Error("Web Crypto API is not available.");
        }

        return crypto.randomUUID();
    }

    function parseCallback(url) {
        var oauth = parseCallbackUrl(url);
        if (!oauth) {
            return;
        }

        var oauthState = callbackStorage.get(oauth.state);

        if (oauthState) {
            oauth.valid = true;
            oauth.redirectUri = oauthState.redirectUri;
            oauth.storedNonce = oauthState.nonce;
            oauth.prompt = oauthState.prompt;
            oauth.pkceCodeVerifier = oauthState.pkceCodeVerifier;
            oauth.loginOptions = oauthState.loginOptions;
        }

        return oauth;
    }

    function parseCallbackUrl(url) {
        var supportedParams;
        switch (kc.flow) {
            case 'standard':
                supportedParams = ['code', 'state', 'session_state', 'kc_action_status', 'kc_action', 'iss'];
                break;
            case 'implicit':
                supportedParams = ['access_token', 'token_type', 'id_token', 'state', 'session_state', 'expires_in', 'kc_action_status', 'kc_action', 'iss'];
                break;
            case 'hybrid':
                supportedParams = ['access_token', 'token_type', 'id_token', 'code', 'state', 'session_state', 'expires_in', 'kc_action_status', 'kc_action', 'iss'];
                break;
        }

        supportedParams.push('error');
        supportedParams.push('error_description');
        supportedParams.push('error_uri');

        var queryIndex = url.indexOf('?');
        var fragmentIndex = url.indexOf('#');

        var newUrl;
        var parsed;

        if (kc.responseMode === 'query' && queryIndex !== -1) {
            newUrl = url.substring(0, queryIndex);
            parsed = parseCallbackParams(url.substring(queryIndex + 1, fragmentIndex !== -1 ? fragmentIndex : url.length), supportedParams);
            if (parsed.paramsString !== '') {
                newUrl += '?' + parsed.paramsString;
            }
            if (fragmentIndex !== -1) {
                newUrl += url.substring(fragmentIndex);
            }
        } else if (kc.responseMode === 'fragment' && fragmentIndex !== -1) {
            newUrl = url.substring(0, fragmentIndex);
            parsed = parseCallbackParams(url.substring(fragmentIndex + 1), supportedParams);
            if (parsed.paramsString !== '') {
                newUrl += '#' + parsed.paramsString;
            }
        }

        if (parsed && parsed.oauthParams) {
            if (kc.flow === 'standard' || kc.flow === 'hybrid') {
                if ((parsed.oauthParams.code || parsed.oauthParams.error) && parsed.oauthParams.state) {
                    parsed.oauthParams.newUrl = newUrl;
                    return parsed.oauthParams;
                }
            } else if (kc.flow === 'implicit') {
                if ((parsed.oauthParams.access_token || parsed.oauthParams.error) && parsed.oauthParams.state) {
                    parsed.oauthParams.newUrl = newUrl;
                    return parsed.oauthParams;
                }
            }
        }
    }

    function parseCallbackParams(paramsString, supportedParams) {
        var p = paramsString.split('&');
        var result = {
            paramsString: '',
            oauthParams: {}
        }
        for (var i = 0; i < p.length; i++) {
            var split = p[i].indexOf("=");
            var key = p[i].slice(0, split);
            if (supportedParams.indexOf(key) !== -1) {
                result.oauthParams[key] = p[i].slice(split + 1);
            } else {
                if (result.paramsString !== '') {
                    result.paramsString += '&';
                }
                result.paramsString += p[i];
            }
        }
        return result;
    }

    // Function to extend existing native Promise with timeout
    function applyTimeoutToPromise(promise, timeout, errorMessage) {
        var timeoutHandle = null;
        var timeoutPromise = new Promise(function (resolve, reject) {
            timeoutHandle = setTimeout(function () {
                reject({ "error": errorMessage || "Promise is not settled within timeout of " + timeout + "ms" });
            }, timeout);
        });

        return Promise.race([promise, timeoutPromise]).finally(function () {
            clearTimeout(timeoutHandle);
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async function setupCheckLoginIframe() {
        if (!loginIframe.enable || loginIframe.iframe) {
            return
        }

        const iframe = document.createElement('iframe');
        loginIframe.iframe = iframe;
        iframe.setAttribute('src', kc.endpoints.checkSessionIframe());
        iframe.setAttribute('sandbox', 'allow-storage-access-by-user-activation allow-scripts allow-same-origin');
        iframe.setAttribute('title', 'keycloak-session-iframe' );
        iframe.style.display = 'none';
        document.body.appendChild(iframe);

        /**
         * @param {MessageEvent} event
         */
        const messageCallback = (event) => {
            if (event.origin !== loginIframe.iframeOrigin || loginIframe.iframe.contentWindow !== event.source) {
                return;
            }

            if (!(event.data === 'unchanged' || event.data === 'changed' || event.data === 'error')) {
                return;
            }

            if (event.data !== 'unchanged') {
                kc.clearToken();
            }

            const callbacks = loginIframe.callbackList;
            loginIframe.callbackList = [];

            for (const callback of callbacks.reverse()) {
                if (event.data === 'error') {
                    callback(new Error('Error while checking login iframe'));
                } else {
                    callback(null, event.data === 'unchanged');
                }
            }
        };

        window.addEventListener('message', messageCallback, false);

        await new Promise((resolve) => {
            iframe.addEventListener('load', () => {
                const authUrl = kc.endpoints.authorize();
                if (authUrl.startsWith('/')) {
                    loginIframe.iframeOrigin = location.origin;
                } else {
                    loginIframe.iframeOrigin = new URL(authUrl).origin;
                }
                resolve();
            });
        });
    }

    async function scheduleCheckIframe() {
        if (loginIframe.enable && kc.token) {
            await waitForTimeout(loginIframe.interval * 1000);
            const unchanged = await checkLoginIframe();

            if (unchanged) {
                await scheduleCheckIframe();
            }
        }
    }

    async function checkLoginIframe() {
        if (!loginIframe.iframe || !loginIframe.iframeOrigin) {
            return;
        }

        const message = `${kc.clientId} ${(kc.sessionId ? kc.sessionId : '')}`;
        const origin = loginIframe.iframeOrigin;

        return await new Promise(function(resolve, reject) {
            const callback = (error, result) => error ? reject(error) : resolve(result);

            loginIframe.callbackList.push(callback);

            if (loginIframe.callbackList.length === 1) {
                loginIframe.iframe.contentWindow.postMessage(message, origin);
            }
        });
    }

    async function check3pCookiesSupported() {
        if ((!loginIframe.enable && !kc.silentCheckSsoRedirectUri) || typeof kc.endpoints.thirdPartyCookiesIframe !== 'function') {
            return;
        }

        const iframe = document.createElement('iframe');
        iframe.setAttribute('src', kc.endpoints.thirdPartyCookiesIframe());
        iframe.setAttribute('sandbox', 'allow-storage-access-by-user-activation allow-scripts allow-same-origin');
        iframe.setAttribute('title', 'keycloak-3p-check-iframe' );
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        
        const promise = new Promise((resolve) => {
            const messageCallback = (event) => {
                if (iframe.contentWindow !== event.source) {
                    return;
                }

                if (event.data !== "supported" && event.data !== "unsupported") {
                    return;
                } else if (event.data === "unsupported") {
                    logWarn(
                        "[KEYCLOAK] Your browser is blocking access to 3rd-party cookies, this means:\n\n" +
                        " - It is not possible to retrieve tokens without redirecting to the Keycloak server (a.k.a. no support for silent authentication).\n" +
                        " - It is not possible to automatically detect changes to the session status (such as the user logging out in another tab).\n\n" +
                        "For more information see: https://www.keycloak.org/securing-apps/javascript-adapter#_modern_browsers"
                    );

                    loginIframe.enable = false;
                    if (kc.silentCheckSsoFallback) {
                        kc.silentCheckSsoRedirectUri = false;
                    }
                }

                document.body.removeChild(iframe);
                window.removeEventListener("message", messageCallback);
                resolve();
            };

            window.addEventListener('message', messageCallback, false);
        });

        return await applyTimeoutToPromise(promise, kc.messageReceiveTimeout, "Timeout when waiting for 3rd party check iframe message.");
    }

    function loadAdapter(type) {
        if (!type || type === 'default') {
            return {
                login: async function(options) {
                    window.location.assign(await kc.createLoginUrl(options));
                    return await new Promise(() => {});
                },

                logout: async function(options) {

                    const logoutMethod = options?.logoutMethod ?? kc.logoutMethod;
                    if (logoutMethod === "GET") {
                        window.location.replace(kc.createLogoutUrl(options));
                        return;
                    }

                    // Create form to send POST request.
                    const form = document.createElement("form");

                    form.setAttribute("method", "POST");
                    form.setAttribute("action", kc.createLogoutUrl(options));
                    form.style.display = "none";

                    // Add data to form as hidden input fields.
                    const data = {
                        id_token_hint: kc.idToken,
                        client_id: kc.clientId,
                        post_logout_redirect_uri: adapter.redirectUri(options)
                    };

                    for (const [name, value] of Object.entries(data)) {
                        const input = document.createElement("input");

                        input.setAttribute("type", "hidden");
                        input.setAttribute("name", name);
                        input.setAttribute("value", value);

                        form.appendChild(input);
                    }

                    // Append form to page and submit it to perform logout and redirect.
                    document.body.appendChild(form);
                    form.submit();
                },

                register: async function(options) {
                    window.location.assign(await kc.createRegisterUrl(options));
                    return await new Promise(() => {});
                },

                accountManagement : async function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        window.location.href = accountUrl;
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                    return await new Promise(() => {});
                },

                redirectUri: function(options) {
                    return options?.redirectUri || kc.redirectUri || location.href;
                }
            };
        }

        if (type === 'cordova') {
            loginIframe.enable = false;
            var cordovaOpenWindowWrapper = function(loginUrl, target, options) {
                if (window.cordova && window.cordova.InAppBrowser) {
                    // Use inappbrowser for IOS and Android if available
                    return window.cordova.InAppBrowser.open(loginUrl, target, options);
                } else {
                    return window.open(loginUrl, target, options);
                }
            };

            var shallowCloneCordovaOptions = function (userOptions) {
                if (userOptions && userOptions.cordovaOptions) {
                    return Object.keys(userOptions.cordovaOptions).reduce(function (options, optionName) {
                        options[optionName] = userOptions.cordovaOptions[optionName];
                        return options;
                    }, {});
                } else {
                    return {};
                }
            };

            var formatCordovaOptions = function (cordovaOptions) {
                return Object.keys(cordovaOptions).reduce(function (options, optionName) {
                    options.push(optionName+"="+cordovaOptions[optionName]);
                    return options;
                }, []).join(",");
            };

            var createCordovaOptions = function (userOptions) {
                var cordovaOptions = shallowCloneCordovaOptions(userOptions);
                cordovaOptions.location = 'no';
                if (userOptions && userOptions.prompt === 'none') {
                    cordovaOptions.hidden = 'yes';
                }
                return formatCordovaOptions(cordovaOptions);
            };

            var getCordovaRedirectUri = function() {
                return kc.redirectUri || 'http://localhost';
            }

            return {
                async login(options) {
                    const cordovaOptions = createCordovaOptions(options);
                    const loginUrl = await kc.createLoginUrl(options);
                    const ref = cordovaOpenWindowWrapper(loginUrl, '_blank', cordovaOptions);
                    let completed = false;
                    let closed = false;

                    function closeBrowser() {
                        closed = true;
                        ref.close();
                    };

                    return await new Promise((resolve, reject) => {
                        ref.addEventListener('loadstart', async (event) => {
                            if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                                const callback = parseCallback(event.url);

                                try {
                                    await processCallback(callback);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                                closeBrowser();
                                completed = true;
                            }
                        });

                        ref.addEventListener('loaderror', async (event) => {
                            if (!completed) {
                                if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                                    const callback = parseCallback(event.url);
                                    try {
                                        await processCallback(callback);
                                        resolve();
                                    } catch (error) {
                                        reject(error);
                                    }
                                    closeBrowser();
                                    completed = true;
                                } else {
                                    reject();
                                    closeBrowser();
                                }
                            }
                        });

                        ref.addEventListener('exit', function(event) {
                            if (!closed) {
                                reject({
                                    reason: "closed_by_user"
                                });
                            }
                        });
                    });
                },

                async logout(options) {
                    const logoutUrl = kc.createLogoutUrl(options);
                    const ref = cordovaOpenWindowWrapper(logoutUrl, '_blank', 'location=no,hidden=yes,clearcache=yes');
                    let error = false;

                    ref.addEventListener('loadstart', (event) => {
                        if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                            ref.close();
                        }
                    });

                    ref.addEventListener('loaderror', (event) => {
                        if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                            ref.close();
                        } else {
                            error = true;
                            ref.close();
                        }
                    });

                    await new Promise((resolve, reject) => {
                        ref.addEventListener('exit', () => {
                            if (error) {
                                reject();
                            } else {
                                kc.clearToken();
                                resolve();
                            }
                        });
                    });
                },

                async register(options) {
                    const registerUrl = await kc.createRegisterUrl();
                    const cordovaOptions = createCordovaOptions(options);
                    const ref = cordovaOpenWindowWrapper(registerUrl, '_blank', cordovaOptions);

                    await new Promise((resolve, reject) => {
                        ref.addEventListener('loadstart', async (event) => {
                            if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                                ref.close();
                                const oauth = parseCallback(event.url);

                                try {
                                    await processCallback(oauth);
                                    resolve();
                                } catch (error) {
                                    reject(error);
                                }
                            }
                        });
                    });
                },

                accountManagement : function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        var ref = cordovaOpenWindowWrapper(accountUrl, '_blank', 'location=no');
                        ref.addEventListener('loadstart', function(event) {
                            if (event.url.indexOf(getCordovaRedirectUri()) === 0) {
                                ref.close();
                            }
                        });
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                },

                redirectUri: function(options) {
                    return getCordovaRedirectUri();
                }
            }
        }

        if (type === 'cordova-native') {
            loginIframe.enable = false;

            return {
                async login(options) {
                    const loginUrl = await kc.createLoginUrl(options);

                    await new Promise((resolve, reject) => {
                        universalLinks.subscribe('keycloak', async (event) => {
                            universalLinks.unsubscribe('keycloak');
                            window.cordova.plugins.browsertab.close();
                            var oauth = parseCallback(event.url);
                            
                            try {
                                await processCallback(oauth);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        });
    
                        window.cordova.plugins.browsertab.openUrl(loginUrl);
                    });
                },

                async logout(options) {
                    const logoutUrl = kc.createLogoutUrl(options);

                    await new Promise((resolve) => {
                        universalLinks.subscribe('keycloak', () => {
                            universalLinks.unsubscribe('keycloak');
                            window.cordova.plugins.browsertab.close();
                            kc.clearToken();
                            resolve();
                        });
    
                        window.cordova.plugins.browsertab.openUrl(logoutUrl);
                    });
                },

                async register(options) {
                    const registerUrl = await kc.createRegisterUrl(options);

                    await new Promise((resolve, reject) => {
                        universalLinks.subscribe('keycloak' , async (event) => {
                            universalLinks.unsubscribe('keycloak');
                            window.cordova.plugins.browsertab.close();
                            const oauth = parseCallback(event.url);
                            try {
                                await processCallback(oauth);
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        });

                        window.cordova.plugins.browsertab.openUrl(registerUrl);
                    });
                },

                accountManagement : function() {
                    var accountUrl = kc.createAccountUrl();
                    if (typeof accountUrl !== 'undefined') {
                        window.cordova.plugins.browsertab.openUrl(accountUrl);
                    } else {
                        throw "Not supported by the OIDC server";
                    }
                },

                redirectUri: function(options) {
                    if (options && options.redirectUri) {
                        return options.redirectUri;
                    } else if (kc.redirectUri) {
                        return kc.redirectUri;
                    } else {
                        return "http://localhost";
                    }
                }
            }
        }

        throw 'invalid adapter type: ' + type;
    }

    const STORAGE_KEY_PREFIX = 'kc-callback-';

    var LocalStorage = function() {
        if (!(this instanceof LocalStorage)) {
            return new LocalStorage();
        }

        localStorage.setItem('kc-test', 'test');
        localStorage.removeItem('kc-test');

        var cs = this;

        /**
         * Clears all values from local storage that are no longer valid.
         */
        function clearInvalidValues() {
            const currentTime = Date.now();

            for (const [key, value] of getStoredEntries()) {
                // Attempt to parse the expiry time from the value.
                const expiry = parseExpiry(value);

                // Discard the value if it is malformed or expired.
                if (expiry === null || expiry < currentTime) {
                    localStorage.removeItem(key);
                }
            }
        }

        /**
         * Clears all known values from local storage.
         */
        function clearAllValues() {
            for (const [key] of getStoredEntries()) {
                localStorage.removeItem(key);
            }
        }

        /**
         * Gets all entries stored in local storage that are known to be managed by this class.
         * @returns {Array<[string, unknown]>} An array of key-value pairs.
         */
        function getStoredEntries() {
            return Object.entries(localStorage).filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX));
        }

        /**
         * Parses the expiry time from a value stored in local storage.
         * @param {unknown} value
         * @returns {number | null} The expiry time in milliseconds, or `null` if the value is malformed.
         */
        function parseExpiry(value) {
            let parsedValue;

            // Attempt to parse the value as JSON.
            try {
                parsedValue = JSON.parse(value);
            } catch (error) {
                return null;
            }

            // Attempt to extract the 'expires' property.
            if (isObject(parsedValue) && 'expires' in parsedValue && typeof parsedValue.expires === 'number') {
                return parsedValue.expires;
            }

            return null;
        }

        cs.get = function(state) {
            if (!state) {
                return;
            }

            var key = STORAGE_KEY_PREFIX + state;
            var value = localStorage.getItem(key);
            if (value) {
                localStorage.removeItem(key);
                value = JSON.parse(value);
            }

            clearInvalidValues();
            return value;
        };

        cs.add = function(state) {
            clearInvalidValues();

            const key = STORAGE_KEY_PREFIX + state.state;
            const value = JSON.stringify({
                ...state,
                // Set the expiry time to 1 hour from now.
                expires: Date.now() + (60 * 60 * 1000)
            });

            try {
                localStorage.setItem(key, value);
            } catch (error) {
                // If the storage is full, clear all known values and try again.
                clearAllValues();
                localStorage.setItem(key, value);
            }
        };
    };

    var CookieStorage = function() {
        if (!(this instanceof CookieStorage)) {
            return new CookieStorage();
        }

        var cs = this;

        cs.get = function(state) {
            if (!state) {
                return;
            }

            var value = getCookie(STORAGE_KEY_PREFIX + state);
            setCookie(STORAGE_KEY_PREFIX + state, '', cookieExpiration(-100));
            if (value) {
                return JSON.parse(value);
            }
        };

        cs.add = function(state) {
            setCookie(STORAGE_KEY_PREFIX + state.state, JSON.stringify(state), cookieExpiration(60));
        };

        cs.removeItem = function(key) {
            setCookie(key, '', cookieExpiration(-100));
        };

        var cookieExpiration = function (minutes) {
            var exp = new Date();
            exp.setTime(exp.getTime() + (minutes*60*1000));
            return exp;
        };

        var getCookie = function (key) {
            var name = key + '=';
            var ca = document.cookie.split(';');
            for (var i = 0; i < ca.length; i++) {
                var c = ca[i];
                while (c.charAt(0) === ' ') {
                    c = c.substring(1);
                }
                if (c.indexOf(name) === 0) {
                    return c.substring(name.length, c.length);
                }
            }
            return '';
        };

        var setCookie = function (key, value, expirationDate) {
            var cookie = key + '=' + value + '; '
                + 'expires=' + expirationDate.toUTCString() + '; ';
            document.cookie = cookie;
        }
    };

    function createCallbackStorage() {
        try {
            return new LocalStorage();
        } catch (err) {
        }

        return new CookieStorage();
    }

    function createLogger(fn) {
        return function() {
            if (kc.enableLogging) {
                fn.apply(console, Array.prototype.slice.call(arguments));
            }
        };
    }
}

export default Keycloak;

/**
 * @param {ArrayBuffer} bytes
 * @see https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem
 */
function bytesToBase64(bytes) {
    const binString = String.fromCodePoint(...bytes);
    return btoa(binString);
}

/**
 * @param {string} message
 * @see https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest#basic_example
 */
async function sha256Digest(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    if (typeof crypto === "undefined" || typeof crypto.subtle === "undefined") {
        throw new Error("Web Crypto API is not available.");
    }

    return await crypto.subtle.digest("SHA-256", data);
}

/**
 * @param {string} token
 */
function decodeToken(token) {
    const [header, payload] = token.split(".");

    if (typeof payload !== "string") {
        throw new Error("Unable to decode token, payload not found.");
    }

    let decoded;

    try {
        decoded = base64UrlDecode(payload);
    } catch (error) {
        throw new Error("Unable to decode token, payload is not a valid Base64URL value.", { cause: error });
    }

    try {
        return JSON.parse(decoded);
    } catch (error) {
        throw new Error("Unable to decode token, payload is not a valid JSON value.", { cause: error });
    }
}

/**
 * @param {string} input
 */
function base64UrlDecode(input) {
    let output = input
        .replaceAll("-", "+")
        .replaceAll("_", "/");

    switch (output.length % 4) {
        case 0:
            break;
        case 2:
            output += "==";
            break;
        case 3:
            output += "=";
            break;
        default:
            throw new Error("Input is not of the correct length.");
    }

    try {
        return b64DecodeUnicode(output);
    } catch (error) {
        return atob(output);
    }
}

/**
 * @param {string} input
 */
function b64DecodeUnicode(input) {
    return decodeURIComponent(atob(input).replace(/(.)/g, (m, p) => {
        let code = p.charCodeAt(0).toString(16).toUpperCase();

        if (code.length < 2) {
            code = "0" + code;
        }

        return "%" + code;
    }));
}

/**
 * Check if the input is an object that can be operated on.
 * @param {unknown} input
 */
function isObject(input) {
    return typeof input === 'object' && input !== null;
}

/**
 * @typedef {Object} JsonConfig The JSON version of the adapter configuration.
 * @property {string} auth-server-url The URL of the authentication server.
 * @property {string} realm The name of the realm.
 * @property {string} resource The name of the resource, usually the client ID.
 */

/**
 * Fetch the adapter configuration from the given URL.
 * @param {string} url 
 * @returns {Promise<JsonConfig>}
 */
async function fetchJsonConfig(url) {
    return await fetchJSON(url);
}

/**
 * @typedef {Object} OpenIdProviderMetadata The OpenID version of the adapter configuration, based on the {@link https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata OpenID Connect Discovery specification}.
 * @property {string} authorization_endpoint URL of the OP's OAuth 2.0 Authorization Endpoint.
 * @property {string} token_endpoint URL of the OP's OAuth 2.0 Token Endpoint.
 * @property {string} [userinfo_endpoint] URL of the OP's UserInfo Endpoint.
 * @property {string} [check_session_iframe] URL of an OP iframe that supports cross-origin communications for session state information with the RP Client, using the HTML5 postMessage API.
 * @property {string} [end_session_endpoint] URL at the OP to which an RP can perform a redirect to request that the End-User be logged out at the OP.
 */

/**
 * Fetch the OpenID configuration from the given URL.
 * @param {string} url 
 * @returns {Promise<OpenIdProviderMetadata>}
 */
async function fetchOpenIdConfig(url) {
    return await fetchJSON(url);
}

/**
 * @typedef {Object} AccessTokenResponse The successful token response from the authorization server, based on the {@link https://datatracker.ietf.org/doc/html/rfc6749#section-5.1 OAuth 2.0 Authorization Framework specification}.
 * @property {string} access_token The access token issued by the authorization server.
 * @property {string} token_type The type of the token issued by the authorization server.
 * @property {number} [expires_in] The lifetime in seconds of the access token.
 * @property {string} [refresh_token] The refresh token issued by the authorization server.
 * @property {string} [scope] The scope of the access token.
 */

/**
 * Fetch the access token from the given URL.
 * @param {string} url 
 * @param {string} code 
 * @param {string} clientId 
 * @param {string} redirectUri 
 * @param {string} [pkceCodeVerifier]
 * @returns {Promise<AccessTokenResponse>}
 */
async function fetchAccessToken(url, code, clientId,secret, redirectUri, pkceCodeVerifier) {
    const body = new URLSearchParams([
        ['code', code],
        ['grant_type', 'authorization_code'],
        ['client_secret',secret],
        ['client_id', clientId],
        ['redirect_uri', redirectUri]
    ]);

    if (pkceCodeVerifier) {
        body.append('code_verifier', pkceCodeVerifier);
    }

    return await fetchJSON(url, {
        method: 'POST',
        credentials: 'include',
        body,
    })
}

/**
 * Fetch the refresh token from the given URL.
 * @param {string} url 
 * @param {string} refreshToken 
 * @param {string} clientId
 * @returns {Promise<AccessTokenResponse>}
 */
async function fetchRefreshToken(url, refreshToken, clientId) {
    const body = new URLSearchParams([
        ['grant_type', 'refresh_token'],
        ['refresh_token', refreshToken],
        ['client_id', clientId]
    ]);

    return await fetchJSON(url, {
        method: 'POST',
        credentials: 'include',
        body,
    })
}

/**
 * @template [T=unknown]
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<T>}
 */
async function fetchJSON(url, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", CONTENT_TYPE_JSON);

    const response = await fetchWithErrorHandling(url, {
        ...init,
        headers
    });

    return await response.json();
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function fetchWithErrorHandling(url, init) {
    const response = await fetch(url, init);

    if (!response.ok) {
        throw new NetworkError('Server responded with an invalid status.', { response });
    }

    return response;
}

/**
 * @param {string} [token]
 * @returns {[string, string]}
 */
function buildAuthorizationHeader(token) {
    if (!token) {
        throw new Error('Unable to build authorization header, token is not set, make sure the user is authenticated.');
    }

    return ['Authorization', `bearer ${token}`];
}

/**
 * @param {string} url 
 * @returns {string}
 */
function stripTrailingSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * @typedef {Object} NetworkErrorOptionsProperties
 * @property {Response} response
 * @typedef {ErrorOptions & NetworkErrorOptionsProperties} NetworkErrorOptions
 */

export class NetworkError extends Error {
    /** @type {Response} */
    response;

    /**
     * @param {string} message 
     * @param {NetworkErrorOptions} options 
     */
    constructor(message, options) {
        super(message, options);
        this.response = options.response;
    }
}

/**
 * @param {number} delay 
 * @returns {Promise<void>}
 */
const waitForTimeout = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
