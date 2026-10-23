'use strict';

const crypto = require('crypto');

function createBuiltinAcsAuth({ getSetting, parseBooleanSetting, isProduction }) {
  return (req, res, next) => {
    if (!parseBooleanSetting(getSetting('use_builtin_acs', false), false)) {
      return res.status(503).type('text/plain').send('Built-in ACS is disabled');
    }

    const username = String(process.env.BUILTIN_ACS_USERNAME || '');
    const password = String(process.env.BUILTIN_ACS_PASSWORD || '');
    if (!username || !password || username.includes(':')) {
      return res.status(503).type('text/plain').send('Built-in ACS credentials are not configured');
    }
    if (isProduction && !process.env.SETTINGS_MASTER_KEY) {
      return res.status(503).type('text/plain').send('SETTINGS_MASTER_KEY is required for the Built-in ACS');
    }

    if (isProduction && !req.secure) {
      return res.status(400).type('text/plain').send('HTTPS is required for the Built-in ACS');
    }

    const authorization = String(req.get('authorization') || '');
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
    let providedUsername = '';
    let providedPassword = '';
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        providedUsername = decoded.slice(0, separator);
        providedPassword = decoded.slice(separator + 1);
      }
    }
    const safeEqual = (provided, expected) => {
      const providedBuffer = Buffer.from(provided);
      const expectedBuffer = Buffer.from(expected);
      return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    };
    const usernameMatches = safeEqual(providedUsername, username);
    const passwordMatches = safeEqual(providedPassword, password);
    const authorized = Boolean(match) && usernameMatches && passwordMatches;
    if (!authorized) {
      res.set('WWW-Authenticate', 'Basic realm="ZenRadius Built-in ACS", charset="UTF-8"');
      return res.status(401).type('text/plain').send('ACS authentication required');
    }

    next();
  };
}

module.exports = { createBuiltinAcsAuth };
