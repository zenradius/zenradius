'use strict';

const { encryptValue, decryptValue } = require('../config/settingsEncryption');

const SENSITIVE_PARAMETER = /(?:password|passphrase|pre.?shared.?key|secret|token|credential)/i;

function protectAcsParams(params) {
  const protectedParams = { ...(params || {}) };
  for (const [name, value] of Object.entries(protectedParams)) {
    if (SENSITIVE_PARAMETER.test(name) && typeof value === 'string' && value && !value.startsWith('enc:')) {
      protectedParams[name] = encryptValue(value);
    }
  }
  return protectedParams;
}

function revealAcsParams(params) {
  const revealedParams = { ...(params || {}) };
  for (const [name, value] of Object.entries(revealedParams)) {
    if (SENSITIVE_PARAMETER.test(name) && typeof value === 'string') {
      revealedParams[name] = decryptValue(value);
    }
  }
  return revealedParams;
}

function parseAcsParams(serialized) {
  try {
    return revealAcsParams(JSON.parse(serialized || '{}'));
  } catch (_) {
    return {};
  }
}

function serializeAcsParams(params) {
  return JSON.stringify(protectAcsParams(params));
}

function transformTaskPayload(value, reveal = false) {
  if (Array.isArray(value)) return value.map(item => transformTaskPayload(item, reveal));
  if (!value || typeof value !== 'object') return value;

  const transformed = {};
  for (const [name, child] of Object.entries(value)) {
    if ((name === 'parameterValues' || name === 'values') && Array.isArray(child)) {
      transformed[name] = child.map(entry => {
        if (!Array.isArray(entry) || entry.length < 2 || !SENSITIVE_PARAMETER.test(String(entry[0] || ''))) {
          return transformTaskPayload(entry, reveal);
        }
        const next = [...entry];
        next[1] = transformSecretValue(next[1], reveal);
        return next;
      });
    } else if (SENSITIVE_PARAMETER.test(name) && typeof child === 'string') {
      transformed[name] = transformSecretValue(child, reveal);
    } else {
      transformed[name] = transformTaskPayload(child, reveal);
    }
  }
  return transformed;
}

function transformSecretValue(value, reveal) {
  if (typeof value !== 'string' || !value) return value;
  if (reveal) return decryptValue(value);
  return value.startsWith('enc:') ? value : encryptValue(value);
}

function parseAcsTaskPayload(serialized) {
  try {
    return transformTaskPayload(JSON.parse(serialized || '{}'), true);
  } catch (_) {
    return {};
  }
}

function serializeAcsTaskPayload(payload) {
  return JSON.stringify(transformTaskPayload(payload || {}, false));
}

function protectAcsSecret(value) {
  const secret = String(value || '');
  return secret && !secret.startsWith('enc:') ? encryptValue(secret) : secret;
}

function revealAcsSecret(value) {
  return decryptValue(String(value || ''));
}

module.exports = {
  parseAcsParams,
  serializeAcsParams,
  parseAcsTaskPayload,
  serializeAcsTaskPayload,
  protectAcsSecret,
  revealAcsSecret,
};
