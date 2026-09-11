/** Mikhmon On-Login Script Parser (Shared Utility) */

'use strict';

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const s = String(script).trim();

  const putMatch = s.match(/:\s*put\s*\(\s*[",]rem[",]?\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)/i);
  if (putMatch) {
    const cost = String(putMatch[1] || '').trim();
    const validity = String(putMatch[2] || '').trim();
    const priceStr = String(putMatch[3] || '').trim();
    const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;

    if (validity && price > 0) {
      return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
    }
  }

  const shortMatch = s.match(/\$(\d+)\^([\w]+)/i);
  if (shortMatch) {
    const price = Number(shortMatch[1]) || 0;
    const validity = String(shortMatch[2] || '').trim();
    if (price > 0 && validity) {
      return { price, validity, cost: 0 };
    }
  }

  const bareMatch = s.match(/(?:^|[\s,;])(\d{3,})\^([\d]+[dhwm])/i);
  if (bareMatch) {
    const price = Number(bareMatch[1]) || 0;
    const validity = String(bareMatch[2] || '').trim();
    if (price > 0 && validity) {
      return { price, validity, cost: 0 };
    }
  }

  const parts = s.split(',').map(p => String(p).trim());
  let remIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const norm = String(parts[i] || '').toLowerCase().replace(/[^a-z]/g, '');
    if (norm === 'rem') {
      remIdx = i;
      break;
    }
  }

  if (remIdx >= 0 && remIdx + 3 < parts.length) {
    const cost = String(parts[remIdx + 1] || '').trim();
    const validity = String(parts[remIdx + 2] || '').trim();
    const priceStr = String(parts[remIdx + 3] || '').trim();
    const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;

    if (validity && price > 0) {
      return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
    }
  }

  return null;
}

module.exports = { parseMikhmonOnLogin };
