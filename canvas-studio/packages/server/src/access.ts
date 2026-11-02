// Who may do what with a file (ТЗ 3.3–3.4): roles, the share link and
// invitations. Pure functions over the file record — the API asks them and
// stores what they return, so the rules are tested without a server.
//
// Roles, from least to most: viewer < commenter < editor < owner.
//   viewer     — open the file and the prototype
//   commenter  — + comments (when comments arrive, part 4)
//   editor     — + edit, rename, change others' access (not the owner's)
//   owner      — + move to a project, delete
//
// The link: "invited" (only the people listed), "team" (people of one team
// who have the link) or "anyone" (whoever has the link). An open link carries
// a random token, may have a password and an expiry. Without an account a
// link gives at most "viewer": editing needs a name behind every change —
// except a board whose owner let guests edit by the link (FEAT-088): a retro
// or a brainstorm people join without signing up; each guest gets an animal's name.
//
// A restricted file sits in a team project, yet the team does not see it:
// only the people listed, team admins and the link give access.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type Role = 'viewer' | 'commenter' | 'editor' | 'owner';
/** Roles that can be given to someone (owner is not given, it is transferred). */
export type GrantRole = Exclude<Role, 'owner'>;

export const GRANT_ROLES: readonly GrantRole[] = ['viewer', 'commenter', 'editor'];
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export function atLeast(role: Role | null, needed: Role): boolean {
  return role !== null && RANK[role] >= RANK[needed];
}

export function higher(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function isGrantRole(value: unknown): value is GrantRole {
  return typeof value === 'string' && (GRANT_ROLES as readonly string[]).includes(value);
}

export interface Member {
  userId: string;
  role: GrantRole;
  addedAt: number;
}

/** An invitation to an address without an account yet; becomes a member after sign-up. */
export interface Invite {
  email: string;
  role: GrantRole;
  createdAt: number;
  expiresAt: number;
}

export type LinkMode = 'invited' | 'team' | 'anyone';
export const LINK_MODES: readonly LinkMode[] = ['invited', 'team', 'anyone'];

export interface ShareLink {
  mode: LinkMode;
  /** For "team": whose people the link opens the file for. */
  teamId?: string;
  role: GrantRole;
  /** Random part of the link; resetting the link makes old copies stop working. */
  token: string;
  /** scrypt hash (as account passwords) or none. */
  passwordHash: string | null;
  expiresAt: number | null;
  /** A board: people without an account may edit by this link too (its role must be "editor"). */
  guests?: boolean;
}

/** The sharing part of a file record. */
export interface Sharing {
  ownerId: string;
  members?: Member[];
  invites?: Invite[];
  link?: ShareLink;
  /** In a team project: the team gives nothing except to its admins. */
  restricted?: boolean;
}

export const INVITE_DAYS = 30;

/** The role a signed-in user has through membership (no link). */
export function memberRole(file: Sharing, userId: string | null): Role | null {
  if (userId === null) return null;
  if (file.ownerId === userId) return 'owner';
  return file.members?.find((m) => m.userId === userId)?.role ?? null;
}

/** Whether the link opens the file for someone outside the list (and so needs a token). */
export function isOpenLink(link: ShareLink | undefined): link is ShareLink {
  return !!link && (link.mode === 'anyone' || (link.mode === 'team' && !!link.teamId));
}

/**
 * What a link presented with a request gives: null — nothing (wrong, reset,
 * expired, invite-only, or a team link and the visitor is not in that team);
 * 'password' — the right link, but the password was not entered yet.
 * `inTeam` tells whether the visitor belongs to the team of a "team" link.
 */
export function linkRole(
  file: Sharing,
  presented: { token: string; grant: string | null } | null,
  visitor: { signedIn: boolean; inTeam?: (teamId: string) => boolean; board?: boolean },
  secret: Uint8Array,
  fileId: string,
  now = Date.now(),
): GrantRole | 'password' | null {
  const link = file.link;
  if (!presented || !isOpenLink(link)) return null;
  if (link.mode === 'team' && !(visitor.signedIn && visitor.inTeam?.(link.teamId!))) return null;
  if (!sameText(presented.token, link.token)) return null;
  if (link.expiresAt !== null && link.expiresAt < now) return null;
  if (link.passwordHash && (!presented.grant || !sameText(presented.grant, linkGrant(secret, fileId, link)))) return 'password';
  // Without an account a link opens the file for viewing only — a board whose owner let guests edit, for editing.
  if (!visitor.signedIn) return visitor.board && link.mode === 'anyone' && link.guests && link.role === 'editor' ? 'editor' : 'viewer';
  return link.role;
}

/**
 * Proof that the password of a link was entered: a keyed hash of the file, the
 * link token and the password hash. Changing the password or resetting the
 * link makes every earlier proof invalid; nothing has to be stored.
 */
export function linkGrant(secret: Uint8Array, fileId: string, link: ShareLink): string {
  return createHmac('sha256', secret).update(`${fileId}\u0000${link.token}\u0000${link.passwordHash ?? ''}`).digest('base64url');
}

/** Parses the X-CS-Link header: "<token>" or "<token>.<grant>". */
export function parseLinkHeader(value: string | string[] | undefined): { token: string; grant: string | null } | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const [token, grant] = value.split('.');
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return { token, grant: grant && /^[A-Za-z0-9_-]{20,64}$/.test(grant) ? grant : null };
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Members and invites without expired invitations. */
export function liveInvites(file: Sharing, now = Date.now()): Invite[] {
  return (file.invites ?? []).filter((i) => i.expiresAt > now);
}

/** Turns invitations for this address into membership (after sign-up or on first visit). */
export function claimInvites<T extends Sharing>(file: T, user: { id: string; email: string }, now = Date.now()): T | null {
  const invite = liveInvites(file, now).find((i) => i.email === user.email);
  if (!invite || file.ownerId === user.id) return null;
  const members = (file.members ?? []).filter((m) => m.userId !== user.id);
  const existing = file.members?.find((m) => m.userId === user.id);
  const role = existing ? (higher(existing.role, invite.role) as GrantRole) : invite.role;
  members.push({ userId: user.id, role, addedAt: now });
  return { ...file, members, invites: (file.invites ?? []).filter((i) => i.email !== user.email && i.expiresAt > now) };
}

export const ROLE_NAMES: Record<Role, string> = {
  owner: 'владелец',
  editor: 'может редактировать',
  commenter: 'может комментировать',
  viewer: 'может смотреть',
};
