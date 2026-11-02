// Teams, as in Figma: people working together and their shared projects.
// Every member sees every file in the team's projects with the role the team
// gives them; a file can still be shared with outsiders one by one. Pure
// functions over the team record — the API stores what they return.
//
// Team roles, from least to most: viewer < commenter < editor < admin < owner.
//   viewer, commenter — that role in every team file
//   editor            — + edit every team file, make files and projects
//   admin             — + invite and remove people, rename and delete
//                       projects, move and delete any team file
//   owner             — + rename and delete the team (the one who made it)

import { higher, INVITE_DAYS, type GrantRole, type Role } from './access.ts';

export type TeamRole = 'viewer' | 'commenter' | 'editor' | 'admin';
export const TEAM_ROLES: readonly TeamRole[] = ['viewer', 'commenter', 'editor', 'admin'];
const RANK: Record<TeamRole | 'owner', number> = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export interface TeamMember {
  userId: string;
  role: TeamRole;
  addedAt: number;
}

export interface TeamInvite {
  email: string;
  role: TeamRole;
  createdAt: number;
  expiresAt: number;
  /** Who invited: their name goes into the letter. */
  by: string;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  members: TeamMember[];
  invites: TeamInvite[];
  createdAt: number;
  updatedAt: number;
}

/** The role a person has in a team: 'owner', a member role or none. */
export function teamRole(team: Team, userId: string | null): TeamRole | 'owner' | null {
  if (userId === null) return null;
  if (team.ownerId === userId) return 'owner';
  return team.members.find((m) => m.userId === userId)?.role ?? null;
}

export function teamAtLeast(role: TeamRole | 'owner' | null, needed: TeamRole | 'owner'): boolean {
  return role !== null && RANK[role] >= RANK[needed];
}

/**
 * What a team role gives in each file of the team: admins manage files as
 * their owners do. A restricted file is closed to the rest of the team.
 */
export function fileRoleFromTeam(role: TeamRole | 'owner' | null, restricted = false): Role | null {
  if (role === null) return null;
  if (role === 'owner' || role === 'admin') return 'owner';
  return restricted ? null : (role satisfies GrantRole);
}

/** The higher of a role in the file itself and the one the team gives. */
export function withTeam(fileRole: Role | null, role: TeamRole | 'owner' | null, restricted = false): Role | null {
  return higher(fileRole, fileRoleFromTeam(role, restricted));
}

export function liveTeamInvites(team: Team, now = Date.now()): TeamInvite[] {
  return team.invites.filter((i) => i.expiresAt > now);
}

/** Adds a person with an account, or replaces their role. */
export function addTeamMember(team: Team, userId: string, role: TeamRole, now = Date.now()): Team {
  if (team.ownerId === userId) return team;
  const members = team.members.filter((m) => m.userId !== userId);
  members.push({ userId, role, addedAt: team.members.find((m) => m.userId === userId)?.addedAt ?? now });
  return { ...team, members, updatedAt: now };
}

/** Invites an address without an account yet: it joins after sign-up. */
export function addTeamInvite(team: Team, email: string, role: TeamRole, by: string, now = Date.now()): Team {
  const invites = liveTeamInvites(team, now).filter((i) => i.email !== email);
  invites.push({ email, role, createdAt: now, expiresAt: now + INVITE_DAYS * 86_400_000, by });
  return { ...team, invites, updatedAt: now };
}

/** Turns an invitation for this address into membership; null — nothing to claim. */
export function claimTeamInvite(team: Team, user: { id: string; email: string }, now = Date.now()): Team | null {
  const invite = liveTeamInvites(team, now).find((i) => i.email === user.email);
  if (!invite) return null;
  const rest = { ...team, invites: team.invites.filter((i) => i.email !== user.email && i.expiresAt > now) };
  if (team.ownerId === user.id) return rest;
  const existing = team.members.find((m) => m.userId === user.id);
  const role = existing && RANK[existing.role] > RANK[invite.role] ? existing.role : invite.role;
  return addTeamMember(rest, user.id, role, now);
}
