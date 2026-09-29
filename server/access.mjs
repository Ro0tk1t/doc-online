/**
 * Who may do what to a document.
 *
 * Three roles per document -- `owner`, `editor`, `viewer` -- plus `reader` for the
 * anonymous case, and a visibility flag that decides whether a document is private or open
 * for the world to read. A server admin resolves to `owner` on any document, because the
 * point of an admin is to be able to get a stuck document back.
 *
 * Nothing in here knows about HTTP or files: it is the one place the rules are written down.
 */

export const ROLES = ['owner', 'editor', 'viewer', 'reader'];
const EDIT_ROLES = new Set(['owner', 'editor']);
const MANAGE_ROLES = new Set(['owner']);

export function forbidden(message = 'you do not have access to this document', code = 'forbidden') {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = code;
  return err;
}

/** `viewer` is `{ userId, admin }`, or null for an anonymous request. */
export function roleFor(doc, viewer) {
  if (!doc) return null;
  const anonymous = !viewer || !viewer.userId;
  if (anonymous) return doc.visibility === 'public' ? 'reader' : null;
  if (viewer.admin) return 'owner';
  if (doc.owner && doc.owner === viewer.userId) return 'owner';
  const grant = (doc.grants ?? []).find((entry) => entry.user === viewer.userId);
  if (grant) return grant.role === 'editor' ? 'editor' : 'viewer';
  return doc.visibility === 'public' ? 'reader' : null;
}

export const canEdit = (role) => EDIT_ROLES.has(role);
export const canManage = (role) => MANAGE_ROLES.has(role);
export const canRead = (role) => ROLES.includes(role);

/** Refuse early and with the right status, so every route says the same thing. */
export function requireRole(doc, viewer, verb) {
  const role = roleFor(doc, viewer);
  if (!canRead(role)) {
    throw forbidden(
      doc?.visibility === 'public' ? 'you do not have access to this document' : 'this document is private',
      viewer?.userId ? 'forbidden' : 'need_login',
    );
  }
  if (verb === 'edit' && !canEdit(role)) throw forbidden('this document is read-only for you', 'read_only');
  if (verb === 'manage' && !canManage(role)) throw forbidden('only the owner can change access', 'not_owner');
  return role;
}

/** Validate a share list coming from the API; ids are checked, names are resolved by the caller. */
export function assertGrants(grants, { knownUser = null } = {}) {
  if (grants === undefined || grants === null) return [];
  if (!Array.isArray(grants) || grants.length > 50) {
    const err = new Error('grants must be a list of at most 50 entries');
    err.statusCode = 400;
    throw err;
  }
  const seen = new Set();
  return grants.map((entry) => {
    const user = typeof entry?.user === 'string' ? entry.user : '';
    const role = entry?.role === 'editor' ? 'editor' : entry?.role === 'viewer' ? 'viewer' : null;
    if (!user || !role) {
      const err = new Error('each grant needs a user id and an editor or viewer role');
      err.statusCode = 400;
      throw err;
    }
    if (knownUser && !knownUser(user)) {
      const err = new Error('that user no longer exists');
      err.statusCode = 400;
      throw err;
    }
    if (seen.has(user)) return null;
    seen.add(user);
    return { user, role };
  }).filter(Boolean);
}

export function assertVisibility(visibility) {
  if (visibility === 'public' || visibility === 'private') return visibility;
  const err = new Error("visibility must be 'public' or 'private'");
  err.statusCode = 400;
  throw err;
}

/** The projection a share panel reads: who owns it, who is on the list, and what I may do. */
export function accessOf(doc, viewer) {
  const role = roleFor(doc, viewer);
  return {
    owner: doc.owner ?? null,
    visibility: doc.visibility === 'public' ? 'public' : 'private',
    grants: (doc.grants ?? []).map((entry) => ({ ...entry })),
    role,
    canEdit: canEdit(role),
    canManage: canManage(role),
  };
}

/** Does this document belong in this viewer's list? */
export const visibleTo = (doc, viewer) => canRead(roleFor(doc, viewer));
