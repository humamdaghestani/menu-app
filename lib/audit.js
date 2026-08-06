const db = require('../db');

/**
 * Write an audit log entry. Never throws — failures are silent so they
 * can't disrupt the main request flow.
 *
 * @param {object} opts
 * @param {number}  opts.tenantId
 * @param {number}  [opts.userId]
 * @param {string}  [opts.userEmail]
 * @param {string}  opts.action      e.g. 'item.price_change', 'login.success'
 * @param {string}  [opts.entity]    e.g. 'menu_item', 'user', 'purchase'
 * @param {any}     [opts.entityId]
 * @param {object}  [opts.detail]    free-form JSON stored for later reading
 * @param {string}  [opts.ip]
 */
async function log({ tenantId, userId, userEmail, action, entity, entityId, detail, ip } = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (tenant_id,user_id,user_email,action,entity,entity_id,detail,ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenantId  || null,
        userId    || null,
        userEmail || null,
        action,
        entity    || null,
        entityId != null ? String(entityId) : null,
        JSON.stringify(detail || {}),
        ip        || null,
      ]
    );
  } catch { /* silent */ }
}

module.exports = { log };
